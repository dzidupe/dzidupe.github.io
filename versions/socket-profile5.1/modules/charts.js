

(() => {
    const CONFIG = { barInterval: 300, maxBars: 6000, futureBars: 20, emaPeriod: 180, sdPeriod: 1440, cacheTTL: 300000 };
    const PAIRS = ["ADA","AAVE","AVAX","DOGE","DOT","FIL","LINK","MATIC","UNI","XRP","XLM","MKR","SUSHI","COMP","CRV","1INCH","LRC","FET","DYDX","INJ","AXS","GRT","SNX","YFI","BAND","KNC","ENS","CVX","RNDR","AUDIO","NEXO","PEPE","PERP","PYTH","RAD","GODS","CTSI","SKL","FLR"];
    const domCache = new Map();
    const chartStates = new Map();
    window.chartStates = chartStates;
    let currentPair = "BTC";
    window.currentPair = currentPair;
    window.currentActivePair = currentPair;

    // Register cleanup for global references
    window.CleanupManager && window.CleanupManager.registerCleanup && window.CleanupManager.registerCleanup(() => { window.chartStates = null; });
    window.CleanupManager && window.CleanupManager.registerCleanup && window.CleanupManager.registerCleanup(() => { window.currentPair = null; });
    window.CleanupManager && window.CleanupManager.registerCleanup && window.CleanupManager.registerCleanup(() => { window.currentActivePair = null; });

    const utils = {
        normalize: window.mathUtils.normalize,
        computeRollingMinMax: window.mathUtils.computeRollingMinMax,
        ema: window.mathUtils.ema,
        sma: window.mathUtils.sma,
        stdev: window.mathUtils.stdev,
        clamp: window.mathUtils.clamp,
        lerp: window.mathUtils.lerp,
        weightedAverage: window.mathUtils.weightedAverage,
        arrayMinMax: window.mathUtils.arrayMinMax,
        throttle: (fn, limit) => { let t; return (...args) => { if (!t) t = setTimeout(() => { fn(...args); t = null; }, limit); }; },
        debounce: (fn, delay) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); }; },
        formatDollarValue: v => '$' + (window.utils && window.utils.formatLargeNumber ? window.utils.formatLargeNumber(v) : v)
    };

    const handleError = (msg, err, overlay) => { console.error(`${msg}: ${err.message}`); if (overlay) overlay.textContent = `${msg}: ${err.message}`; };

    if (!window.bybitWsManager) window.bybitWsManager = new WebSocketManager("wss://stream.bybit.com/v5/public/linear", "bybit", { reconnectDelay: 5000 });
    const container = document.querySelector(".chart-container");
    if (container) {
        domCache.set("container", container);
        domCache.set("overlay", container.querySelector(".loading-overlay"));
        domCache.set("priceChartContainer", container.querySelector(".price-chart-container"));
        domCache.set("buttons", Array.from(container.querySelectorAll(".pair-button")));
        domCache.set("pairSelector", container.querySelector(".pair-selector"));
        // Example: cleanup for dynamically added event listeners on container
        // (add your dynamic listeners here and register their cleanup)
    }

    if (!window.eventBus) {
        window.eventBus = {
            events: {},
            subscribe: (e, cb) => { window.eventBus.events[e] = window.eventBus.events[e] || []; window.eventBus.events[e].push(cb); return () => window.eventBus.events[e] = window.eventBus.events[e].filter(c => c !== cb); },
            publish: (e, d) => window.eventBus.events[e]?.forEach(cb => { try { cb(d); } catch (err) { console.error(`Error in ${e}:`, err); } })
        };
        PAIRS.forEach(p => {
            const liqHandler = e => e.detail && window.eventBus.publish(`liquidation-${p}`, e.detail);
            const whaleHandler = e => e.detail && window.eventBus.publish(`whale-alert-${p}`, e.detail);
            window.addEventListener(`liquidation-${p}`, liqHandler);
            window.addEventListener(`whale-alert-${p}`, whaleHandler);
            // Register cleanup for these listeners
            if (window.CleanupManager && window.CleanupManager.registerCleanup) {
                window.CleanupManager.registerCleanup(() => window.removeEventListener(`liquidation-${p}`, liqHandler));
                window.CleanupManager.registerCleanup(() => window.removeEventListener(`whale-alert-${p}`, whaleHandler));
            }
        });
    }

    const waitForLightweightCharts = () => new Promise((resolve, reject) => {
        let attempts = 0;
        let timeoutId = null;
        const check = () => {
            if (window.LightweightCharts) {
                resolve();
            } else if (attempts++ < 50) {
                timeoutId = setTimeout(check, 100);
            } else {
                reject(new Error("LightweightCharts failed to load"));
            }
        };
        check();
        // Register cleanup for this timeout
        if (window.CleanupManager && window.CleanupManager.registerCleanup) {
            window.CleanupManager.registerCleanup(() => { if (timeoutId) clearTimeout(timeoutId); });
        }
    });

    // --- IndexedDB wrapper for historical data ---
    const HIST_DB_NAME = 'crypto-dashboard-hist';
    const HIST_DB_VERSION = 1;
    const HIST_STORE = 'bars';
    let histDb = null;
    async function getHistDb() {
        if (histDb) return histDb;
        if (window.IndexedDbWrapper) {
            histDb = new window.IndexedDbWrapper(HIST_DB_NAME, HIST_DB_VERSION, { [HIST_STORE]: { keyPath: 'key' } });
            await histDb.ready;
            return histDb;
        } else {
            throw new Error('IndexedDbWrapper not loaded');
        }
    }

    async function fetchBitstampHistoricalData(pair, interval, limit = 6000, abortSignal) {
        const cacheKey = `${pair}_historical_${interval}_${limit}`;
        let db;
        try {
            db = await getHistDb();
            const cached = await db.get(HIST_STORE, cacheKey);
            if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTL && cached.data.length >= limit * 0.9) {
                return cached.data.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
            }
        } catch (e) {
            // fallback to no cache
        }
        const maxApiLimit = 1000;
        let allBars = [], timeMap = new Map();
        const fetchBars = async (url) => {
            if (abortSignal?.aborted) throw new Error("Fetch aborted");
            const res = await fetch(url, { signal: abortSignal });
            if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
            const data = await res.json();
            if (!data?.data?.ohlc) throw new Error("Invalid Bitstamp data");
            data.data.ohlc.forEach(b => {
                const t = parseInt(b.timestamp, 10);
                if (!timeMap.has(t)) {
                    timeMap.set(t, true);
                    allBars.push({ time: t, open: parseFloat(b.open), high: parseFloat(b.high), low: parseFloat(b.low), close: parseFloat(b.close), volume: parseFloat(b.volume) });
                }
            });
        };
        await fetchBars(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${interval}&limit=${maxApiLimit}`);
        allBars.sort((a, b) => a.time - b.time);
        if (allBars.length > 0) {
            for (let i = 0; i < 3 && allBars.length < limit; i++) {
                allBars.sort((a, b) => a.time - b.time);
                const earliest = allBars[0].time;
                const batchPromises = Array.from({ length: 2 }, (_, j) => {
                    const offset = j === 0 ? 1 : (j * maxApiLimit * interval);
                    return fetchBars(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${interval}&limit=${maxApiLimit}&end=${earliest - offset}`).then(() => allBars.length).catch(() => 0);
                });
                const newBars = await Promise.all(batchPromises);
                if (newBars.reduce((s, c) => s + c, 0) === 0) break;
                if (i < 2) await new Promise(r => setTimeout(r, 100));
            }
        }
        allBars.sort((a, b) => a.time - b.time);
        if (allBars.length > limit) allBars = allBars.slice(-limit);
        try {
            if (db) {
                await db.set(HIST_STORE, { key: cacheKey, timestamp: Date.now(), data: allBars.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) });
            }
        } catch (e) {}
        return allBars;
    }

    async function fetchBybitHistoricalData(pair, interval = CONFIG.barInterval, limit = 6000, onProgress, abortSignal) {
        const cacheKey = `bybit_${pair}_historical_${interval}_${limit}`;
        let db;
        try {
            db = await getHistDb();
            const cached = await db.get(HIST_STORE, cacheKey);
            if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTL && cached.data.length >= limit * 0.9) {
                return cached.data.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
            }
        } catch (e) {
            // fallback to no cache
        }
        const symbol = `${pair}USDT`;
        let allBars = [], timeMap = new Map();

        // Throttle progress callback to avoid excessive UI updates
        const throttle = (fn, limit) => {
            let inThrottle, lastArgs;
            return (...args) => {
                lastArgs = args;
                if (!inThrottle) {
                    fn(...lastArgs);
                    inThrottle = true;
                    setTimeout(() => {
                        inThrottle = false;
                        if (lastArgs !== args) fn(...lastArgs);
                    }, limit);
                }
            };
        };
        const throttledProgress = onProgress ? throttle(onProgress, 200) : null;

        const fetchBars = async (url) => {
            if (abortSignal?.aborted) throw new Error("Fetch aborted");
            const res = await fetch(url, { signal: abortSignal });
            if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
            const data = await res.json();
            let added = 0;
            if (data?.result?.list) data.result.list.forEach(item => {
                const t = Math.floor(parseInt(item[0]) / 1000);
                const nt = Math.floor(t / interval) * interval;
                if (!timeMap.has(nt)) {
                    timeMap.set(nt, true);
                    allBars.push({ time: nt, open: parseFloat(item[1]), high: parseFloat(item[2]), low: parseFloat(item[3]), close: parseFloat(item[4]), volume: parseFloat(item[5]) });
                    added++;
                }
            });
            if (throttledProgress) throttledProgress(allBars.slice());
            return added;
        };

        try {
            // Initial fetch
            await fetchBars(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=5&limit=1000`);
            // Calculate how many more batches are needed
            allBars.sort((a, b) => a.time - b.time);
            let earliest = allBars[0]?.time ? allBars[0].time * 1000 : Date.now();
            const batchCount = Math.ceil((limit - allBars.length) / 1000);
            const batchEndpoints = [];
            for (let i = 0; i < batchCount; i++) {
                const offset = i * 1000 * interval;
                batchEndpoints.push(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=5&limit=1000&end=${earliest - offset}`);
            }
            // Limit concurrency to 6
            const concurrency = 6;
            for (let i = 0; i < batchEndpoints.length; i += concurrency) {
                const chunk = batchEndpoints.slice(i, i + concurrency);
                await Promise.all(chunk.map(url => fetchBars(url).catch(() => 0)));
                allBars.sort((a, b) => a.time - b.time);
                if (allBars.length >= limit) break;
            }
            allBars.sort((a, b) => a.time - b.time);
            const result = allBars.length > limit ? allBars.slice(-limit) : allBars;
            try {
                if (db) {
                    await db.set(HIST_STORE, { key: cacheKey, timestamp: Date.now(), data: result.map(b => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) });
                }
            } catch (e) {}
            return result;
        } catch (e) { return []; }
    }

    const preCalculateDataCache = new Map();
    async function preCalculateData(pair, overlay, progressiveUpdate, abortSignal) {
        const cacheKey = `${pair}_${CONFIG.barInterval}`;
        if (preCalculateDataCache.has(cacheKey)) {
            return preCalculateDataCache.get(cacheKey);
        }
        overlay.textContent = `Fetching ${pair} historical data...`;
        try {
            const fetchTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout fetching data for ${pair}`)), 15000));
            const bitstampPair = `${pair.toLowerCase()}usd`;
            let progressiveBybitBars = [];
            const [rawPriceData, bybitData] = await Promise.all([
                Promise.race([fetchBitstampHistoricalData(bitstampPair, CONFIG.barInterval, undefined, abortSignal), fetchTimeout]),
                Promise.race([
                    fetchBybitHistoricalData(pair, CONFIG.barInterval, CONFIG.maxBars, (bars) => {
                        progressiveBybitBars = bars;
                        overlay.textContent = `Loading ${pair} bars: ${bars.length}/${CONFIG.maxBars}`;
                        if (typeof progressiveUpdate === "function") {
                            progressiveUpdate(bars);
                        }
                    }, abortSignal),
                    fetchTimeout
                ])
            ]);
            // Filter out bars with null/NaN values
            const priceData = (rawPriceData || []).filter(bar =>
                bar &&
                bar.time != null && !isNaN(bar.time) &&
                bar.open != null && !isNaN(bar.open) &&
                bar.high != null && !isNaN(bar.high) &&
                bar.low != null && !isNaN(bar.low) &&
                bar.close != null && !isNaN(bar.close) &&
                bar.volume != null && !isNaN(bar.volume)
            );
            // Also filter bybitData for null/NaN values
            const cleanBybitData = (bybitData || []).filter(bar =>
                bar &&
                bar.time != null && !isNaN(bar.time) &&
                bar.open != null && !isNaN(bar.open) &&
                bar.high != null && !isNaN(bar.high) &&
                bar.low != null && !isNaN(bar.low) &&
                bar.close != null && !isNaN(bar.close) &&
                bar.volume != null && !isNaN(bar.volume)
            );
            if (!priceData.length) return null;
            overlay.textContent = `Calculating ${pair} indicators...`;
            const indicatorResults = window.chartIndicators.calculateAllIndicators(priceData);
            const allTimes = [...new Set([...(cleanBybitData?.map(d => d.time) || []), ...priceData.map(d => d.time)])].sort();
            const bybitMap = new Map(cleanBybitData.map(d => [d.time, d]));
            const bitstampMap = new Map(priceData.map(d => [d.time, d]));
            let lastBybitClose = bybitData[0]?.close || 0;
            let lastBitstampClose = priceData[0]?.close || 0;
            const aligned = allTimes.map(time => {
                const bybit = bybitMap.get(time) || { time, open: lastBybitClose, high: lastBybitClose, low: lastBybitClose, close: lastBybitClose, volume: 0 };
                const bitstamp = bitstampMap.get(time) || { time, open: lastBitstampClose, high: lastBitstampClose, low: lastBitstampClose, close: lastBitstampClose, volume: 0 };
                lastBybitClose = bybit.close;
                lastBitstampClose = bitstamp.close;
                return { time, bybit, bitstamp };
            });
            const alignedBybit = aligned.map(d => d.bybit);
            const alignedBitstamp = aligned.map(d => d.bitstamp);
            const { liqsData, liqsRaw, perpD, spotD } = window.chartIndicators.calculateLiqs(alignedBybit, alignedBitstamp, CONFIG.sdPeriod);
            const openInterestData = alignedBybit.map(b => ({ time: b.time, price: b.close, close: b.close, openInterest: b.volume * 10, priceChange: (b.close - b.open) / b.open, fundingRate: 0, buyFlow: b.volume * 0.6, sellFlow: b.volume * 0.4, hasOrderFlow: true }));
            const result = { priceData, bands: indicatorResults.bands, vwap: indicatorResults.vwap, vwapData: indicatorResults.vwapData, emaBands: indicatorResults.emaBands, caches: indicatorResults.caches, liqsData, liqsRawWindow: liqsRaw.slice(-CONFIG.sdPeriod), sums: { perpSum: perpD[perpD.length - 1].value, spotSum: spotD[spotD.length - 1].value }, alignedBybit, alignedBitstamp, openInterestData, timing: { firstTime: allTimes[0], lastTime: allTimes[allTimes.length - 1] } };
            preCalculateDataCache.set(cacheKey, result);
            return result;
        } catch (e) { handleError(`Error pre-calculating data for ${pair}`, e, overlay); return null; }
    }

    function initializeChartAndMeter(container, data, pair, progressiveLoader) {
        const overlay = domCache.get("overlay");
        overlay.textContent = `Initializing ${pair} chart...`;

        // --- Track if user has manually scrolled away from the latest bar ---
        let userHasScrolled = false;

        // Defensive: Check for valid data before proceeding
        if (!data || !Array.isArray(data.priceData) || !data.priceData.length) {
            overlay.textContent = `Failed to load ${pair} data (no price data)`;
            overlay.style.display = "block";
            console.error(`[initializeChartAndMeter] No price data for ${pair}:`, data);
            return null;
        }
        // Defensive: Check for null/undefined values in priceData
        const hasNulls = data.priceData.some(bar =>
            bar == null ||
            bar.time == null ||
            bar.open == null ||
            bar.high == null ||
            bar.low == null ||
            bar.close == null ||
            bar.volume == null
        );
        if (hasNulls) {
            overlay.textContent = `Failed to load ${pair} data (null values in price data)`;
            overlay.style.display = "block";
            console.error(`[initializeChartAndMeter] Null values in price data for ${pair}:`, data.priceData);
            return null;
        }

        const priceChartContainer = domCache.get("priceChartContainer");
        if (priceChartContainer) priceChartContainer.style.height = "100%";
        const chartConfig = { ...CONFIG, ticker: { symbol: pair, bitstampOrderBook: `order_book_${pair.toLowerCase()}usd`, bitstampTrades: `live_trades_${pair.toLowerCase()}usd`, bybitTrades: `publicTrade.${pair.toUpperCase()}USDT` } };
        const priceChartElement = container.querySelector(".price-chart");
        if (!priceChartElement) {
            overlay.textContent = `Chart container missing for ${pair}`;
            overlay.style.display = "block";
            console.error(`[initializeChartAndMeter] .price-chart element not found for ${pair}`);
            return null;
        }
        let priceChart;
        try {
            priceChart = LightweightCharts.createChart(priceChartElement, {
                autoSize: true, layout: { background: { color: "#0f141a", type: 'solid' }, textColor: "#D3D3D3", fontSize: 10, attributionLogo: false },
                panes: [{}, { height: 150, visible: true }], grid: { vertLines: { visible: false }, horzLines: { visible: false } },
                crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { labelBackgroundColor: '#2A2A2A' }, horzLine: { labelBackgroundColor: '#2A2A2A' } },
                timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2A2A2A", lockVisibleTimeRangeOnResize: true, fixLeftEdge: false, fixRightEdge: false, kineticScroll: { touch: true, mouse: false }, tickMarkFormatter: t => new Date(t * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) },
                rightPriceScale: { borderColor: "#2A2A2A", autoScale: true, entireTextOnly: false }, trackingMode: { exitMode: LightweightCharts.TrackingModeExitMode.OnNextTap },
                handleScale: { axisPressedMouseMove: { time: true, price: true } }, handleScroll: { vertTouchDrag: true, horzTouchDrag: true }
            });
        } catch (err) {
            overlay.textContent = `Chart initialization failed for ${pair}`;
            overlay.style.display = "block";
            console.error(`[initializeChartAndMeter] Chart creation failed for ${pair}:`, err, data);
            return null;
        }
        priceChart.subscribeCrosshairMove(p => { if (!p.point) return; });
        const chartExtras = { watermark: null, upDownMarkers: null };
        if (window.LightweightCharts?.createTextWatermark) {
            const panes = priceChart.panes();
            if (panes?.length > 0) chartExtras.watermark = window.LightweightCharts.createTextWatermark(panes[0], { horzAlign: 'right', vertAlign: 'bottom', lines: [{ text: `${pair.toUpperCase()}USD`, color: 'rgba(255, 255, 255, 0.3)', fontSize: 28, fontStyle: 'bold', fontFamily: 'Arial' }], padding: { right: 28 } });
        }
        const priceSeries = priceChart.addSeries(LightweightCharts.CandlestickSeries, { upColor: "#AAAAAA", downColor: "#AAAAAA", borderColor: "#AAAAAA", wickUpColor: "#AAAAAA", wickDownColor: "#AAAAAA", lastValueVisible: true, priceLineVisible: true, priceLineSource: LightweightCharts.PriceLineSource.LastBar, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
        const effectiveData = data || { priceData: [], bands: { t1: 0, t2: 0, b1: 0, b2: 0, time: 0 }, vwap: { vwapValue: 0, upperBand: 0, lowerBand: 0, upperMidline: 0, lowerMidline: 0 }, emaBands: { ema: 0, upper: 0, lower: 0, time: 0 }, liqsData: [{ time: Math.floor(Date.now() / 1000), value: 0 }], liqsRawWindow: [], sums: { perpSum: 0, spotSum: 0 }, alignedBybit: [], alignedBitstamp: [], timing: { firstTime: Math.floor(Date.now() / 1000), lastTime: Math.floor(Date.now() / 1000) } };
        const createPriceLine = (price, title) => {
            if (price == null || isNaN(price)) {
                console.warn(`[initializeChartAndMeter] Skipping price line for ${title} due to null/NaN price:`, price);
                return null;
            }
            return priceSeries.createPriceLine({ price, color: "#555555", lineWidth: 1, title });
        };
        const priceLines = { b2Upper: createPriceLine(effectiveData.bands.t2, "2σMR"), b1Upper: createPriceLine(effectiveData.bands.t1, "1σMR"), b1Lower: createPriceLine(effectiveData.bands.b1, "1σMR"), b2Lower: createPriceLine(effectiveData.bands.b2, "2σMR"), stdPlus2: createPriceLine(effectiveData.vwap.upperBand, "std+2"), stdPlus1: createPriceLine(effectiveData.vwap.upperMidline, "std+1"), vwap: createPriceLine(effectiveData.vwap.vwapValue, "vwap"), stdMinus1: createPriceLine(effectiveData.vwap.lowerMidline, "std-1"), stdMinus2: createPriceLine(effectiveData.vwap.lowerBand, "std-2") };
        try {
            priceSeries.setData(effectiveData.priceData);
        } catch (err) {
            overlay.textContent = `Failed to set chart data for ${pair}`;
            overlay.style.display = "block";
            console.error(`[initializeChartAndMeter] setData failed for ${pair}:`, err, effectiveData.priceData);
            return null;
        }
        if (window.LightweightCharts?.createUpDownMarkers) {
            const markerSeries = priceChart.addSeries(LightweightCharts.LineSeries, { lineWidth: 0, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible: false, title: '' });
            markerSeries.setData(effectiveData.priceData.map(b => ({ time: b.time, value: b.close })));
            chartExtras.upDownMarkers = window.LightweightCharts.createUpDownMarkers(markerSeries, { threshold: 0.005, upColor: 'rgba(0, 255, 255, 0.7)', downColor: 'rgba(255, 85, 85, 0.7)', size: 0.5 });
            chartExtras.markerSeries = markerSeries;
        }
        // Progressive loader support: update chart as Bybit bars load
        if (typeof progressiveLoader === "function") {
            progressiveLoader(priceSeries);
        }
        const fullRange = effectiveData.timing.lastTime + CONFIG.barInterval * CONFIG.futureBars - effectiveData.timing.firstTime;
        const halfRange = fullRange / 2;
        const midPoint = effectiveData.timing.lastTime - halfRange / 2;
        priceChart.timeScale().setVisibleRange({ from: midPoint - halfRange / 2, to: midPoint + halfRange / 2 });
        // --- CVD Indicator (Spot) ---
        const cvdComponents = window.cvdModule.createCVDChart(container, priceChart);
        priceChart.applyOptions({ layout: { background: { color: "rgba(15, 20, 26, 1.0)", type: 'solid' } } });
        const syncResources = window.cvdModule.synchronizeCharts(cvdComponents, priceChart);
        cvdComponents.syncResources = syncResources;
        window.cvdModule.initializeCVDData(cvdComponents, effectiveData.priceData);
        window.cvdModule.setupCVDUpdateInterval(cvdComponents);

        // --- Bybit Perp CVD Indicator ---
        const perpCvdComponents = window.perpCvdModule.createCVDChart(container, priceChart);
        const perpSyncResources = window.perpCvdModule.synchronizeCharts(perpCvdComponents, priceChart);
        perpCvdComponents.syncResources = perpSyncResources;
        window.perpCvdModule.initializeCVDData(perpCvdComponents, effectiveData.alignedBybit);
        window.perpCvdModule.setupCVDUpdateInterval(perpCvdComponents);

        // --- USD Premium Indicator REMOVED ---
        // All USD Premium logic and chart rendering removed

        let perpImbalanceComponents = null;
        if (window.perpImbalance?.createPerpImbalanceIndicator) {
            perpImbalanceComponents = window.perpImbalance.createPerpImbalanceIndicator(priceChart);
            window.perpImbalance.initializeImbalanceData(perpImbalanceComponents, effectiveData.alignedBitstamp, effectiveData.alignedBybit, effectiveData.openInterestData || null);
            const syncResources = window.perpImbalance.synchronizeCharts(perpImbalanceComponents, priceChart);
            perpImbalanceComponents.syncResources = syncResources;
            window.perpImbalance.setupPerpUpdateInterval?.(perpImbalanceComponents);
        }
        requestAnimationFrame(() => {
            priceChart.timeScale().fitContent();
            if (isFinite(midPoint) && isFinite(halfRange)) priceChart.timeScale().setVisibleRange({ from: midPoint - halfRange / 2, to: midPoint + halfRange / 2 });
            setTimeout(() => {
                // Removed redundant zeroLine update for CVD
            //     if (cvdComponents?.syncResources && cvdComponents.zeroLine) {
            //         const vr = priceChart.timeScale().getVisibleRange();
            //         if (vr?.from && vr?.to) cvdComponents.zeroLine.setData([{ time: vr.from, value: 0 }, { time: vr.to, value: 0 }]);
            //     }
            }, 100);
        });

        // --- Listen for manual scroll events to disable auto-scroll ---
        priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            // If the right edge is not at the latest bar, user has scrolled away
            const logicalRange = priceChart.timeScale().getVisibleLogicalRange();
            const bars = state?.data?.priceData || [];
            if (logicalRange && bars.length > 0) {
                const lastBarTime = bars[bars.length - 1].time;
                // If the right edge is more than 1 bar away from the latest, consider user has scrolled
                if (logicalRange.to < lastBarTime - 0.5) {
                    userHasScrolled = true;
                } else {
                    userHasScrolled = false;
                }
            }
        });
        const state = {
            chart: { priceChart, priceSeries, cvdComponents, perpCvdComponents, perpImbalanceComponents, priceLines, extras: chartExtras },
            config: chartConfig,
            data: { priceData: effectiveData.priceData, alignedBybit: effectiveData.alignedBybit, alignedBitstamp: effectiveData.alignedBitstamp, openInterestData: effectiveData.openInterestData || [], orderBook: { bids: [], asks: [] }, liquidationsData: [] },
            caches: effectiveData.caches || { twapCache: { priceVolume: 0, totalVolume: 0, value: 0 }, vwapCache: { priceVolume: 0, totalVolume: 0, anchor: null }, stdDevCache: {}, vwapActive: false },
            sums: effectiveData.sums || { perpSum: 0, spotSum: 0 },
            liqs: { liqsRawWindow: effectiveData.liqsRawWindow || [] },
            timing: { firstTime: effectiveData.timing.firstTime, lastTime: effectiveData.timing.lastTime, lastPriceUpdateTime: effectiveData.timing.lastTime },
            currentBars: {
                currentBarBitstamp: effectiveData.priceData[effectiveData.priceData.length - 1] ? { ...effectiveData.priceData[effectiveData.priceData.length - 1] } : { time: Math.floor(Date.now() / 1000 / CONFIG.barInterval) * CONFIG.barInterval, open: null, high: null, low: null, close: null, volume: 0 },
                currentBarBybit: effectiveData.alignedBybit[effectiveData.alignedBybit.length - 1] ? { ...effectiveData.alignedBybit[effectiveData.alignedBybit.length - 1] } : { time: Math.floor(Date.now() / 1000 / CONFIG.barInterval) * CONFIG.barInterval, open: null, high: null, low: null, close: null, volume: 0 }
            },
            chartExtras,
            readiness: { isBitstampReady: false, isBybitReady: false },
            isActive: true,
            throttledFunctions: {
                throttledPriceUpdate: bar => {
                    if (!state.isActive || !bar || !bar.time || bar.close === undefined) return;
                    const lastBar = state.data.priceData[state.data.priceData.length - 1];
                    if (!lastBar || bar.time >= lastBar.time) {
                        if (!lastBar || bar.time > lastBar.time) {
                            state.data.priceData.push(bar);
                            if (state.data.priceData.length > CONFIG.maxBars) state.data.priceData.shift();
                            requestAnimationFrame(() => {
                                priceSeries.update(bar);
                                if (state.chart.extras?.markerSeries) state.chart.extras.markerSeries.update({ time: bar.time, value: bar.close });
                                let prevBar = state.data.priceData[state.data.priceData.length - 2] || state.data.priceData.find(b => b.close !== undefined && !isNaN(b.close));
                                let lastCvdValue = state.chart.cvdComponents?.series?.dataByIndex?.()?.slice(-1)[0]?.value || 0;
                                window.cvdModule?.updateCVD?.(state.chart.cvdComponents, bar, prevBar, lastCvdValue);

                                // Bybit Perp CVD update
                                let bybitBar = state.data.alignedBybit.find(b => b.time === bar.time);
                                let prevBybitBarIdx = state.data.alignedBybit.findIndex(b => b.time === bar.time) - 1;
                                let prevBybitBar = prevBybitBarIdx >= 0 ? state.data.alignedBybit[prevBybitBarIdx] : undefined;
                                let lastPerpCvdValue = state.chart.perpCvdComponents?.series?.dataByIndex?.()?.slice(-1)[0]?.value || 0;
                                if (bybitBar) {
                                    window.perpCvdModule?.updateCVD?.(state.chart.perpCvdComponents, bybitBar, prevBybitBar, lastPerpCvdValue);
                                }

                                // USD Premium update logic removed

                                if (window.perpImbalance?.updateImbalance && state.chart.perpImbalanceComponents) {
                                    const spotBar = bar;
                                    let futuresBar = state.currentBars.currentBarBybit.time === bar.time ? state.currentBars.currentBarBybit : state.data.alignedBybit.find(b => b.time === bar.time);
                                    let oiBar = state.data.openInterestData?.find(b => b.time === bar.time) || null;
                                    if (spotBar && futuresBar) window.perpImbalance.updateImbalance(state.chart.perpImbalanceComponents, spotBar, futuresBar, oiBar);
                                }
                                if (state.liquidationManager?.checkForCandleClose) {
                                    state.liquidationManager.checkForCandleClose(bar.time * 1000);
                                    window.cvdModule?.renderPendingCVDUpdates?.(state.chart.cvdComponents);
                                    window.perpCvdModule?.renderPendingCVDUpdates?.(state.chart.perpCvdComponents);
                                    window.perpImbalance?.renderPendingUpdates?.(state.chart.perpImbalanceComponents);
                                }
                                window.profileManager?.updateAllProfiles?.(state) || (() => { state.volumeProfile?.update?.(); state.fundingProfile?.update?.(); state.openInterestProfile?.update?.(); })();

                                // --- Prevent auto-scroll if user has scrolled away ---
                                if (!userHasScrolled) {
                                    // Optionally, you could call priceChart.timeScale().scrollToRealTime();
                                    // But by default, do nothing so chart stays where user left it
                                }
                            });
                            if (Math.random() < 0.1) memoryManagement.cleanupHistoricalData(state);
                        }
                    }
                },
                throttledCloseUpdate: bar => {
                    if (!state.isActive || !bar || !bar.time || bar.close === undefined) return;
                    const lastBar = state.data.priceData[state.data.priceData.length - 1];
                    if (lastBar && bar.time === lastBar.time) {
                        lastBar.close = bar.close;
                        requestAnimationFrame(() => {
                            priceSeries.update(lastBar);
                            if (state.chart.extras?.markerSeries) state.chart.extras.markerSeries.update({ time: bar.time, value: bar.close });
                            if (state.liquidationManager?.checkForCandleClose) {
                                state.liquidationManager.checkForCandleClose(Date.now());
                                window.cvdModule?.renderPendingCVDUpdates?.(state.chart.cvdComponents);
                                window.perpCvdModule?.renderPendingCVDUpdates?.(state.chart.perpCvdComponents);
                            }
                            if (state.config.ticker.symbol === currentPair) document.title = `${state.config.ticker.symbol} $${bar.close.toFixed(2)} | Crypto Dashboard`;
                        });
                    }
                },
                updateOrderBook: state => chartOrderbook?.updateOrderBookLines?.(state),
                throttledMeterUpdate: utils.throttle(() => {}, 200),
                updateEMABands: () => {
                    if (!state.isActive || !state.data.priceData.length || !window.chartIndicators?.calculateEMABands) return;
                    const emaBands = window.chartIndicators.calculateEMABands(state.data.priceData);
                    state.data.emaBands = emaBands;
                    if (state.chart.priceLines.ema) {
                        state.chart.priceLines.ema.applyOptions({ price: emaBands.ema });
                        state.chart.priceLines.emaUpper.applyOptions({ price: emaBands.upper });
                        state.chart.priceLines.emaLower.applyOptions({ price: emaBands.lower });
                    }
                }
            },
            largeOrderLines: []
        };
        // Initialize stub liquidation manager for compatibility
        state.liquidationManager = {
            addLiquidation: () => {},
            isActiveFn: () => false,
            checkForCandleClose: () => {},
            cleanup: () => {},
            destroy: () => {},
            processLiquidation: () => {},
            dollarThreshold: localStorage.getItem("liquidationThreshold") ? parseFloat(localStorage.getItem("liquidationThreshold")) : 100000
        };
        // Initialize stub whale alert manager for compatibility
        state.whaleAlertManager = {
            addWhaleAlert: () => {},
            isActiveFn: () => false,
            checkForCandleClose: () => {},
            cleanup: () => {},
            destroy: () => {},
            dollarThreshold: localStorage.getItem("whaleAlertThreshold") ? parseFloat(localStorage.getItem("whaleAlertThreshold")) : 100000
        };
        state.chartContainer = container.querySelector(".price-chart");
        window.profileManager?.initializeProfiles?.(state) || (() => {
            const savedVPLines = localStorage.getItem("volumeProfileLines");
            const defaultVPLines = savedVPLines ? parseInt(savedVPLines) : 150;
            const profileConfig = { priceRange: defaultVPLines, position: 0.1, alignLeft: true, liquidationConsoleWidth: 85, colors: { bullish: "rgba(192, 192, 192, 0.7)", bearish: "rgba(64, 64, 64, 0.7)", median: "rgba(255, 255, 255, 0.8)" }, visible: true, liveUpdate: true, maxBars: 6000 };
            if (window.liquidationsProfileManager?.initialize) state.liquidationsProfile = window.liquidationsProfileManager.initialize(state, { ...profileConfig, barWidth: 1.0, showMedian: false });
            if (window.openInterestProfileManager?.initialize) state.openInterestProfile = window.openInterestProfileManager.initialize(state, { ...profileConfig, barWidth: 0.8, showMedian: false });
            if (window.volumeProfileManager?.initialize) state.volumeProfile = window.volumeProfileManager.initialize(state, { ...profileConfig, barWidth: 0.8, showMedian: true });
        })();
        [100, 500, 1000, 2000, 3000].forEach(d => setTimeout(() => {
            const lc = document.getElementById('liquidation-console');
            if (lc) lc.style.cssText = 'display: block; visibility: visible; opacity: 1';
            window.profileManager?.updateAllProfiles?.(state) || (() => { state.volumeProfile?.update?.(); state.liquidationsProfile?.update?.(); state.openInterestProfile?.update?.(); })();
            window.updateSize();
        }, d));
        if (perpImbalanceComponents) {
            state.chart.perpImbalanceComponents = perpImbalanceComponents;
            window.perpImbalance?.disableCrosshairMarkers?.(perpImbalanceComponents);
        }
        overlay.style.display = "none";
        return state;
    }

    const messageQueue = { add: (source, data) => { const state = chartStates.get(currentPair); if (state) handleWebSocketMessage(data, source, state); } };

    function handleWebSocketMessage(message, source, chartState) {
        if (!chartState?.config?.ticker) return;
        const pair = chartState.config.ticker.symbol;
        try {
            if (source === "bybit" && message.topic?.startsWith("publicTrade.") && message.data) {
                // Bybit trade stream integration for net flow indicator
                const trades = Array.isArray(message.data) ? message.data : [message.data];
                trades.forEach(trade => {
                    // Bybit v5 publicTrade: { T: timestamp, s: symbol, S: side, v: size, p: price, ... }
                    if (trade && trade.S && trade.p && trade.v) {
                        window.addBybitTrade({
                            side: trade.S,
                            price: parseFloat(trade.p),
                            size: parseFloat(trade.v)
                        });
                    }
                });
            }
            if (source === "bybit" && message.topic?.startsWith("liquidation.") && message.data) {
                if (!window.bybitWsManager?.isConnected()) {
                    console.warn('Received Bybit message but connection is not healthy');
                    return;
                }

                const liquidations = Array.isArray(message.data) ? message.data : [message.data];
                liquidations.forEach(liq => {
                    try {
                        const price = parseFloat(liq.price);
                        const amount = parseFloat(liq.size || liq.qty);
                        const side = liq.side?.toLowerCase();
                        const value = price * amount;

                        if (!side || !isFinite(price) || !isFinite(amount)) {
                            console.warn('Invalid liquidation data:', liq);
                            return;
                        }

                        // Clean console output with essential liquidation info
                        console.log(
                            `${side === 'buy' ? 'LONG LIQUIDATION:' : 'SHORT LIQUIDATION:'} $${value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} @ ${price.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 2})} | ${pair}`
                        );

                        // Lightweight event dispatch for other systems
                        if (window.liqEventCallback) {
                            window.liqEventCallback({
                                pair: pair,
                                price: price,
                                size: amount,
                                side: side,
                                value: value,
                                timestamp: new Date().toISOString()
                            });
                        }

                    } catch (e) {
                        console.error('Error processing liquidation:', e, liq);
                    }
                });
            }
            if (source === "bitstamp") {
                if (message.channel === `live_trades_${pair.toLowerCase()}usd` && message.data) {
                    const price = parseFloat(message.data.price);
                    const volume = parseFloat(message.data.amount);
                    const type = message.data.type;
                    if (Number.isFinite(price) && Number.isFinite(volume)) {
                        document.title = `${pair} $${price.toFixed(2)} | Crypto Dashboard`;
                        directUpdatePriceData(chartState, price, volume, type);
                    }
                }
                if (message.channel === `order_book_${pair.toLowerCase()}usd` && message.data?.bids && message.data?.asks && chartState.data?.orderBook) {
                    chartState.data.orderBook.bids = message.data.bids.map(([p, v]) => [parseFloat(p), parseFloat(v)]);
                    chartState.data.orderBook.asks = message.data.asks.map(([p, v]) => [parseFloat(p), parseFloat(v)]);
                    if (chartOrderbook?.updateOrderBookLines) chartOrderbook.updateOrderBookLines(chartState);
                    else console.warn("chartOrderbook is not defined, skipping order book update");
                }
            } else if (source === "bybit" && message.topic?.startsWith("liquidation.") && chartState.liquidationManager && message.data) {
                const liquidations = Array.isArray(message.data) ? message.data : [message.data];
                liquidations.forEach(liq => {
                    const time = parseInt(liq.time) / 1000;
                    const price = parseFloat(liq.price);
                    const amount = parseFloat(liq.size || liq.qty);
                    const side = liq.side.toLowerCase();

                    if (chartState.data.liquidationsData) {
                        chartState.data.liquidationsData.push({ time: Math.floor(Date.now() / 1000), price, amount, side });
                        if (chartState.data.liquidationsData.length > chartState.config.maxBars) chartState.data.liquidationsData = chartState.data.liquidationsData.slice(-chartState.config.maxBars);
                        chartState.liquidationsProfile?.update?.();
                    }
                    const type = liq.side.toLowerCase() === "buy" ? 0 : 1;
                    const signedVolume = type === 0 ? parseFloat(liq.size || liq.qty) : -parseFloat(liq.size || liq.qty);
                    if (!chartState.metrics) chartState.metrics = { buyVolume: 0, sellVolume: 0, buyValue: 0, sellValue: 0, liquidations: 0, liquidationsMin: 0, liquidationsMax: 0, spotPressure: 0 };
                    chartState.metrics.liquidations += signedVolume;
                    chartState.metrics.liquidationsMin = Math.min(chartState.metrics.liquidationsMin, chartState.metrics.liquidations);
                    chartState.metrics.liquidationsMax = Math.max(chartState.metrics.liquidationsMax, chartState.metrics.liquidations);
                    chartState.throttledFunctions.updateMetrics?.();
                });
            }
            const now2 = new Date();
            if (now2.getUTCDay() === 1 && now2.getUTCHours() === 13 && now2.getUTCMinutes() === 30 && !chartState._nySessionRefreshed) {
                chartState._nySessionRefreshed = true;
                requestAnimationFrame(() => {
                    if (chartState.isActive && chartState.data.priceData.length) {
                        const vwapResults = window.chartIndicators.calculateAllIndicators(chartState.data.priceData);
                        chartState.data.vwap = vwapResults.vwap;
                        chartState.data.vwapData = vwapResults.vwapData;
                        chartState.caches = vwapResults.caches;
                        if (chartState.chart.priceLines.vwap) chartState.chart.priceLines.vwap.applyOptions({ price: vwapResults.vwap.vwapValue });
                        if (chartState.chart.priceLines.stdPlus2) chartState.chart.priceLines.stdPlus2.applyOptions({ price: vwapResults.vwap.upperBand });
                        if (chartState.chart.priceLines.stdMinus2) chartState.chart.priceLines.stdMinus2.applyOptions({ price: vwapResults.vwap.lowerBand });
                        if (chartState.chart.priceLines.stdPlus1) chartState.chart.priceLines.stdPlus1.applyOptions({ price: vwapResults.vwap.upperMidline });
                        if (chartState.chart.priceLines.stdMinus1) chartState.chart.priceLines.stdMinus1.applyOptions({ price: vwapResults.vwap.lowerMidline });
                    }
                });
                setTimeout(() => chartState._nySessionRefreshed = false, (24 - now2.getUTCDay()) * 3600000);
            }
        } catch (e) { handleError(`WebSocket handler error (${source})`, e); }
    }

    function subscribePair(pair) {
        const state = chartStates.get(pair);
        if (state?.isSubscribed) return;
        const lp = pair.toLowerCase();
        const channels = [
            { m: window.bitstampWsManager, c: `order_book_${lp}usd`, h: d => messageQueue.add("bitstamp", d) },
            { m: window.bitstampWsManager, c: `live_trades_${lp}usd`, h: d => messageQueue.add("bitstamp", d) },
            { m: window.bybitWsManager, c: `liquidation.${pair.toUpperCase()}USDT`, h: d => {
                if (!d?.data) return;
                const liqs = Array.isArray(d.data) ? d.data : [d.data];
                liqs.forEach(l => {
                    if (!l?.price || !l.side) return;
                    const p = parseFloat(l.price);
                    const a = parseFloat(l.size || l.qty || 0);
                    const s = l.side.toLowerCase();
                    if (isFinite(p) && isFinite(a) && a > 0) window.eventBus.publish(`liquidation-${pair}`, { price: p, amount: a, side: s, timestamp: Math.floor(Date.now() / 1000) });
                });
            }},
            { m: window.bybitWsManager, c: `publicTrade.${pair.toUpperCase()}USDT`, h: d => {
                // Forward Bybit public trades to messageQueue for net flow indicator
                messageQueue.add("bybit", d);
            }}
        ];
        channels.forEach(({ m, c, h }) => m?.subscribe(c, d => { const s = chartStates.get(currentPair); if (s && s.isActive && pair === currentPair) h(d); }));
        if (state) state.isSubscribed = true;
    }

    function unsubscribePair(pair) {
        if (!pair) return;
        const lp = pair.toLowerCase();
        ['order_book_', 'live_trades_'].forEach(p => window.bitstampWsManager?.unsubscribe(`${p}${lp}usd`));
        const state = chartStates.get(pair);
        if (state) {
            state.isSubscribed = false;
            state.currentLines = [];
            setTimeout(() => { if (chartOrderbook?.clearOrderBookLines && state.chart?.priceSeries && !state.chart.priceSeries._internal_isDisposed) chartOrderbook.clearOrderBookLines(state); }, 100);
        }
    }

    const memoryManagement = {
        cleanupInterval: 60000,
        lastCleanup: Date.now(),
        cleanupHistoricalData: state => {
            if (!state?.data || Date.now() - memoryManagement.lastCleanup < memoryManagement.cleanupInterval) return;
            memoryManagement.lastCleanup = Date.now();
            const maxBars = CONFIG.maxBars;
            [state.data.priceData, state.data.alignedBybit, state.data.alignedBitstamp].forEach(a => { if (a?.length > maxBars) a.splice(0, a.length - maxBars); });
            state.oldData = null;
            if (window.gc) window.gc();
        }
    };

    window.updateSize = () => {
        const state = chartStates.get(currentPair);
        if (!state || !state.chart) return;
        const container = domCache.get("container");
        if (container) {
            requestAnimationFrame(() => {
                const { clientWidth: w, clientHeight: h } = container;
                if (w > 0 && h > 0) {
                    state.chart.priceChart?.resize(w, h);
                    window.cvdModule?.resizeCVDChart?.(state.chart.cvdComponents, w, h);
                    window.perpCvdModule?.resizeCVDChart?.(state.chart.perpCvdComponents, w, h);
                    window.perpImbalance?.resizeIndicator?.(state.chart.perpImbalanceComponents, w, h);
                    state.chart.priceChart?.timeScale()?.fitContent?.();
                }
                state.volumeProfile?.update?.();
                state.liquidationsProfile?.update?.();
                state.openInterestProfile?.update?.();
            });
        }
    };

    let isInitializing = false;
    async function initializeChart() {
        if (isInitializing) return;
        isInitializing = true;
        try {
            const container = domCache.get("container");
            if (!container) throw new Error("Container not found");
            const overlay = domCache.get("overlay");
            const data = await preCalculateData("BTC", overlay);
            if (!data) throw new Error("No data for BTC");
            const state = initializeChartAndMeter(container, data, "BTC");
            chartStates.set("BTC", state);
            container.dataset.pair = "BTC";
            subscribePair("BTC");
        } catch (e) { handleError("Error initializing chart", e, domCache.get("overlay")); } finally { isInitializing = false; }
    }

    (async () => {
        await waitForLightweightCharts();
        await initializeChart();
        setTimeout(initSettingsButton, 1000);
    })().catch(e => handleError("Error in charts.js", e, domCache.get("overlay")));

    let switchInProgress = false;
    let lastSwitchAbortController = null;
    async function switchPairInternal(newPair) {
        if (newPair === currentPair || switchInProgress) return;
        switchInProgress = true;
        // Abort any in-progress fetches or async operations from previous switch
        if (lastSwitchAbortController) {
            lastSwitchAbortController.abort();
        }
        const abortController = new AbortController();
        lastSwitchAbortController = abortController;
        const overlay = domCache.get("overlay");

        // Store current UI state
        const previousButtonStates = new Map();
        document.querySelectorAll('.pair-button, .popup-timeframe-btn').forEach(btn => {
            previousButtonStates.set(btn.id || btn.dataset.pair || btn.dataset.interval, {
                isActive: btn.classList.contains('active'),
                element: btn
            });
        });

        // Show overlay immediately and keep it visible until all is ready
        overlay.style.display = "block";
        overlay.textContent = `Loading ${newPair} data...`;

        // Timeout fallback in case something hangs
        const timeout = setTimeout(() => {
            switchInProgress = false;
            if (overlay) { overlay.textContent = `Switch to ${newPair} timed out`; setTimeout(() => overlay.style.display = "none", 3000); }
            if (abortController) abortController.abort();
        }, 20000);

        const container = domCache.get("container");
        window.currentActivePair = newPair;
        window.updateActiveButtonState?.(newPair);
        window.clearChartConsole?.();
        window.directConsole?.clear?.();
        // First cleanup high-level resources
        // Async cleanup for all chart states and resources
        await Promise.all(Array.from(chartStates.entries()).map(async ([pair, state]) => {
            try {
                state.isActive = false;
                unsubscribePair(pair);  // Unsubscribe from websockets first

                // Stop any pending updates
                state.throttledFunctions = {};

                // Cleanup managers first
                await Promise.resolve(state.liquidationManager?.destroy?.());
                await Promise.resolve(state.whaleAlertManager?.destroy?.());
                await Promise.resolve(state.chart?.markerManager?.clearMarkers?.());
                await Promise.resolve(
                    window.profileManager?.cleanupAllProfiles?.(state) ||
                    (() => {
                        state.volumeProfile?.cleanup?.();
                        state.volumeProfile?.destroy?.();
                        state.liquidationsProfile?.cleanup?.();
                        state.liquidationsProfile?.destroy?.();
                        state.openInterestProfile?.cleanup?.();
                        state.openInterestProfile?.destroy?.();
                    })()
                );

                // Cleanup chart-specific components
                if (state.chart?.extras?.markerSeries && !state.chart.extras.markerSeries._internal_isDisposed) {
                    try {
                        state.chart.priceChart?.removeSeries(state.chart.extras.markerSeries);
                        state.chart.extras.markerSeries = null;
                    } catch (e) { console.warn('Error cleaning up marker series:', e); }
                }

                if (state.chart?.cvdComponents) {
                    try {
                        await Promise.resolve(window.cvdModule?.cleanupCVD?.(state.chart.cvdComponents, state.chart.cvdComponents?.syncResources));
                        state.chart.cvdComponents = null;
                    } catch (e) { console.warn('Error cleaning up CVD:', e); }
                }
                if (state.chart?.perpCvdComponents) {
                    try {
                        await Promise.resolve(window.perpCvdModule?.cleanupCVD?.(state.chart.perpCvdComponents, state.chart.perpCvdComponents?.syncResources));
                        state.chart.perpCvdComponents = null;
                    } catch (e) { console.warn('Error cleaning up Perp CVD:', e); }
                }

                if (state.chart?.perpImbalanceComponents) {
                    try {
                        await Promise.resolve(window.perpImbalance?.cleanupIndicator?.(state.chart.perpImbalanceComponents));
                        state.chart.perpImbalanceComponents = null;
                    } catch (e) { console.warn('Error cleaning up perp imbalance:', e); }
                }

                // Cleanup price series
                if (state.chart?.priceSeries && !state.chart.priceSeries._internal_isDisposed) {
                    try {
                        Object.values(state.chart.priceLines || {}).forEach(line => {
                            try { line.remove(); } catch (e) {}
                        });
                        state.chart.priceChart?.removeSeries(state.chart.priceSeries);
                    } catch (e) { console.warn('Error cleaning up price series:', e); }
                }

                // Finally remove the chart
                if (state.chart?.priceChart && !state.chart.priceChart._internal_isDisposed) {
                    try {
                        state.chart.priceChart.remove();
                        state.chart.priceChart = null;
                    } catch (e) { console.warn('Error removing chart:', e); }
                }
            } catch (cleanupError) {
                console.error("Error during async chart cleanup:", cleanupError);
            }
        }));

        // Restore active button states
        const activeButtons = Array.from(document.querySelectorAll('.pair-button, .popup-timeframe-btn')).filter(btn =>
            btn.id === `${newPair}-button` ||
            (btn.dataset.pair === newPair) ||
            (btn.dataset.interval === (window.currentPopupChartInterval || '60'))
        );
        activeButtons.forEach(btn => btn.classList.add('active'));

        // Clear all references
        chartStates.clear();

        // Carefully remove only chart-specific DOM elements while preserving layout structure
        const chartContainer = container.querySelector('.price-chart');
        if (chartContainer) {
            // Store button container and parent structure to preserve layout
            const buttonContainer = document.querySelector('.pair-selector');
            const topLevelControls = document.querySelector('.liq-controls');

            // Only remove chart canvases and lightweight chart elements within the chart container
            const chartElements = chartContainer.querySelectorAll('.tv-lightweight-charts, canvas, .pane-separator, .time-scale-box');
            chartElements.forEach(e => {
                try { e.remove(); } catch (err) { console.warn('Error removing chart element:', err); }
            });

            // Remove and re-attach Bybit Net Flow UI if present
            const netFlowDiv = document.getElementById('bybit-net-flow-window');
            if (netFlowDiv && netFlowDiv.parentElement) {
                netFlowDiv.parentElement.removeChild(netFlowDiv);
            }

            // Ensure button container remains in its original position
            if (buttonContainer && buttonContainer.parentElement) {
                buttonContainer.parentElement.insertBefore(buttonContainer, buttonContainer.parentElement.firstChild);
            }

            // Restore top-level controls if they exist
            if (topLevelControls && container.querySelector('.price-chart-container')) {
                container.querySelector('.price-chart-container').appendChild(topLevelControls);
            }
        }

        const priceChartContainer = document.querySelector('.price-chart-container');
        if (priceChartContainer) {
            // Store existing control elements
            const existingControls = {
                console: document.getElementById('liquidation-console'),
                settings: document.querySelector('.liq-controls'),
                buttons: document.querySelector('.pair-selector'),
                chartContainer: document.querySelector('.price-chart')
            };

            // Ensure liquidation console exists
            if (!existingControls.console) {
                // Only create new console if none exists
                if (!document.getElementById('liquidation-console')) {
                    const newConsole = document.createElement('div');
                    newConsole.id = 'liquidation-console';
                    newConsole.className = 'liquidation-console';
                    newConsole.style.cssText = 'display: block; visibility: visible; opacity: 1';
                    priceChartContainer.appendChild(newConsole);
                }
                // Ensure the console is visible
                ensureLiquidationConsoleTitle();
            }

            // Preserve control elements during chart switch
            if (existingControls.settings) {
                priceChartContainer.appendChild(existingControls.settings);
            }
            if (existingControls.buttons && existingControls.buttons.parentElement) {
                existingControls.buttons.parentElement.insertBefore(
                    existingControls.buttons,
                    existingControls.buttons.parentElement.firstChild
                );
            }
        }
        await new Promise(r => setTimeout(r, 200));
        try {
            // Clear BTC cache before loading, to avoid stale/corrupted data
            if (newPair === "BTC" && typeof preCalculateDataCache !== "undefined" && preCalculateDataCache) {
                preCalculateDataCache.delete("BTC_" + CONFIG.barInterval);
            }

            // Force DOM cleanup for BTC before initializing
            if (newPair === "BTC" && container) {
                const priceChartElement = container.querySelector(".price-chart");
                if (priceChartElement) {
                    priceChartElement.innerHTML = "";
                }
            }

            // Pass abort signal to preCalculateData and downstream fetches
            const data = await preCalculateData(newPair, overlay, undefined, abortController.signal);
            console.log("[switchPairInternal] Initializing chart for", newPair, data);
            if (abortController.signal.aborted) {
                overlay.textContent = `Switch to ${newPair} cancelled`;
                overlay.style.display = "none";
                return;
            }
            if (!data) {
                overlay.textContent = `Failed to load data for ${newPair}`;
                setTimeout(() => overlay.style.display = "none", 3000);
                return;
            }
            const state = initializeChartAndMeter(container, data, newPair);
            state.isActive = true;
            chartStates.set(newPair, state);
            if (state.chart.extras?.watermark) state.chart.extras.watermark.applyOptions({ lines: [{ text: `${newPair.toUpperCase()}USD`, color: 'rgba(255, 255, 255, 0.3)', fontSize: 28, fontStyle: 'bold', fontFamily: 'Arial' }], padding: { right: 28 } });
            container.dataset.pair = newPair;
            currentPair = newPair;
            window.currentPair = newPair;
            subscribePair(newPair);
            window.clearChartConsole?.();
            const liquidationConsole = document.getElementById('liquidation-console');
            if (liquidationConsole) liquidationConsole.style.cssText = 'display: block; visibility: visible; opacity: 1';
            if (window.updateTradingViewWidget && document.querySelector('.tradingview-widget-container').style.display !== 'none') window.updateTradingViewWidget(newPair);
            window.updateSize();
            const profileManagers = [
                { m: window.volumeProfileManager, k: 'volumeProfile', c: { priceRange: 150, barWidth: 0.8, position: 0.1, alignLeft: true, liquidationConsoleWidth: 85, profileWidth: 80, colors: { bullish: "rgba(192, 192, 192, 0.7)", bearish: "rgba(64, 64, 64, 0.7)", median: "rgba(255, 255, 255, 0.8)" }, showMedian: true, visible: true, liveUpdate: true, maxBars: 6000, normalizationWindow: 1440 } },
                { m: window.fundingProfileManager, k: 'fundingProfile', c: { priceRange: 150, barWidth: 0.8, position: 0.1, alignLeft: true, liquidationConsoleWidth: 85, profileWidth: 80, colors: { positive: "rgba(100, 180, 255, 0.7)", negative: "rgba(30, 80, 150, 0.7)", neutral: "rgba(150, 150, 150, 0.7)" }, showMedian: false, visible: true, liveUpdate: true, maxBars: 6000, normalizationWindow: 1440 } },
                { m: window.openInterestProfileManager, k: 'openInterestProfile', c: { priceRange: 150, barWidth: 0.8, position: 0.1, alignLeft: true, liquidationConsoleWidth: 85, profileWidth: 80, colors: { bullish: "rgba(192, 192, 192, 0.7)", bearish: "rgba(64, 64, 64, 0.7)", median: "rgba(255, 255, 255, 0.8)" }, showMedian: false, visible: true, liveUpdate: true, maxBars: 6000, normalizationWindow: 1440 } }
            ];
            profileManagers.forEach(({ m, k, c }) => { if (m?.initialize && (!state[k] || !state[k].update)) state[k] = m.initialize(state, state[k]?.config || c); });
            [100, 500, 1000, 2000, 3000, 5000].forEach(d => setTimeout(() => { state.volumeProfile?.update?.(); state.fundingProfile?.update?.(); state.openInterestProfile?.update?.(); window.updateSize(); ensureLiquidationConsoleTitle(); }, d));
            window.updateSize();
            initSettingsButton();
            ensureLiquidationConsoleTitle();
            setTimeout(() => { window.updateSize(); ensureLiquidationConsoleTitle(); }, 1000);

            // Reset Bybit Net Flow state and re-attach UI
            if (window.resetNetFlow) window.resetNetFlow();
            if (window.createNetFlowWindow) window.createNetFlowWindow();

            // Hide overlay only when chart is fully ready
            overlay.style.display = "none";
        } catch (e) {
            if (abortController.signal.aborted) {
                overlay.textContent = `Switch to ${newPair} cancelled`;
                overlay.style.display = "none";
            } else {
                overlay.textContent = `Error switching to ${newPair}: ${e.message}`;
                setTimeout(() => overlay.style.display = "none", 3000);
            }
        } finally {
            clearTimeout(timeout);
            switchInProgress = false;
        }
    }

    const switchPair = utils.debounce(switchPairInternal, 200);
    domCache.get("buttons")?.forEach(b => {
        if (b.dataset.pair) {
            if (b.dataset.pair === "BTC") b.classList.add("active");
            b.addEventListener("click", () => {
                window.updateActiveButtonState?.(b.dataset.pair) || (() => { domCache.get("buttons").forEach(btn => btn.classList.remove("active")); b.classList.add("active"); })();
                switchPair(b.dataset.pair);
            });
        }
    });
    window.switchPair = switchPair;

    window.addEventListener("memory-pressure", e => {
        const level = e.detail.level;
        chartStates.forEach(state => {
            if (state?.chart) {
                if (level === "critical") { memoryManagement.cleanupHistoricalData(state); chartOrderbook?.clearOrderBookLines?.(state); }
                else if (level === "high") {
                    memoryManagement.cleanupHistoricalData(state);
                    if (state.data.orderBook) { state.data.orderBook.bids = state.data.orderBook.bids.slice(0, 100); state.data.orderBook.asks = state.data.orderBook.asks.slice(0, 100); }
                }
            }
        });
    });

    function cleanup() {
            // Clear global event listeners
            window.removeEventListener("memory-pressure", handleMemoryPressure);
            window.removeEventListener("resize", handleResize);

            // Clean up each chart state
            chartStates.forEach(state => {
                if (!state) return;

                // Dispose of managers and profiles
                const managers = [
                    'liquidationManager',
                    'whaleAlertManager',
                    'volumeProfile',
                    'fundingProfile',
                    'openInterestProfile'
                ];
                managers.forEach(manager => {
                    if (state[manager]?.destroy) {
                        try {
                            state[manager].destroy();
                        } catch (e) {
                            console.debug(`Error destroying ${manager}:`, e);
                        }
                    }
                    state[manager] = null;
                });

                // Remove chart series and the chart itself
                if (state.chart) {
                    const { priceChart, extras } = state.chart;
                    if (extras?.markerSeries && !extras.markerSeries._internal_isDisposed) {
                        try {
                            priceChart.removeSeries(extras.markerSeries);
                        } catch (e) {
                            console.debug('Error removing marker series:', e);
                        }
                    }
                    if (priceChart && !priceChart._internal_isDisposed) {
                        try {
                            priceChart.remove();
                        } catch (e) {
                            console.debug('Error removing price chart:', e);
                        }
                    }
                }

                // Unsubscribe from WebSocket updates
                if (state.config?.ticker?.symbol) {
                    unsubscribePair(state.config.ticker.symbol);
                }

                state.isActive = false;
                state.isDisposed = true;
                state = null;
            });

            // Clear the global state
            chartStates.clear();
            window.chartStates = new Map(); // Reset global reference
        }
        window.addEventListener("beforeunload", cleanup);

    document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = `.liq-controls{position:absolute;bottom:10px;right:10px;display:flex;gap:10px;z-index:100;padding:5px 10px;background-color:rgba(15,20,26,0.8);border-radius:4px;box-shadow:0 2px 5px rgba(0,0,0,0.3)}.liq-apply-btn{background:#444;color:#fff;border:none;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:11px}.liq-apply-btn:hover{background:#555}.liq-threshold-input{background:#333;color:#fff;border:1px solid #555;padding:4px;border-radius:3px;width:80px}.settings-dropdown{position:relative}.settings-dropdown-content{display:none;background-color:#1a2026;border:1px solid #555;border-radius:4px;padding:10px;position:absolute;bottom:100%;right:0;min-width:200px;z-index:101}.settings-dropdown-content.show{display:block}.settings-group{margin-bottom:10px}.settings-group-title{font-size:12px;color:#fff;margin-bottom:5px}.settings-group-content{display:flex;gap:5px;align-items:center}.settings-btn{background:#444;color:#fff;border:none;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:11px}
        /* Hide only the '1 to -1' chart line label in the legend */
        .tv-lightweight-charts .pane-legend-item[data-title*='1 to -1'] {
            opacity: 0 !important;
            color: transparent !important;
        }`;
        document.head.appendChild(style);
        setTimeout(initSettingsButton, 1000);
        setTimeout(ensureLiquidationConsoleTitle, 500);
        const observer = new MutationObserver(m => {
            let shouldEnsure = false;
            for (const mu of m) {
                if (mu.type === 'childList' && (mu.target.id === 'liquidation-console' || mu.target.closest('#liquidation-console'))) { shouldEnsure = true; break; }
                if (mu.type === 'attributes' && mu.attributeName === 'style' && ['liquidation-console', 'liquidation-console-title'].includes(mu.target.id)) { shouldEnsure = true; break; }
            }
            if (shouldEnsure) ensureLiquidationConsoleTitle();
        });
        const lc = document.getElementById('liquidation-console');
        if (lc) observer.observe(lc, { childList: true, attributes: true, attributeFilter: ['style'], subtree: true });
        const cc = document.querySelector('.price-chart-container');
        if (cc) observer.observe(cc, { childList: true });
        const debouncedResize = (() => {
            let t = null;
            let cbs = new Set();
            const add = cb => { if (typeof cb === 'function') cbs.add(cb); return () => cbs.delete(cb); };
            const exec = () => cbs.forEach(cb => { try { cb(); } catch (e) {} });
            const handle = () => { clearTimeout(t); t = setTimeout(exec, 100); };
            window.addEventListener('resize', handle, { passive: true });
            return { addCallback: add, trigger: handle };
        })();
        const ps = document.querySelector('.tv-lightweight-charts .pane-separator');
        if (ps) {
            ps.addEventListener('mouseup', debouncedResize.trigger, { passive: true });
            new MutationObserver(debouncedResize.trigger).observe(ps, { attributes: true, attributeFilter: ['style'] });
        }
        debouncedResize.addCallback(window.updateSize);
        const container = domCache.get("container");
        if (container) {
            const ro = new ResizeObserver(() => window.updateSize());
            ro.observe(container);
            window.addEventListener('beforeunload', () => ro.disconnect());
        }
    });

    function directUpdatePriceData(state, price, volume, type) {
        const now = Math.floor(Date.now() / 1000);
        const barInterval = state.config.barInterval || 300;
        const barTime = Math.floor(now / barInterval) * barInterval;
        let bar = state.currentBars.currentBarBitstamp;
        if (!bar) {
            bar = state.currentBars.currentBarBitstamp = { time: barTime, open: price, high: price, low: price, close: price, volume };
        } else if (bar.time < barTime) {
            state.data.priceData.push(bar);
            if (state.data.priceData.length > state.config.maxBars) state.data.priceData.shift();
            bar = state.currentBars.currentBarBitstamp = { time: barTime, open: price, high: price, low: price, close: price, volume };
            state.volumeProfile?.update?.();
            state.fundingProfile?.update?.();
            state.openInterestProfile?.update?.();
        } else {
            bar.close = price;
            bar.high = Math.max(bar.high, price);
            bar.low = Math.min(bar.low, price);
            bar.volume += volume;
        }
        state.chart?.priceSeries?.update(bar);
        state.liquidationManager?.checkForCandleClose?.(Date.now());
        state.whaleAlertManager?.checkForCandleClose?.(Date.now());
        window.cvdModule?.renderPendingCVDUpdates?.(state.chart?.cvdComponents);
        window.perpCvdModule?.renderPendingCVDUpdates?.(state.chart?.perpCvdComponents);
        if (!state.metrics) state.metrics = { buyVolume: 0, sellVolume: 0, buyValue: 0, sellValue: 0, liquidations: 0, liquidationsMin: 0, liquidationsMax: 0, spotPressure: 0 };
        if (type !== undefined) {
            const isBuy = type === 0;
            const tradeValue = price * volume;
            if (isBuy) { state.metrics.buyVolume += volume; state.metrics.buyValue += tradeValue; } else { state.metrics.sellVolume += volume; state.metrics.sellValue += tradeValue; }
            if (tradeValue >= (state.whaleAlertManager?.dollarThreshold || 100000)) {
                // Only update the console, don't create markers
                // (console.log for whale events removed to prevent double rendering; wsmanager.js handles this)
            }
        }
    }

    function initSettingsButton() {
        const existingControls = document.querySelector('.liq-controls');
        if (existingControls) existingControls.remove();

        const container = document.querySelector('.price-chart-container');
        if (!container) return;

        // Create controls container and settings dropdown
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'liq-controls';

        const settingsDropdown = document.createElement('div');
        settingsDropdown.className = 'settings-dropdown';

        // Create settings button
        const settingsButton = document.createElement('button');
        settingsButton.id = 'settings-btn';
        settingsButton.className = 'settings-btn';
        settingsButton.textContent = 'Settings';

        // Create dropdown content
        const dropdownContent = document.createElement('div');
        dropdownContent.className = 'settings-dropdown-content';

        // Get saved values or use defaults
        const savedLiqThreshold = localStorage.getItem('liquidationThreshold');
        const defaultLiqThreshold = savedLiqThreshold ? parseFloat(savedLiqThreshold) : 100000;

        const savedWhaleThreshold = localStorage.getItem('whaleAlertThreshold');
        const defaultWhaleThreshold = savedWhaleThreshold ? parseFloat(savedWhaleThreshold) : 100000;

        const savedVPLines = localStorage.getItem('volumeProfileLines');
        const defaultVPLines = savedVPLines ? parseInt(savedVPLines) : 150;

        // Apply initial values to chart states
        window.chartStates?.forEach(state => {
            if (state.liquidationManager) state.liquidationManager.dollarThreshold = defaultLiqThreshold;
            if (state.whaleAlertManager) state.whaleAlertManager.dollarThreshold = defaultWhaleThreshold;
            // Set hardwired normalization window
            ['volumeProfile', 'liquidationsProfile', 'openInterestProfile', 'fundingProfile'].forEach(profile => {
                if (state[profile]) {
                    state[profile].config.normalizationWindow = 1440;
                    state[profile].update?.();
                }
            });
        });

        // Create settings groups
        const liqGroup = createSettingsGroup('Liquidation Threshold', 'liq-threshold-input', defaultLiqThreshold, 'Min $ value', applyLiquidationThreshold);
        const whaleGroup = createSettingsGroup('Whale Alert Threshold', 'whale-threshold-input', defaultWhaleThreshold, 'Min $ value', applyWhaleAlertThreshold);
        const vpGroup = createSettingsGroup('Profile Lines', 'vp-lines-input', defaultVPLines, 'Profile Lines', applyVolumeProfileLines, 'number', 100, 1000, 50);

        // Add groups to dropdown
        dropdownContent.appendChild(liqGroup);
        dropdownContent.appendChild(whaleGroup);
        dropdownContent.appendChild(vpGroup);

        // Assemble dropdown
        settingsDropdown.appendChild(settingsButton);
        settingsDropdown.appendChild(dropdownContent);
        controlsContainer.appendChild(settingsDropdown);
        container.appendChild(controlsContainer);

        // Add click handlers
        settingsButton.addEventListener('click', () => dropdownContent.classList.toggle('show'));
        document.addEventListener('click', (event) => {
            if (!settingsButton.contains(event.target) && !dropdownContent.contains(event.target)) {
                dropdownContent.classList.remove('show');
            }
        });
    }

    function createSettingsGroup(title, inputId, defaultValue, placeholder, applyFunction, type = 'number', min = 0, max = Infinity, step = 10000) {
        const group = document.createElement('div');
        group.className = 'settings-group';

        const groupTitle = document.createElement('div');
        groupTitle.className = 'settings-group-title';
        groupTitle.textContent = title;

        const content = document.createElement('div');
        content.className = 'settings-group-content';

        const input = document.createElement('input');
        input.type = type;
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = defaultValue.toString();
        input.id = inputId;
        input.className = 'liq-threshold-input';
        input.placeholder = placeholder;

        const applyButton = document.createElement('button');
        applyButton.textContent = 'Apply';
        applyButton.className = 'liq-apply-btn';

        content.appendChild(input);
        content.appendChild(applyButton);
        group.appendChild(groupTitle);
        group.appendChild(content);

        applyButton.addEventListener('click', applyFunction);
        input.addEventListener('keyup', event => {
            if (event.key === 'Enter') applyFunction();
        });

        return group;
    }

    function applyLiquidationThreshold() {
            const thresholdInput = document.getElementById('liq-threshold-input');
            if (!thresholdInput) return;

            const thresholdValue = parseFloat(thresholdInput.value) || 100000;

            try {
                localStorage.setItem('liquidationThreshold', thresholdValue.toString());
                window.currentLiquidationThreshold = thresholdValue;
                window.directConsole?.setThreshold?.(thresholdValue);

                // Update global console capture threshold
                if (typeof window.setConsoleMessageThreshold === "function") {
                    window.setConsoleMessageThreshold(thresholdValue);
                } else {
                    window.consoleMessageThreshold = thresholdValue;
                }

                window.chartStates.forEach((state) => {
                    if (state.liquidationManager) {
                        state.liquidationManager.dollarThreshold = thresholdValue;
                    }
                });

                console.log(`[Settings] Liquidation threshold updated: $${thresholdValue.toLocaleString()}`);

                thresholdInput.style.backgroundColor = 'rgba(0, 100, 0, 0.3)';
                setTimeout(() => thresholdInput.style.backgroundColor = '', 500);
            } catch (e) {
                thresholdInput.style.backgroundColor = 'rgba(100, 0, 0, 0.3)';
                setTimeout(() => thresholdInput.style.backgroundColor = '', 500);
            }
        }

    function applyWhaleAlertThreshold() {
            const thresholdInput = document.getElementById('whale-threshold-input');
            if (!thresholdInput) return;

            const thresholdValue = parseFloat(thresholdInput.value) || 100000;

            try {
                localStorage.setItem('whaleAlertThreshold', thresholdValue.toString());

                // Update global console capture threshold
                if (typeof window.setConsoleMessageThreshold === "function") {
                    window.setConsoleMessageThreshold(thresholdValue);
                } else {
                    window.consoleMessageThreshold = thresholdValue;
                }

                window.chartStates.forEach(state => {
                    if (state.whaleAlertManager) {
                        state.whaleAlertManager.dollarThreshold = thresholdValue;
                    }
                });

                console.log(`[Settings] Whale alert threshold updated: $${thresholdValue.toLocaleString()}`);

                thresholdInput.style.backgroundColor = 'rgba(0, 100, 0, 0.3)';
                setTimeout(() => thresholdInput.style.backgroundColor = '', 500);
            } catch (e) {
                thresholdInput.style.backgroundColor = 'rgba(100, 0, 0, 0.3)';
                setTimeout(() => thresholdInput.style.backgroundColor = '', 500);
            }
        }

    function applyVolumeProfileLines() {
            const linesInput = document.getElementById('vp-lines-input');
            if (!linesInput) return;

            const linesValue = parseInt(linesInput.value) || 150;
            if (linesValue < 100 || linesValue > 1000) {
                linesInput.style.backgroundColor = 'rgba(100, 0, 0, 0.3)';
                setTimeout(() => linesInput.style.backgroundColor = '', 500);
                return;
            }

            try {
                localStorage.setItem('volumeProfileLines', linesValue.toString());
                window.chartStates.forEach(state => {
                    ['volumeProfile', 'liquidationsProfile', 'openInterestProfile', 'fundingProfile'].forEach(profile => {
                        if (state[profile]) {
                            state[profile].config.priceRange = linesValue;
                            state[profile].update?.();
                        }
                    });
                });

                linesInput.style.backgroundColor = 'rgba(0, 100, 0, 0.3)';
                setTimeout(() => linesInput.style.backgroundColor = '', 500);
            } catch (e) {
                linesInput.style.backgroundColor = 'rgba(100, 0, 0, 0.3)';
                setTimeout(() => linesInput.style.backgroundColor = '', 500);
            }
        }

    let lastTitleUpdateTime = 0;
    const MIN_UPDATE_INTERVAL = 500;

    function ensureLiquidationConsoleTitle() {
        const now = Date.now();
        if (now - lastTitleUpdateTime < MIN_UPDATE_INTERVAL) return;
        lastTitleUpdateTime = now;
        const consoleElement = document.getElementById('liquidation-console');
        if (!consoleElement) return;

        // Remove any existing title elements (optional cleanup, can be omitted if no titles exist)
        const existingTitles = consoleElement.querySelectorAll('#liquidation-console-title');
        existingTitles.forEach(title => title.remove());

        // Ensure the console is visible, but do not add the title
        const style = window.getComputedStyle(consoleElement);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            consoleElement.style.display = 'block';
            consoleElement.style.visibility = 'visible';
            consoleElement.style.opacity = '1';
        }
    }

    // Initialize everything
    (async () => {
        await waitForLightweightCharts();
        await initializeChart();
        setTimeout(initSettingsButton, 1000);
    })().catch(e => handleError("Error in charts.js", e, domCache.get("overlay")));
})();
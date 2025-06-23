(() => {
    const CONFIG = { maxCachedItems: 1000, emaPeriod: 180, sdPeriod: 1440, minLookbackBars: 1440, barInterval: 300 };
    const bandsCache = new WeakMap();
    window.chartIndicators = {
        calculateBands: ({ priceData }) => {
            if (bandsCache.has(priceData)) return bandsCache.get(priceData);
            if (!priceData?.length || priceData.length < CONFIG.emaPeriod) return { t1: 0, t2: 0, b1: 0, b2: 0, time: priceData?.[priceData.length - 1]?.time || 0 };
            const volumes = priceData.map(b => b.volume || 0);
            const highs = priceData.map(b => b.high);
            const lows = priceData.map(b => b.low);
            const volMA = window.utils.ema(volumes, CONFIG.emaPeriod);
            const pvHigh = window.utils.ema(highs.map((p, i) => p * volumes[i]), CONFIG.emaPeriod);
            const pvLow = window.utils.ema(lows.map((p, i) => p * volumes[i]), CONFIG.emaPeriod);
            const emaPVHigh = window.utils.ema(pvHigh, CONFIG.emaPeriod);
            const emaPVLow = window.utils.ema(pvLow, CONFIG.emaPeriod);
            const emaVol = window.utils.ema(volMA, CONFIG.emaPeriod);
            const ma1 = emaPVHigh.map((pv, i) => emaVol[i] ? pv / emaVol[i] : 0);
            const ma2 = emaPVLow.map((pv, i) => emaVol[i] ? pv / emaVol[i] : 0);
            const p1 = highs.map((h, i) => ma1[i] ? (h - ma1[i]) / ma1[i] : 0);
            const p2 = lows.map((l, i) => ma2[i] ? (l - ma2[i]) / ma2[i] : 0);
            const sdPeriod = Math.min(CONFIG.sdPeriod, priceData.length - CONFIG.emaPeriod);
            if (sdPeriod < 2) return { t1: 0, t2: 0, b1: 0, b2: 0, time: priceData[priceData.length - 1].time };
            const sd10 = window.utils.stdev(p1, sdPeriod);
            const sd20 = window.utils.stdev(p2, sdPeriod);
            const i = priceData.length - 1;
            const result = {
                t1: ma1[i] * (1 + (sd10[i] || 0) * 2.25),
                t2: ma1[i] * (1 + (sd10[i] || 0) * 4.25),
                b1: ma2[i] * (1 - (sd20[i] || 0) * 2.25),
                b2: ma2[i] * (1 - (sd20[i] || 0) * 4.25),
                time: priceData[i].time
            };
            bandsCache.set(priceData, result);
            return result;
        },
        calculateVTWAP: (bar, caches) => {
            if (!bar?.time) return { vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN, caches };
            let { twapCache = { priceSum: 0, count: 0, value: 0 }, vwapCache = { priceVolume: 0, totalVolume: 0, anchor: null }, stdDevCache = window.utils.initStdDevCache(), vwapActive = false } = caches;
            const date = new Date(bar.time * 1000);
            const dow = date.getUTCDay();
            const h = date.getUTCHours();
            const m = date.getUTCMinutes();
            const asiaStart = dow === 1 && h === 0 && m === 0;
            const nyOpen = dow === 1 && h === 13 && m === 30;
            const inTwap = dow === 1 && h >= 0 && (h < 13 || (h === 13 && m < 30));
            const showVwap = dow > 1 || (dow === 1 && (h > 13 || (h === 13 && m >= 30)));
            if (asiaStart) {
                twapCache = { priceSum: 0, count: 0, value: 0 };
                vwapCache = { priceVolume: 0, totalVolume: 0, anchor: null };
                stdDevCache = window.chartIndicators.utils.initStdDevCache();
                vwapActive = false;
            }
            let twapValue = bar.close;
            if (inTwap) {
                const ohlc4 = (bar.open + bar.high + bar.low + bar.close) / 4;
                twapCache.priceSum += ohlc4;
                twapCache.count += 1;
                twapValue = twapCache.priceSum / twapCache.count;
                twapCache.value = twapValue;
            } else if (twapCache.count > 0) twapValue = twapCache.value;
            if (nyOpen) {
                vwapCache.anchor = twapValue;
                vwapActive = true;
            }
            let vwapValue = NaN, upperBand = NaN, lowerBand = NaN, upperMidline = NaN, lowerMidline = NaN;
            if (showVwap && vwapCache.anchor !== null && vwapActive) {
                const hlc3 = (bar.high + bar.low + bar.close) / 3;
                const volume = bar.volume || 0;  // Use 0 as fallback consistently
                if (nyOpen) {
                    // On NY open, initialize with anchor value as per reference implementation
                    vwapCache.priceVolume = vwapCache.anchor * (volume || 1);
                    vwapCache.totalVolume = volume || 1;
                } else {
                    vwapCache.priceVolume += hlc3 * volume;
                    vwapCache.totalVolume += volume;
                }
                vwapValue = vwapCache.totalVolume > 0 ? vwapCache.priceVolume / vwapCache.totalVolume : hlc3;
                // Calculate std dev directly from hlc3 as per reference implementation
                const stdDev = window.utils.updateStdDev(stdDevCache, hlc3);
                const multiplier = 2.5;
                upperBand = vwapValue + (multiplier * stdDev);
                lowerBand = vwapValue - (multiplier * stdDev);
                // Calculate midlines as average of VWAP and respective band as per reference implementation
                upperMidline = (vwapValue + upperBand) / 2;
                lowerMidline = (vwapValue + lowerBand) / 2;
            }
            caches.twapCache = twapCache;
            caches.vwapCache = vwapCache;
            caches.stdDevCache = stdDevCache;
            caches.vwapActive = vwapActive;
            return { vwapValue, upperBand, lowerBand, upperMidline, lowerMidline, caches };
        },
        calculateLiqs: (bybitData, bitstampData, windowSize) => {
            if (!bybitData?.length || !bitstampData?.length) return { liqsData: [], liqsRaw: [], perpD: [{ value: 0 }], spotD: [{ value: 0 }] };
            const liqsRaw = [];
            const liqsData = [];
            const perpD = [];
            const spotD = [];
            const bybitMap = new Map(bybitData.map(b => [b.time, b]));
            const bitstampMap = new Map(bitstampData.map(b => [b.time, b]));
            const allTimes = [...new Set([...bybitData.map(d => d.time), ...bitstampData.map(d => d.time)])].sort();
            let perpSum = 0, spotSum = 0;
            allTimes.forEach(t => {
                const bybitBar = bybitMap.get(t) || { volume: 0, close: 0 };
                const bitstampBar = bitstampMap.get(t) || { volume: 0, close: 0 };
                const pv = bybitBar.volume;
                const sv = bitstampBar.volume;
                perpSum += pv;
                spotSum += sv;
                liqsRaw.push({ time: t, perpVolume: pv, spotVolume: sv });
                liqsData.push({ time: t, value: pv - sv });
                perpD.push({ time: t, value: perpSum });
                spotD.push({ time: t, value: spotSum });
            });
            if (liqsRaw.length > windowSize) {
                liqsRaw.splice(0, liqsRaw.length - windowSize);
                liqsData.splice(0, liqsData.length - windowSize);
                perpD.splice(0, perpD.length - windowSize);
                spotD.splice(0, spotD.length - windowSize);
            }
            return { liqsData, liqsRaw, perpD, spotD };
        },
        calculateEMABands: (() => {
            const emaBandsCache = new WeakMap();
            return (priceData, period = 20, multiplier = 2) => {
                if (emaBandsCache.has(priceData)) return emaBandsCache.get(priceData);
                if (!priceData?.length) return { ema: 0, upper: 0, lower: 0, time: 0 };
                const prices = priceData.map(b => b.close);
                const ema = window.utils.ema(prices, period)[prices.length - 1] || 0;
                const stdDev = window.utils.stdev(prices, period)[prices.length - 1] || 0;
                const result = { ema, upper: ema + stdDev * multiplier, lower: ema - stdDev * multiplier, time: priceData[priceData.length - 1].time };
                emaBandsCache.set(priceData, result);
                return result;
            };
        })(),
        calculateCVD: (() => {
            const cvdCache = new WeakMap();
            return (priceData) => {
                if (cvdCache.has(priceData)) return cvdCache.get(priceData);
                if (!priceData?.length) return { cvd: 0, time: 0 };
                let cvd = 0;
                for (const b of priceData) cvd += (b.close >= b.open ? 1 : -1) * (b.volume || 0);
                const result = { cvd, time: priceData[priceData.length - 1].time };
                cvdCache.set(priceData, result);
                return result;
            };
        })(),
        calculateAllIndicators: (() => {
            const allIndicatorsCache = new WeakMap();
            return (priceData, opts = {}) => {
                if (allIndicatorsCache.has(priceData)) return allIndicatorsCache.get(priceData);
                const data = priceData?.length < CONFIG.minLookbackBars ? (() => {
                    const first = priceData[0];
                    const interval = priceData.length > 1 ? priceData[1].time - first.time : 300;
                    const add = CONFIG.minLookbackBars - priceData.length;
                    // Add synthetic data but with zero volume to not affect VWAP
                    const synthetic = Array.from({ length: add }, (_, i) => ({
                        ...first,
                        time: first.time - ((add - i) * interval),
                        volume: 0  // Set volume to 0 for synthetic bars
                    }));
                    return [...synthetic, ...priceData];
                })() : priceData;
                if (!data?.length) {
                    const result = {
                        bands: { t1: 0, t2: 0, b1: 0, b2: 0, time: 0 },
                        vwap: { vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN },
                        vwapData: [],
                        emaBands: { ema: 0, upper: 0, lower: 0, time: 0 },
                        cvd: { cvd: 0, time: 0 },
                        caches: { twapCache: { priceSum: 0, count: 0, value: 0 }, vwapCache: { priceVolume: 0, totalVolume: 0, anchor: null }, stdDevCache: window.chartIndicators.utils.initStdDevCache(), vwapActive: false }
                    };
                    allIndicatorsCache.set(priceData, result);
                    return result;
                }
                const bands = window.chartIndicators.calculateBands({ priceData: data });
                const emaBands = window.chartIndicators.calculateEMABands(data);
                const cvd = window.chartIndicators.calculateCVD(data);
                const caches = { twapCache: { priceSum: 0, count: 0, value: 0 }, vwapCache: { priceVolume: 0, totalVolume: 0, anchor: null }, stdDevCache: window.utils.initStdDevCache(), vwapActive: false };
                let latestVwap = { vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN };
                const vwapData = data.map(b => {
                    const r = window.chartIndicators.calculateVTWAP(b, caches);
                    Object.assign(caches, r.caches);
                    if (!isNaN(r.vwapValue)) latestVwap = r;
                    return { time: b.time, ...latestVwap };
                });
                const result = { bands, vwap: latestVwap, vwapData, emaBands, cvd, caches };
                allIndicatorsCache.set(priceData, result);
                return result;
            };
        })(),
        utils: window.utils,
        orderbook: {
            lineCache: { bids: new Map(), asks: new Map() },
            smoothedPrices: { bids: new Map(), asks: new Map() },
            MAX_CACHE_SIZE: 1000,
            clearOrderBookLines: s => {
                if (!s) return;
                s.currentLines = s.currentLines || [];
                if (!s.chart || !s.chart.priceSeries || s.chart.priceSeries._internal_isDisposed) {
                    s.currentLines = [];
                    return;
                }
                try {
                    if (typeof s.chart.priceSeries.priceScale !== 'function' || !s.chart.priceSeries.priceScale()) {
                        s.currentLines = [];
                        return;
                    }
                    const lines = [...s.currentLines];
                    s.currentLines = [];
                    lines.forEach(l => { try { if (l && s.chart.priceSeries?.removePriceLine) s.chart.priceSeries.removePriceLine(l); } catch (e) {} });
                } catch (e) { s.currentLines = []; }
            },
            updateOrderBookLines: s => {
                if (!s?.chart?.priceSeries || !s.isActive) return;
                s.currentLines = s.currentLines || [];
                window.chartIndicators.orderbook.processOrderBookUpdate(s);
            },
            smoothPriceLevel: (t, p, v) => {
                const sp = window.chartIndicators.orderbook.smoothedPrices;
                const k = p.toFixed(2);
                const now = Date.now();
                const e = sp[t].get(k);
                if (!e) {
                    sp[t].set(k, { price: p, volume: v, lastSeen: now });
                    return { price: p, volume: v, isNew: true };
                }
                e.lastSeen = now;
                if (Math.abs(e.volume - v) / e.volume > 0.1) {
                    e.volume = v;
                    return { price: p, volume: v, isUpdated: true };
                }
                return { price: p, volume: e.volume, isStable: true };
            },
            cleanupSmoothPrices: () => {
                const { smoothedPrices, MAX_CACHE_SIZE } = window.chartIndicators.orderbook;
                const now = Date.now();
                const EXPIRY = 30000;
                ['bids', 'asks'].forEach(t => {
                    for (const [k, d] of smoothedPrices[t]) if (now - d.lastSeen > EXPIRY) smoothedPrices[t].delete(k);
                    if (smoothedPrices[t].size > MAX_CACHE_SIZE) {
                        const e = [...smoothedPrices[t]].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
                        e.slice(0, e.length - MAX_CACHE_SIZE).forEach(([k]) => smoothedPrices[t].delete(k));
                    }
                });
            },
            processOrderBookUpdate: s => {
                try {
                    if (!s.chart.priceSeries.priceScale()) return;
                    const { bids, asks } = s.data.orderBook || { bids: [], asks: [] };
                    if (!bids.length || !asks.length) return;
                    const hash = () => {
                        const tb = bids.slice(0, 10);
                        const ta = asks.slice(0, 10);
                        return `${tb.map(b => `${b[0]}:${b[1]}`).join('|')}#${ta.map(a => `${a[0]}:${a[1]}`).join('|')}`;
                    };
                    const currHash = hash();
                    if (currHash === s._lastOrderBookHash) return;
                    s._lastOrderBookHash = currHash;
                    window.chartIndicators.orderbook.cleanupSmoothPrices();
                    window.chartIndicators.orderbook.clearOrderBookLines(s);
                    const lastPrice = s.data.priceData?.[s.data.priceData.length - 1]?.close || 0;
                    if (!lastPrice) return;
                    const pb = bids.map(([p, v]) => ({ price: p, volume: v, dollarValue: p * v, type: 'bid' }));
                    const pa = asks.map(([p, v]) => ({ price: p, volume: v, dollarValue: p * v, type: 'ask' }));
                    const allOrders = [...pb, ...pa].sort((a, b) => b.dollarValue - a.dollarValue).slice(0, 20);
                    const maxValue = allOrders[0]?.dollarValue || 1;
                    let bidShown = false, askShown = false;
                    allOrders.forEach((o, i) => {
                        try {
                            const { price, volume, dollarValue, type } = o;
                            const relSize = Math.max(0.5, Math.min(1, dollarValue / maxValue));
                            const lineWidth = Math.max(1, Math.round(relSize * 3));
                            const fmtValue = dollarValue >= 1e6 ? `$${Math.floor(dollarValue / 1e6)}M` : `$${Math.floor(dollarValue / 1e3)}K`;
                            const showLabel = (type === 'bid' && !bidShown) || (type === 'ask' && !askShown);
                            if (type === 'bid' && showLabel) bidShown = true;
                            if (type === 'ask' && showLabel) askShown = true;
                            const baseOpacity = showLabel ? 0.45 : 0.25;
                            const opacityDec = showLabel ? 0.02 : 0.03;
                            const line = s.chart.priceSeries.createPriceLine({
                                price,
                                color: type === 'bid' ? `rgba(0, 255, 255, ${baseOpacity - i * opacityDec})` : `rgba(255, 85, 85, ${baseOpacity - i * opacityDec})`,
                                lineWidth,
                                lineStyle: 0,
                                axisLabelVisible: showLabel,
                                title: showLabel ? `${type.toUpperCase()} ${fmtValue}` : ''
                            });
                            s.currentLines.push(line);
                        } catch (e) {}
                    });
                } catch (e) { console.error("Error processing orderbook update:", e); }
            },
            updateLastPrice: (s, p) => {
                if (!s?.isActive || !s.data?.priceData?.length) return;
                const lastBar = s.data.priceData[s.data.priceData.length - 1];
                if (lastBar) lastBar.close = p;
                window.chartIndicators.orderbook.updateOrderBookLines(s);
            }
        }
    };

    const MAX_VISIBLE_LIQUIDATIONS = 50;
    window.chartLiquidations = {
        createManager: ({ pair, priceSeries, barInterval, findBarFn }) => {
            if (!priceSeries) return null;
            let currentBarTime = null;
            let dollarThreshold = localStorage.getItem("liquidationThreshold") ? parseFloat(localStorage.getItem("liquidationThreshold")) : 100000;
            const m = {
                dollarThreshold,
                pair,
                priceSeries,
                barInterval,
                findBarFn,
                addLiquidation: liq => {
                    if (!liq?.price || !liq.amount || !liq.side) return;
                    const { price, amount, side, timestamp } = liq;
                    const value = price * amount;
                    if (value < m.dollarThreshold || !m.isActiveFn() || window.currentActivePair !== m.pair) return;

                    const barTime = Math.floor(timestamp / barInterval) * barInterval;
                    const bar = findBarFn(barTime);
                    if (!bar) return;
                    if (currentBarTime && barTime > currentBarTime) {
                        currentBarTime = barTime;
                    } else if (!currentBarTime) currentBarTime = barTime;

                    // Only output to console, no marker creation
                    if (window.currentActivePair === pair) {
                        console.log(`%c${side === 'buy' ? 'LONG' : 'SHORT'} LIQUIDATION: $${value.toLocaleString()}`,
                            `color: ${side === 'buy' ? '#FF5555' : '#00FFFF'}; font-weight: bold`);
                    }
                },
                checkForCandleClose: t => {
                    const ct = Math.floor(t / 1000);
                    const cbt = Math.floor(ct / barInterval) * barInterval;
                    if (currentBarTime && cbt > currentBarTime) {
                        currentBarTime = cbt;
                    }
                },
                cleanup: () => {
                    currentBarTime = null;
                },
                isActiveFn: () => {
                    try {
                        if (!priceSeries || priceSeries._internal_isDisposed) return false;
                        priceSeries.priceScale();
                        return true;
                    } catch (e) { return false; }
                }
            };
            const intervalId = setInterval(() => m.checkForCandleClose(Date.now()), Math.min(barInterval * 1000 / 4, 15000));
            const unsubscribe = window.eventBus?.subscribe(`liquidation-${pair}`, d => m.isActiveFn() && m.addLiquidation(d));
            m.destroy = () => {
                clearInterval(intervalId);
                unsubscribe?.();
                m.cleanup();
            };
            return m;
        }
    };

    const MAX_VISIBLE_WHALE_ALERTS = 50;
    window.chartWhaleAlerts = {
        createManager: ({ pair, priceSeries, barInterval, findBarFn }) => {
            if (!priceSeries) return null;
            let currentBarTime = null;
            let dollarThreshold = localStorage.getItem("whaleAlertThreshold") ? parseFloat(localStorage.getItem("whaleAlertThreshold")) : 100000;
            const m = {
                dollarThreshold,
                pair,
                priceSeries,
                barInterval,
                findBarFn,
                addWhaleAlert: trade => {
                    if (!trade?.price || !trade.amount || !trade.side) return;
                    const { price, amount, side, timestamp } = trade;
                    const value = price * amount;
                    if (value < m.dollarThreshold || !m.isActiveFn() || window.currentActivePair !== m.pair) return;

                    const barTime = Math.floor(timestamp / barInterval) * barInterval;
                    const bar = findBarFn(barTime);
                    if (!bar) return;
                    if (currentBarTime && barTime > currentBarTime) {
                        currentBarTime = barTime;
                    } else if (!currentBarTime) currentBarTime = barTime;

                    // Only output to console, no marker creation
                    // (console.log removed to prevent duplicate whale alerts; now handled directly in wsmanager.js)
                },
                checkForCandleClose: t => {
                    const ct = Math.floor(t / 1000);
                    const cbt = Math.floor(ct / barInterval) * barInterval;
                    if (currentBarTime && cbt > currentBarTime) {
                        currentBarTime = cbt;
                    }
                },
                cleanup: () => {
                    currentBarTime = null;
                },
                isActiveFn: () => {
                    try {
                        if (!priceSeries || priceSeries._internal_isDisposed) return false;
                        priceSeries.priceScale();
                        return true;
                    } catch (e) { return false; }
                }
            };
            const intervalId = setInterval(() => m.checkForCandleClose(Date.now()), Math.min(barInterval * 1000 / 4, 15000));
            const unsubscribe = window.eventBus?.subscribe(`whale-alert-${pair}`, d => m.isActiveFn() && m.addWhaleAlert(d));
            m.destroy = () => {
                clearInterval(intervalId);
                unsubscribe?.();
                m.cleanup();
            };
            return m;
        }
    };

    window.chartOrderbook = {
        updateOrderBookLines: s => window.chartIndicators.orderbook.updateOrderBookLines(s),
        clearOrderBookLines: s => window.chartIndicators.orderbook.clearOrderBookLines(s),
        updateLastPrice: (s, p) => window.chartIndicators.orderbook.updateLastPrice(s, p),
        _processOrderBookUpdate: s => window.chartIndicators.orderbook.processOrderBookUpdate(s),
        _smoothPriceLevel: (t, p, v) => window.chartIndicators.orderbook.smoothPriceLevel(t, p, v),
        _cleanupSmoothPrices: () => window.chartIndicators.orderbook.cleanupSmoothPrices()
    };
})();
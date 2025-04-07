// Static configurations
const CONFIG = {
    barInterval: 300,
    maxBars: 2000,
    futureBars: 20,
    emaPeriod: 180,
    sdPeriod: 1440,
    cacheTTL: 5 * 60 * 1000,
};

const PAIRS = ['BTC', 'ETH', 'LTC', 'SOL'];

// Initialize WebSocket manager if not present
if (!window.bybitWsManager) {
    console.warn('Bybit WebSocket manager not found, creating fallback');
    window.bybitWsManager = new WebSocketManager(
        'wss://stream.bybit.com/v5/public/linear',
        'bybit',
        { name: 'charts-bybit', reconnectDelay: 5000 }
    );
}

// Main IIFE wrapped in Promise
Promise.resolve((async () => {
    // DOM caching
    const domCache = new Map();
    const cacheDOMElements = () => {
        const container = document.querySelector('.chart-container');
        if (container) {
            domCache.set('container', container);
            domCache.set('overlay', container.querySelector('.loading-overlay'));
            domCache.set('priceTitle', container.querySelector('.price-title'));
            domCache.set('priceChartContainer', container.querySelector('.price-chart-container'));
            domCache.set('buttons', Array.from(container.querySelectorAll('.pair-button')));
        }
    };
    cacheDOMElements();

    // Error handling
    const handleError = (message, error, overlay) => {
        console.error(`${message}: ${error.message}`, error.stack);
        if (overlay) overlay.textContent = `${message}: ${error.message}`;
    };

    // Integrated systems
    const chartOrderbook = window.chartOrderbook;
    const chartLiquidations = window.chartLiquidations;

    // Event bus initialization
    if (!window.eventBus) {
        window.eventBus = {
            events: {},
            subscribe: (event, callback) => {
                window.eventBus.events[event] = window.eventBus.events[event] || [];
                window.eventBus.events[event].push(callback);
                return () => window.eventBus.events[event] = window.eventBus.events[event].filter(cb => cb !== callback);
            },
            publish: (event, data) => {
                if (window.eventBus.events[event]) {
                    window.eventBus.events[event].forEach(callback => callback(data));
                }
            },
            liquidationsInitialized: false,
            initLiquidations: () => {
                if (window.eventBus.liquidationsInitialized) return;
                PAIRS.forEach(pair => {
                    window.addEventListener(`liquidation-${pair}`, (event) => {
                        if (event.detail) window.eventBus.publish(`liquidation-${pair}`, event.detail);
                    });
                });
                window.eventBus.liquidationsInitialized = true;
            }
        };
        window.eventBus.initLiquidations();
    }

    // Chart indicators fallback
    window.chartIndicators = window.chartIndicators || {
        calculateBands: ({ priceData }) => ({ t1: 0, t2: 0, b1: 0, b2: 0, time: 0 }),
        calculateVTWAP: (bar, caches) => ({ vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN, caches }),
        calculateLiqs: () => ({ liqsData: [], liqsRaw: [], perpD: [{ value: 0 }], spotD: [{ value: 0 }] }),
        utils: { initStdDevCache: () => ({ count: 0, mean: 0, m2: 0 }) }
    };

    // Wait for LightweightCharts
    const waitForLightweightCharts = () => {
        return new Promise((resolve, reject) => {
            const maxAttempts = 50;
            let attempts = 0;
            const check = () => {
                if (window.LightweightCharts) resolve();
                else if (attempts++ < maxAttempts) setTimeout(check, 100);
                else reject(new Error('LightweightCharts failed to load after timeout'));
            };
            check();
        });
    };

    try {
        await waitForLightweightCharts();
    } catch (error) {
        handleError('LightweightCharts not loaded', error, domCache.get('overlay'));
        return;
    }

    // Utility functions
    const utils = {
        throttle: (fn, limit) => {
            let timeout;
            const throttledFn = (...args) => {
                if (!timeout) {
                    timeout = setTimeout(() => {
                        fn(...args);
                        timeout = null;
                    }, limit);
                }
            };
            throttledFn.clear = () => {
                if (timeout) clearTimeout(timeout);
                timeout = null;
            };
            return throttledFn;
        },
        debounce: (fn, delay) => {
            let timeout;
            return (...args) => {
                clearTimeout(timeout);
                timeout = setTimeout(() => fn(...args), delay);
            };
        },
        getTopLargeOrders: (orders, n) => {
            return orders
                .map(([price, volume]) => ({ price, volume, dollarValue: price * volume }))
                .sort((a, b) => b.dollarValue - a.dollarValue)
                .slice(0, n);
        }
    };

    // Fetch with retry
    const fetchWithRetry = async (url, retries = 3) => {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                return await res.json();
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    };

    // Bitstamp historical data fetch
    const fetchBitstampHistoricalData = async (pair, interval, totalLimit = 2000) => {
        const cacheKey = `${pair}_historical_${interval}_${totalLimit}`;
        const cached = localStorage.getItem(cacheKey);

        if (cached) {
            try {
                const { timestamp, data } = JSON.parse(cached);
                if (Date.now() - timestamp < CONFIG.cacheTTL && data.length >= totalLimit * 0.9) {
                    return data.map(bar => ({
                        time: bar.t,
                        open: bar.o,
                        high: bar.h,
                        low: bar.l,
                        close: bar.c,
                        volume: bar.v
                    }));
                }
            } catch (e) {
                console.warn("Cache parsing error:", e);
                localStorage.removeItem(cacheKey);
            }
        }

        try {
            const maxApiLimit = 1000;
            let allBars = [];
            const url = `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${interval}&limit=${maxApiLimit}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            if (!data?.data?.ohlc) throw new Error('Invalid data format from Bitstamp API');

            const bars = data.data.ohlc.map(bar => ({
                time: parseInt(bar.timestamp, 10),
                open: parseFloat(bar.open),
                high: parseFloat(bar.high),
                low: parseFloat(bar.low),
                close: parseFloat(bar.close),
                volume: parseFloat(bar.volume)
            }));

            allBars = bars;

            if (bars.length > 0) {
                const earliestTime = Math.min(...bars.map(b => b.time));
                const secondUrl = `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${interval}&limit=${maxApiLimit}&end=${earliestTime - interval}`;
                try {
                    const olderResponse = await fetch(secondUrl);
                    if (olderResponse.ok) {
                        const olderData = await olderResponse.json();
                        if (olderData?.data?.ohlc) {
                            const olderBars = olderData.data.ohlc.map(bar => ({
                                time: parseInt(bar.timestamp, 10),
                                open: parseFloat(bar.open),
                                high: parseFloat(bar.high),
                                low: parseFloat(bar.low),
                                close: parseFloat(bar.close),
                                volume: parseFloat(bar.volume)
                            }));
                            const existingTimes = new Set(allBars.map(bar => bar.time));
                            const uniqueOlderBars = olderBars.filter(bar => !existingTimes.has(bar.time));
                            allBars = [...allBars, ...uniqueOlderBars];
                        }
                    }
                } catch (e) {
                    console.warn("Second request failed:", e);
                }
            }

            allBars.sort((a, b) => a.time - b.time);
            if (allBars.length > totalLimit) allBars = allBars.slice(-totalLimit);

            const compressedData = allBars.map(bar => ({
                t: bar.time,
                o: bar.open,
                h: bar.high,
                l: bar.low,
                c: bar.close,
                v: bar.volume
            }));

            try {
                localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data: compressedData }));
            } catch (e) {
                console.warn("Cache storage error:", e);
            }

            return allBars;
        } catch (error) {
            handleError(`Error fetching data for ${pair}`, error);
            if (cached) {
                try {
                    const { data } = JSON.parse(cached);
                    console.warn(`Using expired cache for ${pair}`);
                    return data.map(bar => ({ time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
                } catch (e) {
                    throw new Error(`No valid data available for ${pair}; fetch and cache failed`);
                }
            }
            throw error;
        }
    };

    // Bybit historical data fetch (minimal)
    const fetchBybitHistoricalData = async symbol => {
        const now = Math.floor(Date.now() / 1000);
        return [{ time: now - CONFIG.barInterval, open: 0, high: 0, low: 0, close: 0, volume: 0 }];
    };

    // Fetch pair data
    const fetchPairData = async pair => {
        const [bitstampData, bybitData] = await Promise.all([
            fetchBitstampHistoricalData(`${pair.toLowerCase()}usd`, CONFIG.barInterval, CONFIG.maxBars),
            fetchBybitHistoricalData(pair)
        ]);
        return { pair, bitstampData, bybitData };
    };

    // Pre-calculate data
    const preCalculateData = async (pair, overlay) => {
        overlay.textContent = `Fetching ${pair} historical data...`;

        try {
            const bitstampPair = `${pair.toLowerCase()}usd`;
            const priceData = await fetchBitstampHistoricalData(bitstampPair, CONFIG.barInterval);
            const bybitData = await fetchBybitHistoricalData(pair);

            if (!priceData.length) {
                overlay.textContent = `No price data available for ${pair}`;
                return null;
            }

            overlay.textContent = `Calculating ${pair} indicators...`;
            const indicatorResults = window.chartIndicators.calculateAllIndicators(priceData);

            const allTimes = [...new Set([...(bybitData?.map(d => d.time) || []), ...priceData.map(d => d.time)])].sort();
            const bybitMap = new Map(bybitData.map(d => [d.time, d]));
            const bitstampMap = new Map(priceData.map(d => [d.time, d]));

            let lastBybitClose = bybitData[0]?.close || 0;
            let lastBitstampClose = priceData[0]?.close || 0;

            const aligned = allTimes.map(time => {
                const bybit = bybitMap.get(time) || {
                    time,
                    open: lastBybitClose,
                    high: lastBybitClose,
                    low: lastBybitClose,
                    close: lastBybitClose,
                    volume: 0
                };
                const bitstamp = bitstampMap.get(time) || {
                    time,
                    open: lastBitstampClose,
                    high: lastBitstampClose,
                    low: lastBitstampClose,
                    close: lastBitstampClose,
                    volume: 0
                };
                lastBybitClose = bybit.close;
                lastBitstampClose = bitstamp.close;
                return { time, bybit, bitstamp };
            });

            const alignedBybit = aligned.map(d => d.bybit);
            const alignedBitstamp = aligned.map(d => d.bitstamp);

            const { liqsData, liqsRaw, perpD, spotD } = window.chartIndicators.calculateLiqs(alignedBybit, alignedBitstamp, CONFIG.sdPeriod);

            return {
                priceData,
                bands: indicatorResults.bands,
                vwap: indicatorResults.vwap,
                vwapData: indicatorResults.vwapData,
                emaBands: indicatorResults.emaBands,
                caches: indicatorResults.caches,
                liqsData,
                liqsRawWindow: liqsRaw.slice(-CONFIG.sdPeriod),
                sums: { perpSum: perpD[perpD.length - 1].value, spotSum: spotD[spotD.length - 1].value },
                alignedBybit,
                alignedBitstamp,
                timing: { firstTime: allTimes[0], lastTime: allTimes[allTimes.length - 1] }
            };
        } catch (error) {
            handleError(`Error pre-calculating data for ${pair}`, error, overlay);
            return null;
        }
    };

    // Chart and meter initialization
    const initializeChartAndMeter = (container, data, pair) => {
        const overlay = domCache.get('overlay');
        overlay.textContent = `Initializing ${pair} chart...`;

        if (!data || !data.priceData || !data.priceData.length) {
            overlay.textContent = `Failed to load ${pair} data`;
            overlay.style.display = 'block';
            return null;
        }

        const priceChartContainer = domCache.get('priceChartContainer');
        if (priceChartContainer) priceChartContainer.style.height = '100%';

        const chartConfig = {
            ...CONFIG,
            ticker: {
                symbol: pair,
                bitstampOrderBook: `order_book_${pair.toLowerCase()}usd`,
                bitstampTrades: `live_trades_${pair.toLowerCase()}usd`,
                bybitTrades: `publicTrade.${pair.toUpperCase()}USDT`
            }
        };

        const priceChart = LightweightCharts.createChart(container.querySelector('.price-chart'), {
            width: priceChartContainer?.clientWidth || container.clientWidth,
            height: priceChartContainer?.clientHeight || container.clientHeight,
            layout: { background: { color: '#161b22' }, textColor: '#D3D3D3', fontSize: 10 },
            grid: { vertLines: { visible: false }, horzLines: { visible: false } },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2A2A2A', lockVisibleTimeRangeOnResize: true },
            rightPriceScale: { borderColor: '#2A2A2A', autoScale: true }
        });

        const priceSeries = priceChart.addCandlestickSeries({
            upColor: '#AAAAAA',
            downColor: '#AAAAAA',
            borderColor: '#AAAAAA',
            wickUpColor: '#AAAAAA',
            wickDownColor: '#AAAAAA'
        });

        const fallbackData = {
            priceData: [],
            bands: { t1: 0, t2: 0, b1: 0, b2: 0, time: 0 },
            vwap: { vwapValue: 0, upperBand: 0, lowerBand: 0, upperMidline: 0, lowerMidline: 0 },
            emaBands: { ema: 0, upper: 0, lower: 0, time: 0 },
            liqsData: [{ time: Math.floor(Date.now() / 1000), value: 0 }],
            liqsRawWindow: [],
            sums: { perpSum: 0, spotSum: 0 },
            alignedBybit: [],
            alignedBitstamp: [],
            timing: { firstTime: Math.floor(Date.now() / 1000), lastTime: Math.floor(Date.now() / 1000) }
        };

        const effectiveData = data || fallbackData;
        const priceLines = {
            b2Upper: priceSeries.createPriceLine({ price: effectiveData.bands.t2, color: '#555555', lineWidth: 1, title: '2σMR' }),
            b1Upper: priceSeries.createPriceLine({ price: effectiveData.bands.t1, color: '#555555', lineWidth: 1, title: '1σMR' }),
            b1Lower: priceSeries.createPriceLine({ price: effectiveData.bands.b1, color: '#555555', lineWidth: 1, title: '1σMR' }),
            b2Lower: priceSeries.createPriceLine({ price: effectiveData.bands.b2, color: '#555555', lineWidth: 1, title: '2σMR' }),
            stdPlus2: priceSeries.createPriceLine({ price: effectiveData.vwap.upperBand, color: '#555555', lineWidth: 1, title: 'std+2' }),
            stdPlus1: priceSeries.createPriceLine({ price: effectiveData.vwap.upperMidline, color: '#555555', lineWidth: 1, title: 'std+1' }),
            vwap: priceSeries.createPriceLine({ price: effectiveData.vwap.vwapValue, color: '#555555', lineWidth: 1, title: 'vwap' }),
            stdMinus1: priceSeries.createPriceLine({ price: effectiveData.vwap.lowerMidline, color: '#555555', lineWidth: 1, title: 'std-1' }),
            stdMinus2: priceSeries.createPriceLine({ price: effectiveData.vwap.lowerBand, color: '#555555', lineWidth: 1, title: 'std-2' })
        };

        priceSeries.setData(effectiveData.priceData);
        const fullRange = effectiveData.timing.lastTime + (CONFIG.barInterval * CONFIG.futureBars) - effectiveData.timing.firstTime;
        const halfRange = fullRange / 2;
        const midPoint = effectiveData.timing.lastTime - halfRange / 2;
        priceChart.timeScale().setVisibleRange({
            from: midPoint - halfRange / 2,
            to: midPoint + halfRange / 2
        });

        const state = {
            chart: { priceChart, priceSeries, priceLines },
            config: chartConfig,
            data: {
                priceData: effectiveData.priceData,
                alignedBybit: effectiveData.alignedBybit,
                alignedBitstamp: effectiveData.alignedBitstamp,
                orderBook: { bids: [], asks: [] }
            },
            caches: effectiveData.caches || {
                twapCache: { priceVolume: 0, totalVolume: 0, value: 0 },
                vwapCache: { priceVolume: 0, totalVolume: 0, anchor: null },
                stdDevCache: utils.initStdDevCache(),
                vwapActive: false
            },
            sums: effectiveData.sums || { perpSum: 0, spotSum: 0 },
            liqs: { liqsRawWindow: effectiveData.liqsRawWindow || [] },
            timing: {
                firstTime: effectiveData.timing.firstTime,
                lastTime: effectiveData.timing.lastTime,
                lastPriceUpdateTime: effectiveData.timing.lastTime
            },
            currentBars: {
                currentBarBitstamp: effectiveData.priceData[effectiveData.priceData.length - 1] ?
                    { ...effectiveData.priceData[effectiveData.priceData.length - 1] } :
                    { time: Math.floor(Date.now() / 1000 / CONFIG.barInterval) * CONFIG.barInterval, open: null, high: null, low: null, close: null, volume: 0 },
                currentBarBybit: effectiveData.alignedBybit[effectiveData.alignedBybit.length - 1] ?
                    { ...effectiveData.alignedBybit[effectiveData.alignedBybit.length - 1] } :
                    { time: Math.floor(Date.now() / 1000 / CONFIG.barInterval) * CONFIG.barInterval, open: null, high: null, low: null, close: null, volume: 0 }
            },
            readiness: { isBitstampReady: false, isBybitReady: false },
            isActive: true,
            throttledFunctions: {
                throttledPriceUpdate: function(bar) {
                    if (!state.isActive) return;
                    const lastBar = state.data.priceData[state.data.priceData.length - 1];
                    if (!lastBar || bar.time >= lastBar.time) {
                        if (!lastBar || bar.time > lastBar.time) {
                            state.data.priceData.push(bar);
                            if (state.data.priceData.length > CONFIG.maxBars) state.data.priceData.shift();
                            try {
                                priceSeries.update(bar);
                                if (state.liquidationManager && state.liquidationManager.checkForCandleClose) {
                                    state.liquidationManager.checkForCandleClose(bar.time * 1000);
                                }
                                if (Math.random() < 0.1) memoryManagement.cleanupHistoricalData(state);
                            } catch (e) {
                                console.error(`Error updating new bar at ${bar.time}: ${e.message}`);
                            }
                        }
                    }
                },
                throttledCloseUpdate: function(bar) {
                    if (!state.isActive) return;
                    const lastBar = state.data.priceData[state.data.priceData.length - 1];
                    if (lastBar && bar.time === lastBar.time) {
                        lastBar.close = bar.close;
                        try {
                            priceSeries.update(lastBar);
                            if (state.liquidationManager && state.liquidationManager.checkForCandleClose) {
                                state.liquidationManager.checkForCandleClose(Date.now());
                            }
                            if (state.config.ticker.symbol === currentPair) {
                                updateTabTitle(state.config.ticker.symbol, bar.close);
                            }
                        } catch (e) {
                            console.error(`Error updating close at ${lastBar.time}: ${e.message}`);
                        }
                    }
                },
                updateOrderBook: (state) => {
                    if (chartOrderbook?.updateOrderBookLines && state.data.orderBook.bids.length && state.data.orderBook.asks.length) {
                        chartOrderbook.updateOrderBookLines(state);
                    }
                },
                throttledMeterUpdate: utils.throttle(() => {}, 200),
                updateEMABands: function() {
                    if (!state.isActive || !state.data.priceData.length) return;
                    if (window.chartIndicators?.calculateEMABands) {
                        const emaBands = window.chartIndicators.calculateEMABands(state.data.priceData);
                        state.data.emaBands = emaBands;
                        if (state.chart.priceLines.ema) {
                            state.chart.priceLines.ema.applyOptions({ price: emaBands.ema });
                            state.chart.priceLines.emaUpper.applyOptions({ price: emaBands.upper });
                            state.chart.priceLines.emaLower.applyOptions({ price: emaBands.lower });
                        }
                    }
                }
            },
            largeOrderLines: []
        };

        if (chartLiquidations?.createManager) {
            try {
                state.liquidationManager = chartLiquidations.createManager({
                    pair,
                    priceSeries,
                    barInterval: CONFIG.barInterval,
                    findBarFn: (timestamp) => {
                        try {
                            const currentTime = Math.floor(Date.now() / 1000);
                            const currentBarTime = Math.floor(currentTime / CONFIG.barInterval) * CONFIG.barInterval;
                            if (timestamp === currentBarTime && state.currentBars?.currentBarBitstamp) {
                                return state.currentBars.currentBarBitstamp;
                            }
                            
                            // Check if price series is still valid
                            if (!priceSeries || typeof priceSeries.data !== 'function') {
                                return null;
                            }
                            
                            const data = priceSeries.data();
                            return data?.length ? data.find(bar => bar.time === timestamp) : null;
                        } catch (e) {
                            console.debug('Error finding bar, price series may be disposed:', e.message);
                            return null;
                        }
                    }
                });
                // Remove this console.log message
                // console.log(`Liquidation manager created for ${pair}`);
            } catch (error) {
                handleError(`Error creating liquidation manager for ${pair}`, error);
                state.liquidationManager = { 
                    addLiquidation: () => {}, 
                    isActiveFn: () => false,
                    checkForCandleClose: () => {},
                    cleanup: () => {},
                    destroy: () => {}
                };
            }
        } else {
            console.warn(`chartLiquidations not available for ${pair}`);
            state.liquidationManager = { processLiquidation: (liq) => console.log(`Dummy liquidation handler for ${pair}:`, liq), isActiveFn: () => false };
        }

        overlay.style.display = 'none';
        return state;
    };

    // WebSocket message handling
    const messageQueue = {
        add: (source, data) => {
            const state = chartStates.get(currentPair);
            if (state) handleWebSocketMessage(data, source, state);
        }
    };

    function handleWebSocketMessage(message, source, chartState) {
        if (!chartState?.config?.ticker) return;
        const pair = chartState.config.ticker.symbol;
        try {
            if (source === 'bitstamp') handleBitstampMessage(message, chartState, pair);
            else if (source === 'bybit') handleBybitMessage(message, chartState, pair);
        } catch (error) {
            handleError(`WebSocket handler error (${source})`, error);
        }
    }

    const updateLargeOrderLines = (state) => {
        if (!state.isActive) return;
        chartOrderbook?.updateOrderBookLines(state);
    };

    function checkReadyState(state) {
        if (!state?.config?.ticker) {
            console.warn('Invalid state object in checkReadyState');
            return;
        }
        if (state.readiness.isBitstampReady) {
            const overlay = domCache.get('overlay');
            if (overlay) overlay.style.display = 'none';
            if (!state.isInitialized) {
                initializeChart(state);
                state.isInitialized = true;
            }
        }
    }

    const subscribePair = (pair) => {
        const state = chartStates.get(pair);
        if (state?.isSubscribed) return;

        const lowerPair = pair.toLowerCase();
        const orderBookChannel = `order_book_${lowerPair}usd`;
        const tradesChannel = `live_trades_${lowerPair}usd`;
        const bybitLiquidationChannel = `liquidation.${pair.toUpperCase()}USDT`;

        window.bitstampWsManager.subscribe(orderBookChannel, (data) => {
            const state = chartStates.get(currentPair);
            if (!state || !state.isActive || pair !== currentPair) return;
            messageQueue.add('bitstamp', data);
        });

        window.bitstampWsManager.subscribe(tradesChannel, (data) => {
            const state = chartStates.get(currentPair);
            if (!state || !state.isActive || pair !== currentPair) return;
            messageQueue.add('bitstamp', data);
        });

        if (window.bybitWsManager) {
            window.bybitWsManager.subscribe(bybitLiquidationChannel, (data) => {
                if (!data || !data.data) return;
                try {
                    const liquidations = Array.isArray(data.data) ? data.data : [data.data];
                    liquidations.forEach(liq => {
                        window.eventBus.publish(`liquidation-${pair}`, {
                            price: parseFloat(liq.price),
                            amount: parseFloat(liq.size || liq.qty),
                            side: liq.side.toLowerCase(),
                            timestamp: Math.floor(Date.now() / 1000)
                        });
                    });
                } catch (error) {
                    console.error(`Error processing liquidation for ${pair}:`, error);
                }
            });
        }

        if (state) state.isSubscribed = true;
    };

    const unsubscribePair = (pair) => {
        const lowerPair = pair.toLowerCase();
        const orderBookChannel = `order_book_${lowerPair}usd`;
        const tradesChannel = `live_trades_${lowerPair}usd`;

        window.bitstampWsManager.unsubscribe(orderBookChannel);
        window.bitstampWsManager.unsubscribe(tradesChannel);

        const state = chartStates.get(pair);
        if (state) {
            state.isSubscribed = false;
            chartOrderbook?.clearOrderBookLines(state);
        }
    };

    function handleBitstampMessage(message, chartState, pair) {
        if (message.channel === `live_trades_${pair.toLowerCase()}usd` && message.data) {
            const price = parseFloat(message.data.price);
            const volume = parseFloat(message.data.amount);
            const type = message.data.type;
            if (!Number.isFinite(price) || !Number.isFinite(volume)) return;

            updateTabTitle(pair, price);
            directUpdatePriceData(chartState, price, volume, type);
        }

        if (message.channel === `order_book_${pair.toLowerCase()}usd` && message.data?.bids && message.data?.asks) {
            if (chartState.data?.orderBook) {
                chartState.data.orderBook.bids = message.data.bids.map(([price, volume]) => [parseFloat(price), parseFloat(volume)]);
                chartState.data.orderBook.asks = message.data.asks.map(([price, volume]) => [parseFloat(price), parseFloat(volume)]);
                chartOrderbook?.updateOrderBookLines(chartState);
            }
        }
    }

    function handleBybitMessage(message, chartState, pair) {
        if (!message || !message.topic) return;

        if (message.topic.startsWith('liquidation.')) {
            if (chartState.liquidationManager && message.data) {
                const liquidations = Array.isArray(message.data) ? message.data : [message.data];
                liquidations.forEach(liq => {
                    chartState.liquidationManager.addLiquidation({
                        price: parseFloat(liq.price),
                        amount: parseFloat(liq.size || liq.qty),
                        side: liq.side.toLowerCase(),
                        timestamp: Math.floor(Date.now() / 1000)
                    });
                    updateLiquidation(
                        chartState,
                        liq.side.toLowerCase() === 'buy' ? 0 : 1,
                        parseFloat(liq.price),
                        parseFloat(liq.size || liq.qty)
                    );
                });
            }
        }
    }

    function updateLiquidation(state, type, price, volume) {
        const signedVolume = type === 0 ? volume : -volume;
        state.metrics.liquidations += signedVolume;
        state.metrics.liquidationsMin = Math.min(state.metrics.liquidationsMin, state.metrics.liquidations);
        state.metrics.liquidationsMax = Math.max(state.metrics.liquidationsMax, state.metrics.liquidations);
        state.throttledFunctions.updateMetrics();
    }

    function updateSpotPressure(state, type, price, volume) {
        if (!state.data.orderBook?.bids.length || !state.data.orderBook?.asks.length) return;
        const bestBid = state.data.orderBook.bids[0][0];
        const bestAsk = state.data.orderBook.asks[0][0];
        const midPrice = (bestBid + bestAsk) / 2;
        const signedVolume = type === 0 ? volume : -volume;
        const deviation = Math.abs(price - midPrice) / midPrice;
        const impact = signedVolume * (1 + state.config.metrics.deviationWeight * deviation);
        state.metrics.spotPressure += impact;
        state.metrics.spotPressureMin = Math.min(state.metrics.spotPressureMin, state.metrics.spotPressure);
        state.metrics.spotPressureMax = Math.max(state.metrics.spotPressureMax, state.metrics.spotPressure);
        state.throttledFunctions.updateMetrics();
    }

    function updatePriceData(state, price, volume, type) {
        if (!state?.isActive) return;
        directUpdatePriceData(state, price, volume, type);
        chartOrderbook?.updateLastPrice(state.config.ticker.symbol, price);
    }

    const updateTabTitle = (pair, price) => {
        if (pair === currentPair) document.title = `${pair} $${price.toFixed(2)} | Crypto Dashboard`;
    };

    // Memory management
    const memoryManager = window.MemoryManager || null;
    const memoryManagement = {
        cleanupInterval: 60000,
        lastCleanup: Date.now(),
        cleanupHistoricalData: (state) => {
            if (!state || Date.now() - memoryManagement.lastCleanup < memoryManagement.cleanupInterval) return;
            memoryManagement.lastCleanup = Date.now();

            try {
                if (memoryManager) {
                    memoryManager.performCleanup([
                        { type: 'array', array: state.data.priceData, maxSize: CONFIG.maxBars },
                        { type: 'array', array: state.data.alignedBybit, maxSize: Math.floor(CONFIG.maxBars * 0.8) },
                        { type: 'array', array: state.data.alignedBitstamp, maxSize: Math.floor(CONFIG.maxBars * 0.8) }
                    ], () => {
                        console.debug(`Memory cleanup: Price data size: ${state.data.priceData?.length || 0}`);
                    });
                } else {
                    if (state.data.priceData?.length > CONFIG.maxBars * 1.2) {
                        state.data.priceData.splice(0, state.data.priceData.length - CONFIG.maxBars);
                    }
                    if (state.data.alignedBybit?.length > CONFIG.maxBars) {
                        state.data.alignedBybit.splice(0, state.data.alignedBybit.length - CONFIG.maxBars);
                    }
                    if (state.data.alignedBitstamp?.length > CONFIG.maxBars) {
                        state.data.alignedBitstamp.splice(0, state.data.alignedBitstamp.length - CONFIG.maxBars);
                    }
                    if (state.oldData) state.oldData = null;
                    console.debug(`Memory cleanup: Price data size: ${state.data.priceData.length}`);
                }
            } catch (error) {
                handleError('Error during memory cleanup', error);
            }
        }
    };

    // Main execution
    const chartStates = new Map();
    window.chartStates = chartStates;
    let currentPair = 'BTC';
    window.currentPair = currentPair;
    window.currentActivePair = currentPair; // Add this line to expose it globally
    let isInitializing = false;

    const updateSize = () => {
        const currentState = chartStates.get(currentPair);
        if (currentState?.chart.priceChart && currentState.isActive) {
            const priceChartContainer = domCache.get('priceChartContainer');
            if (priceChartContainer) {
                priceChartContainer.style.height = '100%';
                try {
                    currentState.chart.priceChart.resize(priceChartContainer.clientWidth, priceChartContainer.clientHeight);
                } catch (e) {
                    console.warn('Resize skipped due to disposed chart:', e.message);
                }
            }
        }
    };

    const resizeHandler = utils.debounce(updateSize, 200);

    const initializeChart = async () => {
        if (isInitializing) {
            console.log('Chart initialization already in progress');
            return;
        }
        isInitializing = true;

        const container = domCache.get('container');
        if (!container) {
            console.error('Chart container not found');
            isInitializing = false;
            return;
        }
        const overlay = domCache.get('overlay');

        try {
            const data = await preCalculateData('BTC', overlay);
            if (!data) throw new Error('No data for BTC');
            const state = initializeChartAndMeter(container, data, 'BTC');
            chartStates.set('BTC', state);
            domCache.get('priceTitle').textContent = 'BTCUSD';
            container.dataset.pair = 'BTC';

            window.addEventListener('resize', resizeHandler);
            subscribePair('BTC');
            isInitializing = false;
        } catch (error) {
            handleError('Error initializing chart', error, overlay);
            isInitializing = false;
        }
    };

    await initializeChart().catch(error => {
        handleError("Error in charts.js initializeChart", error, domCache.get('overlay'));
        domCache.get('overlay')?.setAttribute('textContent', 'Chart initialization failed');
    });

    initClearLiquidationsButton();

    const switchPairInternal = async (newPair) => {
        if (newPair === currentPair) return;
        const oldPair = currentPair;
        const container = domCache.get('container');
        const overlay = domCache.get('overlay');

        // Update the global variable
        window.currentActivePair = newPair;
        
        overlay.style.display = 'block';
        overlay.textContent = `Loading ${newPair} data...`;

        if (chartStates.has(oldPair)) {
            const oldState = chartStates.get(oldPair);
            oldState.isActive = false;
            chartOrderbook?.clearOrderBookLines(oldState);
            unsubscribePair(oldPair);
        }

        const data = await preCalculateData(newPair, overlay);
        if (!data) {
            overlay.textContent = `Failed to load data for ${newPair}`;
            return;
        }

        const currentState = chartStates.get(oldPair);
        if (currentState) {
            try {
                if (currentState.chart?.priceChart) {
                    currentState.chart.priceChart.remove();
                } else if (currentState.priceChart) {
                    currentState.priceChart.remove();
                } else if (currentState.chart) {
                    const chartElement = container.querySelector('.tv-lightweight-charts');
                    if (chartElement) chartElement.remove();
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (e) {
                console.warn(`Error removing chart for ${oldPair}:`, e.message);
                try {
                    const chartElement = container.querySelector('.tv-lightweight-charts');
                    if (chartElement) chartElement.remove();
                } catch (err) {
                    console.warn('Manual chart cleanup failed:', err.message);
                }
            }
            chartStates.delete(oldPair);
        }

        const state = initializeChartAndMeter(container, data, newPair);
        state.isActive = true;
        chartStates.set(newPair, state);
        domCache.get('priceTitle').textContent = `${newPair}USD`;
        container.dataset.pair = newPair;
        currentPair = newPair;
        window.currentPair = newPair;

        subscribePair(newPair);
        updateSize();
        initClearLiquidationsButton();
    };

    const switchPair = utils.debounce(switchPairInternal, 200);

    const buttons = domCache.get('buttons');
    if (!buttons?.length) {
        console.error('No pair-button elements found inside chart container');
        return;
    }
    buttons.forEach(button => {
        if (!button.dataset.pair) {
            console.warn(`Button "${button.textContent}" missing data-pair attribute`);
            return;
        }
        if (button.dataset.pair === 'BTC') button.classList.add('active');
        button.addEventListener('click', () => {
            buttons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            switchPair(button.dataset.pair);
        });
    });

    window.addEventListener('memory-pressure', (event) => {
        const pressureLevel = event.detail.level;
        chartStates.forEach(state => {
            if (state?.chart) {
                if (pressureLevel === 'critical') {
                    memoryManagement.cleanupHistoricalData(state);
                    chartOrderbook?.clearOrderBookLines(state);
                } else if (pressureLevel === 'high') {
                    memoryManagement.cleanupHistoricalData(state);
                    if (state.data.orderBook) {
                        state.data.orderBook.bids = state.data.orderBook.bids.slice(0, 100);
                        state.data.orderBook.asks = state.data.orderBook.asks.slice(0, 100);
                    }
                }
            }
        });
    });

    const cleanup = () => {
        window.removeEventListener('resize', resizeHandler);
        window.removeEventListener('memory-pressure', () => {});
        chartStates.forEach(state => {
            if (state.chart?.priceChart) state.chart.priceChart.remove();
            unsubscribePair(state.config.ticker.symbol);
        });
        chartStates.clear();
    };
    window.addEventListener('unload', cleanup);

})()).catch(error => {
    console.error("Global error in charts.js:", error);
    document.querySelectorAll('.loading-overlay').forEach(el => el.textContent = 'Chart initialization failed');
});

function directUpdatePriceData(state, price, volume, type) {
    if (!state?.isActive || !state.currentBars || !state.config) return;

    try {
        const now = Math.floor(Date.now() / 1000);
        const barInterval = state.config.barInterval || 300;
        const barTime = Math.floor(now / barInterval) * barInterval;

        if (!state.currentBars.currentBarBitstamp) {
            state.currentBars.currentBarBitstamp = { time: barTime, open: price, high: price, low: price, close: price, volume };
        } else if (state.currentBars.currentBarBitstamp.time < barTime) {
            state.data.priceData.push(state.currentBars.currentBarBitstamp);
            if (state.data.priceData.length > state.config.maxBars) state.data.priceData.shift();
            state.currentBars.currentBarBitstamp = { time: barTime, open: price, high: price, low: price, close: price, volume };
        } else {
            state.currentBars.currentBarBitstamp.close = price;
            state.currentBars.currentBarBitstamp.high = Math.max(state.currentBars.currentBarBitstamp.high, price);
            state.currentBars.currentBarBitstamp.low = Math.min(state.currentBars.currentBarBitstamp.low, price);
            state.currentBars.currentBarBitstamp.volume += volume;
        }

        if (state.chart?.priceSeries) state.chart.priceSeries.update(state.currentBars.currentBarBitstamp);

        if (state.liquidationManager && state.liquidationManager.checkForCandleClose) {
            state.liquidationManager.checkForCandleClose(Date.now());
        }

        if (!state.metrics) {
            state.metrics = {
                buyVolume: 0,
                sellVolume: 0,
                buyValue: 0,
                sellValue: 0,
                liquidations: 0,
                liquidationsMin: 0,
                liquidationsMax: 0,
                spotPressure: 0
            };
        }

        if (type !== undefined) {
            const isBuy = type === 0;
            const tradeValue = price * volume;
            if (isBuy) {
                state.metrics.buyVolume += volume;
                state.metrics.buyValue += tradeValue;
            } else {
                state.metrics.sellVolume += volume;
                state.metrics.sellValue += tradeValue;
            }
        }
    } catch (error) {
        console.error('Error in directUpdatePriceData:', error);
    }
}

function initClearLiquidationsButton() {
    console.log('Initializing liquidation controls');

    const existingControls = document.querySelector('.liq-controls');
    if (existingControls) existingControls.remove();

    const container = document.querySelector('.price-chart-container');
    if (!container) {
        console.error('Chart container not found, cannot create liquidation controls');
        return;
    }

    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'liq-controls';

    const clearButton = document.createElement('button');
    clearButton.id = 'clear-liquidations-btn';
    clearButton.className = 'clear-liq-btn';
    clearButton.textContent = 'Clear Liquidations';

    // Get saved threshold from localStorage or use default
    const savedThreshold = localStorage.getItem('liquidationThreshold');
    const defaultThreshold = savedThreshold ? parseFloat(savedThreshold) : 1000;

    const thresholdInput = document.createElement('input');
    thresholdInput.type = 'number';
    thresholdInput.min = '0';
    thresholdInput.step = '1000';
    thresholdInput.value = defaultThreshold.toString();
    thresholdInput.id = 'liq-threshold-input';
    thresholdInput.className = 'liq-threshold-input';
    thresholdInput.placeholder = 'Min $ value';

    // Apply the saved threshold to all existing liquidation managers
    if (window.chartStates) {
        window.chartStates.forEach(state => {
            if (state.liquidationManager) {
                state.liquidationManager.dollarThreshold = defaultThreshold;
            }
        });
    }

    const applyButton = document.createElement('button');
    applyButton.textContent = 'Apply';
    applyButton.className = 'liq-apply-btn';

    controlsContainer.appendChild(clearButton);
    controlsContainer.appendChild(thresholdInput);
    controlsContainer.appendChild(applyButton);
    container.appendChild(controlsContainer);

    clearButton.addEventListener('click', () => {
        console.log('Clear liquidations button clicked');
        if (window.chartStates && window.currentPair) {
            const currentState = window.chartStates.get(window.currentPair);
            if (currentState && currentState.liquidationManager) {
                try {
                    if (currentState.chart && currentState.chart.priceSeries) {
                        currentState.chart.priceSeries.setMarkers([]);
                        console.log(`Cleared liquidation markers for ${window.currentPair}`);
                    } else {
                        console.warn(`No price series found for ${window.currentPair}`);
                    }
                } catch (e) {
                    console.error('Error clearing liquidation markers:', e);
                }
            } else {
                console.warn(`No liquidation manager found for ${window.currentPair}`);
            }
        } else {
            console.error('Chart states or current pair not available in global scope');
        }
    });

    applyButton.addEventListener('click', applyLiquidationThreshold);
    thresholdInput.addEventListener('keyup', (event) => {
        if (event.key === 'Enter') applyLiquidationThreshold();
    });

    console.log('Liquidation controls created and initialized');
}

function applyLiquidationThreshold() {
    const thresholdInput = document.getElementById('liq-threshold-input');
    if (!thresholdInput) {
        console.warn('Liquidation threshold input not found');
        return;
    }

    const thresholdValue = parseFloat(thresholdInput.value) || 1000;
    console.log(`Setting liquidation threshold to $${thresholdValue}`);

    if (window.chartStates && window.currentPair) {
        const currentState = window.chartStates.get(window.currentPair);
        if (currentState && currentState.liquidationManager) {
            try {
                // Store the threshold in localStorage for persistence
                localStorage.setItem('liquidationThreshold', thresholdValue.toString());
                
                // Apply to current manager
                currentState.liquidationManager.dollarThreshold = thresholdValue;
                
                // Apply to all other active managers for consistency
                window.chartStates.forEach((state, pair) => {
                    if (state.liquidationManager && pair !== window.currentPair) {
                        state.liquidationManager.dollarThreshold = thresholdValue;
                    }
                });
                
                console.log(`Applied liquidation threshold of $${thresholdValue} to all charts`);
                thresholdInput.style.backgroundColor = 'rgba(0, 100, 0, 0.3)';
                setTimeout(() => thresholdInput.style.backgroundColor = '', 500);
            } catch (e) {
                console.error('Error applying liquidation threshold:', e);
                thresholdInput.style.backgroundColor = 'rgba(100, 0, 0, 0.3)';
                setTimeout(() => thresholdInput.style.backgroundColor = '', 500);
            }
        }
    }
}

// CSS for liquidation controls
document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
        .liq-controls {
            position: absolute;
            bottom: 10px;
            right: 10px;
            display: flex;
            gap: 5px;
            z-index: 100;
            background: rgba(30, 30, 30, 0.7);
            padding: 5px;
            border-radius: 4px;
        }
        .clear-liq-btn, .liq-apply-btn {
            background: #444;
            color: #fff;
            border: none;
            padding: 5px 10px;
            border-radius: 3px;
            cursor: pointer;
        }
        .clear-liq-btn:hover, .liq-apply-btn:hover {
            background: #555;
        }
        .liq-threshold-input {
            background: #333;
            color: #fff;
            border: 1px solid #555;
            padding: 4px;
            border-radius: 3px;
            width: 80px;
        }
    `;
    document.head.appendChild(style);
    setTimeout(initClearLiquidationsButton, 1000);
});

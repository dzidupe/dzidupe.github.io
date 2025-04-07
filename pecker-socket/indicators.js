// Initialize global chartIndicators object with fallback functions
window.chartIndicators = {
    calculateBands: ({ priceData }) => ({ t1: 0, t2: 0, b1: 0, b2: 0, time: 0 }),
    calculateVTWAP: (bar, caches) => ({
        vwapValue: NaN,
        upperBand: NaN,
        lowerBand: NaN,
        upperMidline: NaN,
        lowerMidline: NaN,
        caches
    }),
    calculateLiqs: () => ({
        liqsData: [],
        liqsRaw: [],
        perpD: [{ value: 0 }],
        spotD: [{ value: 0 }]
    }),
    utils: {
        initStdDevCache: () => ({ count: 0, mean: 0, m2: 0 })
    },
    calculateRSI: (prices, period = 14) => ({ values: [], lastValue: 0 }),
    calculateEMABands: (priceData, period = 20, multiplier = 2) => ({
        ema: 0,
        upper: 0,
        lower: 0,
        time: 0
    }),
    calculateAllIndicators: (priceData, options = {}) => ({
        bands: { t1: 0, t2: 0, b1: 0, b2: 0, time: 0 },
        vwap: { vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN },
        vwapData: [],
        emaBands: { ema: 0, upper: 0, lower: 0, time: 0 },
        caches: {
            twapCache: { priceSum: 0, count: 0, value: 0 },
            vwapCache: { priceVolume: 0, totalVolume: 0, anchor: null },
            stdDevCache: window.chartIndicators.utils.initStdDevCache(),
            vwapActive: false
        }
    }),
    orderbook: {
        lineCache: { bids: new Map(), asks: new Map() },
        smoothedPrices: { bids: new Map(), asks: new Map() },
        MAX_CACHE_SIZE: 1000,
        clearOrderBookLines: (state) => {
            if (!state?.chart?.priceSeries) return;
            try {
                const currentLines = state.currentLines || [];
                currentLines.forEach(line => {
                    try {
                        state.chart.priceSeries.removePriceLine(line);
                    } catch (e) {
                        console.warn('Error removing price line:', e);
                    }
                });
                state.currentLines = [];
            } catch (e) {
                console.debug('Chart disposed, cleared orderbook lines:', e.message);
                state.currentLines = [];
            }
        },
        updateOrderBookLines: (state) => {
            if (!state?.chart?.priceSeries || !state.isActive) return;
            state.currentLines = state.currentLines || [];
            window.chartIndicators.orderbook.processOrderBookUpdate(state);
        },
        smoothPriceLevel: (type, price, volume) => {
            const smoothedPrices = window.chartIndicators.orderbook.smoothedPrices;
            const key = price.toFixed(2);
            const now = Date.now();
            const existing = smoothedPrices[type].get(key);

            if (!existing) {
                smoothedPrices[type].set(key, { price, volume, lastSeen: now });
                return { price, volume, isNew: true };
            }

            existing.lastSeen = now;
            if (Math.abs(existing.volume - volume) / existing.volume > 0.1) {
                existing.volume = volume;
                return { price, volume, isUpdated: true };
            }
            return { price, volume: existing.volume, isStable: true };
        },
        cleanupSmoothPrices: () => {
            const { smoothedPrices, MAX_CACHE_SIZE } = window.chartIndicators.orderbook;
            const now = Date.now();
            const EXPIRY_TIME = 30000;

            ['bids', 'asks'].forEach(type => {
                for (const [key, data] of smoothedPrices[type]) {
                    if (now - data.lastSeen > EXPIRY_TIME) smoothedPrices[type].delete(key);
                }
                if (smoothedPrices[type].size > MAX_CACHE_SIZE) {
                    const entries = [...smoothedPrices[type]].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
                    entries.slice(0, entries.length - MAX_CACHE_SIZE).forEach(([key]) => smoothedPrices[type].delete(key));
                }
            });
        },
        processOrderBookUpdate: (state) => {
            try {
                if (!state.chart.priceSeries.priceScale()) return;
                const { bids, asks } = state.data.orderBook || { bids: [], asks: [] };
                if (!bids.length || !asks.length) return;

                const hashOrderBook = () => {
                    const topBids = bids.slice(0, 5);
                    const topAsks = asks.slice(0, 5);
                    return `${topBids.map(b => `${b[0]}:${b[1]}`).join('|')}#${topAsks.map(a => `${a[0]}:${a[1]}`).join('|')}`;
                };
                const currentHash = hashOrderBook();
                if (currentHash === state._lastOrderBookHash) return;
                state._lastOrderBookHash = currentHash;

                window.chartIndicators.orderbook.cleanupSmoothPrices();
                window.chartIndicators.orderbook.clearOrderBookLines(state);

                const lastPrice = state.data.priceData?.[state.data.priceData.length - 1]?.close || 0;
                if (!lastPrice) return;

                const processedBids = bids.map(([price, volume]) =>
                    window.chartIndicators.orderbook.smoothPriceLevel('bids', price, volume));
                const processedAsks = asks.map(([price, volume]) =>
                    window.chartIndicators.orderbook.smoothPriceLevel('asks', price, volume));

                const bidsByValue = [...processedBids].sort((a, b) => (b.price * b.volume) - (a.price * a.volume));
                const asksByValue = [...processedAsks].sort((a, b) => (b.price * b.volume) - (a.price * a.volume));

                const largestBids = bidsByValue.slice(0, 5);
                const largestAsks = asksByValue.slice(0, 5);

                largestBids.forEach(({ price, volume }, index) => {
                    try {
                        const maxVolume = largestBids[0].volume;
                        const lineWidth = Math.max(1, Math.round(Math.max(0.5, Math.min(1, volume / maxVolume)) * 2));
                        const dollarValue = (price * volume).toFixed(0);
                        const formattedValue = dollarValue >= 1000000 ? `$${(dollarValue / 1000000).toFixed(1)}M` : `$${(dollarValue / 1000).toFixed(0)}K`;
                        const bidLine = state.chart.priceSeries.createPriceLine({
                            price,
                            color: index === 0 ? '#00FFFF' : 'rgba(0, 255, 255, 0.4)',
                            lineWidth,
                            lineStyle: 0,
                            axisLabelVisible: index === 0,
                            title: index === 0 ? `BID ${formattedValue}` : ''
                        });
                        state.currentLines.push(bidLine);
                    } catch (e) {
                        console.warn('Error creating bid line:', e);
                    }
                });

                largestAsks.forEach(({ price, volume }, index) => {
                    try {
                        const maxVolume = largestAsks[0].volume;
                        const lineWidth = Math.max(1, Math.round(Math.max(0.5, Math.min(1, volume / maxVolume)) * 2));
                        const dollarValue = (price * volume).toFixed(0);
                        const formattedValue = dollarValue >= 1000000 ? `$${(dollarValue / 1000000).toFixed(1)}M` : `$${(dollarValue / 1000).toFixed(0)}K`;
                        const askLine = state.chart.priceSeries.createPriceLine({
                            price,
                            color: index === 0 ? '#FF5555' : 'rgba(255, 85, 85, 0.4)',
                            lineWidth,
                            lineStyle: 0,
                            axisLabelVisible: index === 0,
                            title: index === 0 ? `ASK ${formattedValue}` : ''
                        });
                        state.currentLines.push(askLine);
                    } catch (e) {
                        console.warn('Error creating ask line:', e);
                    }
                });
            } catch (error) {
                console.error("Error processing orderbook update:", error);
            }
        },
        updateLastPrice: (state, price) => {
            if (!state?.isActive || !state.data?.priceData?.length) return;
            const lastBar = state.data.priceData[state.data.priceData.length - 1];
            if (lastBar) lastBar.close = price;
            window.chartIndicators.orderbook.updateOrderBookLines(state);
        }
    }
};

// Chart liquidations system
const initChartLiquidations = () => {
    if (window.chartLiquidations) return window.chartLiquidations;

    const MAX_VISIBLE_LIQUIDATIONS = 50;

    const createManager = (options) => {
        const { pair, priceSeries, barInterval, findBarFn } = options;
        if (!priceSeries) {
            console.warn('Cannot create liquidation manager: missing priceSeries');
            return null;
        }

        let activeLiquidations = new Map();
        let currentBarTime = null;
        let dollarThreshold = 1000;

        const manager = {
            dollarThreshold,
            pair,
            priceSeries,
            barInterval,
            findBarFn,
            addLiquidation: (liq) => {
                if (!liq || !liq.price || !liq.amount || !liq.side) {
                    console.warn('Invalid liquidation data:', liq);
                    return;
                }

                const { price, amount, side, timestamp } = liq;
                const liquidationValue = price * amount;

                // Skip small liquidations silently without logging
                if (liquidationValue < manager.dollarThreshold) {
                    return;
                }

                // Check if price series is valid before proceeding
                try {
                    if (!manager.isActiveFn()) {
                        return;
                    }
                } catch (e) {
                    return;
                }

                // Skip liquidations for non-active charts silently
                const currentPair = window.currentActivePair;
                if (currentPair && manager.pair !== currentPair) {
                    return;
                }

                const barTime = Math.floor(timestamp / barInterval) * barInterval;
                const bar = findBarFn(barTime);

                if (!bar) {
                    return;
                }

                if (currentBarTime !== null && barTime > currentBarTime) {
                    manager.closePreviousCandleLiquidations();
                    currentBarTime = barTime;
                } else if (currentBarTime === null) {
                    currentBarTime = barTime;
                }

                const id = `liq-${pair}-${timestamp}-${Math.random().toString(36).slice(2, 9)}`;
                const color = side === 'buy' ? '#FF5555' : '#00FFFF';
                const size = Math.min(Math.max(Math.log10(amount) * 2, 1), 5);
                const dollarValue = (price * amount).toFixed(2);

                const marker = {
                    time: barTime,
                    position: side === 'sell' ? 'aboveBar' : 'belowBar',
                    color: side === 'sell' ? '#00FFFF' : '#FF5555',
                    shape: side === 'sell' ? 'arrowDown' : 'arrowUp',
                    size
                };

                try {
                    // Safely get current markers and set new ones
                    let currentMarkers;
                    try {
                        currentMarkers = priceSeries.markers() || [];
                    } catch (e) {
                        return;
                    }
                    
                    try {
                        priceSeries.setMarkers([...currentMarkers, marker]);
                        console.log(`Added liquidation marker for ${pair}: ${side} ${amount} @ ${price} ($${liquidationValue})`);
                        activeLiquidations.set(id, {
                            id,
                            price,
                            amount,
                            dollarValue: liquidationValue,
                            side,
                            marker,
                            time: barTime
                        });
                    } catch (e) {
                        console.warn('Error adding liquidation marker:', e);
                    }
                } catch (e) {
                    console.warn('Error in liquidation processing:', e);
                }
            },
            checkForCandleClose: (timestamp) => {
                const currentTime = Math.floor(timestamp / 1000);
                const currentBarTimeCheck = Math.floor(currentTime / barInterval) * barInterval;

                if (currentBarTime !== null && currentBarTimeCheck > currentBarTime) {
                    manager.closePreviousCandleLiquidations();
                    currentBarTime = currentBarTimeCheck;
                }
            },
            closePreviousCandleLiquidations: () => {
                if (activeLiquidations.size === 0) return;
                activeLiquidations.clear();
            },
            cleanup: () => {
                try {
                    try {
                        if (!priceSeries.markers()) {
                            console.debug('Price series appears to be invalid, skipping liquidation cleanup');
                            return;
                        }
                    } catch (e) {
                        console.debug('Price series is disposed, cannot clean up liquidations');
                        return;
                    }

                    activeLiquidations.clear();
                    currentBarTime = null;
                    priceSeries.setMarkers([]);
                    console.log('Liquidation markers cleared');
                } catch (e) {
                    console.error('Error in liquidation cleanup:', e);
                }
            },
            isActiveFn: () => {
                try {
                    // First check if the price series exists and is not disposed
                    const markers = priceSeries.markers();
                    return true;
                } catch (e) {
                    // If we get an error, the price series is likely disposed
                    return false;
                }
            }
        };

        const checkInterval = Math.min(barInterval * 1000 / 4, 15000);
        const intervalId = setInterval(() => {
            manager.checkForCandleClose(Date.now());
        }, checkInterval);

        const originalDestroy = manager.destroy || (() => {});
        manager.destroy = () => {
            clearInterval(intervalId);
            originalDestroy();
        };

        if (window.eventBus) {
            const unsubscribe = window.eventBus.subscribe(`liquidation-${pair}`, (data) => manager.addLiquidation(data));
            manager.destroy = () => {
                unsubscribe();
                manager.cleanup();
            };
        } else {
            manager.destroy = manager.cleanup;
        }

        return manager;
    };

    return { createManager };
};

window.chartLiquidations = window.chartLiquidations || initChartLiquidations();

// Indicator implementations
const calculateBands = ({ priceData, emaPeriod = 180, sdPeriod = 1440 }) => {
    if (!priceData?.length || priceData.length < emaPeriod) {
        return { t1: 0, t2: 0, b1: 0, b2: 0, time: priceData?.[priceData.length - 1]?.time || 0 };
    }

    const volumes = priceData.map(bar => bar.volume || 0);
    const highPrices = priceData.map(bar => bar.high);
    const lowPrices = priceData.map(bar => bar.low);

    const volumeMA = utils.ema(volumes, emaPeriod);
    const pvHigh = utils.ema(highPrices.map((p, i) => p * volumes[i]), emaPeriod);
    const pvLow = utils.ema(lowPrices.map((p, i) => p * volumes[i]), emaPeriod);
    const emaPVHigh = utils.ema(pvHigh, emaPeriod);
    const emaPVLow = utils.ema(pvLow, emaPeriod);
    const emaVolume = utils.ema(volumeMA, emaPeriod);

    const ma1 = emaPVHigh.map((pv, i) => emaVolume[i] ? pv / emaVolume[i] : 0);
    const ma2 = emaPVLow.map((pv, i) => emaVolume[i] ? pv / emaVolume[i] : 0);
    const p1 = highPrices.map((h, i) => ma1[i] ? (h - ma1[i]) / ma1[i] : 0);
    const p2 = lowPrices.map((l, i) => ma2[i] ? (l - ma2[i]) / ma2[i] : 0);

    const effectiveSdPeriod = Math.min(sdPeriod, priceData.length - emaPeriod);
    if (effectiveSdPeriod < 2) {
        return { t1: 0, t2: 0, b1: 0, b2: 0, time: priceData[priceData.length - 1].time };
    }

    const sd10 = utils.stdev(p1, effectiveSdPeriod);
    const sd20 = utils.stdev(p2, effectiveSdPeriod);
    const i = priceData.length - 1;

    return {
        t1: ma1[i] * (1 + (sd10[i] || 0) * 2.25),
        t2: ma1[i] * (1 + (sd10[i] || 0) * 4.25),
        b1: ma2[i] * (1 - (sd20[i] || 0) * 2.25),
        b2: ma2[i] * (1 - (sd20[i] || 0) * 4.25),
        time: priceData[i].time
    };
};

const calculateVTWAP = (bar, caches) => {
    if (!bar?.time) {
        return { vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN, caches };
    }

    const twapCache = caches.twapCache || { priceSum: 0, count: 0, value: 0 };
    const vwapCache = caches.vwapCache || { priceVolume: 0, totalVolume: 0, anchor: null };
    const stdDevCache = caches.stdDevCache || utils.initStdDevCache();

    const date = new Date(bar.time * 1000);
    const dayOfWeek = date.getUTCDay();
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const asiaSessionStart = dayOfWeek === 1 && hour === 0 && minute === 0;
    const nyOpen = dayOfWeek === 1 && hour === 13 && minute === 30;
    const inTwapSession = dayOfWeek === 1 && hour >= 0 && (hour < 13 || (hour === 13 && minute < 30));
    const showVwap = dayOfWeek > 1 || (dayOfWeek === 1 && (hour > 13 || (hour === 13 && minute >= 30)));

    if (asiaSessionStart) {
        twapCache.priceSum = 0;
        twapCache.count = 0;
        twapCache.value = 0;
        vwapCache.priceVolume = 0;
        vwapCache.totalVolume = 0;
        vwapCache.anchor = null;
        caches.vwapActive = false;
        caches.stdDevCache = utils.initStdDevCache();
    }

    let twapValue = bar.close;
    if (inTwapSession) {
        const ohlc4 = (bar.open + bar.high + bar.low + bar.close) / 4;
        twapCache.priceSum += ohlc4;
        twapCache.count += 1;
        twapValue = twapCache.priceSum / twapCache.count;
        twapCache.value = twapValue;
    } else if (twapCache.count > 0) {
        twapValue = twapCache.value;
    }

    if (nyOpen) {
        vwapCache.anchor = twapValue;
        caches.vwapActive = true;
    }

    let vwapValue = NaN;
    let upperBand = NaN;
    let lowerBand = NaN;
    let upperMidline = NaN;
    let lowerMidline = NaN;

    if (showVwap && vwapCache.anchor !== null && caches.vwapActive) {
        const hlc3 = (bar.high + bar.low + bar.close) / 3;
        if (nyOpen) {
            vwapCache.priceVolume = vwapCache.anchor * (bar.volume || 1);
            vwapCache.totalVolume = bar.volume || 1;
        } else {
            vwapCache.priceVolume += hlc3 * (bar.volume || 0);
            vwapCache.totalVolume += bar.volume || 0;
        }
        vwapValue = vwapCache.totalVolume > 0 ? vwapCache.priceVolume / vwapCache.totalVolume : hlc3;
        const stdDev = utils.updateStdDev(stdDevCache, hlc3);
        const multiplier = 2.5;
        upperBand = vwapValue + (multiplier * stdDev);
        lowerBand = vwapValue - (multiplier * stdDev);
        upperMidline = (vwapValue + upperBand) / 2;
        lowerMidline = (vwapValue + lowerBand) / 2;
    }

    caches.twapCache = twapCache;
    caches.vwapCache = vwapCache;
    return { vwapValue, upperBand, lowerBand, upperMidline, lowerMidline, caches };
};

const calculateEMABands = (priceData, period = 20, multiplier = 2) => {
    if (!priceData?.length) return { ema: 0, upper: 0, lower: 0, time: 0 };

    const prices = priceData.map(bar => bar.close);
    const ema = utils.ema(prices, period)[prices.length - 1] || 0;
    const stdDev = utils.stdev(prices, period)[prices.length - 1] || 0;

    return {
        ema,
        upper: ema + stdDev * multiplier,
        lower: ema - stdDev * multiplier,
        time: priceData[priceData.length - 1].time
    };
};

const calculateLiqs = (alignedBybit, alignedBitstamp, windowSize) => {
    return {
        liqsData: [],
        liqsRaw: [],
        perpD: [{ value: 0 }],
        spotD: [{ value: 0 }]
    };
};

// Utility functions
const utils = {
    initStdDevCache: () => ({ count: 0, mean: 0, m2: 0 }),
    updateStdDev: (cache, value) => {
        cache.count++;
        const delta = value - cache.mean;
        cache.mean += delta / cache.count;
        const delta2 = value - cache.mean;
        cache.m2 += delta * delta2;
        return cache.count > 1 ? Math.sqrt(cache.m2 / (cache.count - 1)) : 0;
    },
    ema: (data, period) => {
        if (!data.length) return [];
        const k = 2 / (period + 1);
        const result = [data[0]];
        for (let i = 1; i < data.length; i++) {
            result.push(data[i] * k + result[i - 1] * (1 - k));
        }
        return result;
    },
    stdev: (data, period) => {
        if (!data.length) return [];
        const result = new Array(data.length).fill(0);
        for (let i = period - 1; i < data.length; i++) {
            const slice = data.slice(i - period + 1, i + 1);
            const mean = slice.reduce((a, b) => a + b) / period;
            result[i] = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
        }
        return result;
    },
    ensureSufficientBars: (priceData) => {
        const MIN_LOOKBACK_BARS = 1440;
        if (!priceData?.length || priceData.length >= MIN_LOOKBACK_BARS) return priceData;

        const barsToAdd = MIN_LOOKBACK_BARS - priceData.length;
        const firstBar = priceData[0];
        const barInterval = priceData.length > 1 ? priceData[1].time - firstBar.time : 300;
        const synthetic = Array.from({ length: barsToAdd }, (_, i) => ({
            ...firstBar,
            time: firstBar.time - ((barsToAdd - i) * barInterval)
        }));

        return [...synthetic, ...priceData];
    }
};

// Comprehensive indicator calculation
const calculateAllIndicators = (priceData, options = {}) => {
    const processedData = utils.ensureSufficientBars(priceData);
    if (!processedData) {
        return {
            bands: { t1: 0, t2: 0, b1: 0, b2: 0, time: 0 },
            vwap: { vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN },
            vwapData: [],
            emaBands: { ema: 0, upper: 0, lower: 0, time: 0 },
            caches: {
                twapCache: { priceSum: 0, count: 0, value: 0 },
                vwapCache: { priceVolume: 0, totalVolume: 0, anchor: null },
                stdDevCache: utils.initStdDevCache(),
                vwapActive: false
            }
        };
    }

    const bands = calculateBands({ priceData: processedData });
    const emaBands = calculateEMABands(processedData);
    const caches = {
        twapCache: { priceSum: 0, count: 0, value: 0 },
        vwapCache: { priceVolume: 0, totalVolume: 0, anchor: null },
        stdDevCache: utils.initStdDevCache(),
        vwapActive: false
    };
    let latestVwap = { vwapValue: NaN, upperBand: NaN, lowerBand: NaN, upperMidline: NaN, lowerMidline: NaN };
    const vwapData = priceData.map(bar => {
        const result = calculateVTWAP(bar, caches);
        Object.assign(caches, result.caches);
        if (!isNaN(result.vwapValue)) latestVwap = result;
        return { time: bar.time, ...latestVwap };
    });

    return { bands, vwap: latestVwap, vwapData, emaBands, caches };
};

// Assign functions to global object
Object.assign(window.chartIndicators, {
    calculateBands,
    calculateVTWAP,
    calculateLiqs,
    utils,
    calculateAllIndicators,
    calculateEMABands
});

// Chart orderbook interface
window.chartOrderbook = {
    updateOrderBookLines: (state) => window.chartIndicators.orderbook.updateOrderBookLines(state),
    clearOrderBookLines: (state) => window.chartIndicators.orderbook.clearOrderBookLines(state),
    updateLastPrice: (state, price) => window.chartIndicators.orderbook.updateLastPrice(state, price),
    _processOrderBookUpdate: (state) => window.chartIndicators.orderbook.processOrderBookUpdate(state),
    _smoothPriceLevel: (type, price, volume) => window.chartIndicators.orderbook.smoothPriceLevel(type, price, volume),
    _cleanupSmoothPrices: () => window.chartIndicators.orderbook.cleanupSmoothPrices()
};

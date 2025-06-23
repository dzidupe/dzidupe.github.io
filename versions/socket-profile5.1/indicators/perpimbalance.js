(function() {
    // Check if utils.js is loaded
    if (!window.utils) {
        console.error('utils.js must be loaded before perpimbalance.js');
        throw new Error('Missing window.utils');
    }
    // Import utilities from window.utils
    const { normalizeValue, getIndicatorColor, formatLargeNumber, ema, stdev } = window.utils;

    // Configuration with validation
    const PERP_IMBALANCE_CONFIG = {
        lookbackPeriod: (() => {
            const savedWindow = localStorage.getItem('normalizationWindow');
            return Math.max(100, Math.min(10000, parseInt(savedWindow) || 1440));
        })(),
        renderOnCandleCloseOnly: true // Always true, enforce bar-close rendering only
    };

    window.PERP_IMBALANCE_CONFIG = PERP_IMBALANCE_CONFIG;

    // State Management
    const pendingUpdates = {
        lastBarTime: 0,
        pendingValue: 0,
        lastImbalanceValue: 0,
        hasUpdate: false,
        spotCVD: 0,
        futuresCVD: 0,
        oiCVD: 0,
        prevSpotBar: null,
        prevFuturesBar: null,
        prevOIBar: null,
        gradientOpacity: 100,
        spotPerpDiff: 0
    };

    let historicalImbalanceData = [];
    let historicalOIData = [];
    // let perpUpdateInterval = null;
    let pointColorFixInterval = null;

    // Core Functions
    function createPerpImbalanceIndicator(priceChart) {
        let indicatorPane;
        let paneIndex = 1;

        try {
            const panes = priceChart.panes();
            if (panes && panes.length > 1) {
                indicatorPane = panes[1];
                paneIndex = 1;
            } else {
                indicatorPane = panes[0];
                paneIndex = 0;
            }
            window.perpImbalancePaneIndex = paneIndex;
        } catch (e) {
            console.error('Error accessing panes:', e);
            paneIndex = 0;
            window.perpImbalancePaneIndex = 0;
        }

        let indicatorSeries;
        try {
            indicatorSeries = priceChart.addSeries(LightweightCharts.LineSeries, {
                priceFormat: { type: 'volume', precision: 2, minMove: 0.01 },
                lineWidth: 2,
                color: 'rgba(170, 170, 170, 0.8)',
                lastValueVisible: false,
                priceLineVisible: false,
                title: 'PERP IMB.',
                pointsVisible: false,
                lastPriceAnimation: 0,
                crosshairMarkerVisible: false,
                autoscaleInfoProvider: () => ({
                    priceRange: { minValue: -1.05, maxValue: 1.05 },
                    margins: { above: 5, below: 5 }
                })
            }, paneIndex);

            indicatorSeries.applyOptions({
                color: 'rgba(170, 170, 170, 0.8)'
            });
        } catch (error) {
            console.error('Error creating perpImbalance series:', error);
            indicatorSeries = priceChart.addSeries(LightweightCharts.LineSeries, {
                priceFormat: { type: 'volume', precision: 2, minMove: 0.01 },
                lineWidth: 1.5,
                color: 'rgba(170, 170, 170, 0.8)',
                lastValueVisible: false,
                priceLineVisible: false,
                title: 'PERP IMB.',
                pointsVisible: false,
                lastPriceAnimation: 0,
                crosshairMarkerVisible: false
            });
        }

        let zeroLine;
        try {
            zeroLine = priceChart.addSeries(LightweightCharts.LineSeries, {
                priceFormat: { type: 'volume' },
                color: '#444444',
                lineWidth: 1,
                lineStyle: 2,
                lastValueVisible: false,
                priceLineVisible: false,
                title: '',
                pointMarkersVisible: false,
                lastPriceAnimation: 0,
                crosshairMarkerVisible: false
            }, paneIndex);
        } catch (error) {
            console.error('Error creating zero line:', error);
            zeroLine = priceChart.addSeries(LightweightCharts.LineSeries, {
                priceFormat: { type: 'volume' },
                color: '#444444',
                lineWidth: 1,
                lineStyle: 2,
                lastValueVisible: false,
                priceLineVisible: false,
                title: '',
                pointMarkersVisible: false,
                lastPriceAnimation: 0,
                crosshairMarkerVisible: false
            });
        }

        const level1Line = priceChart.addSeries(LightweightCharts.LineSeries, {
            priceFormat: { type: 'volume' },
            color: '#888888',
            lineWidth: 1,
            lineStyle: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            title: '',
            pointMarkersVisible: false,
            lastPriceAnimation: 0,
            crosshairMarkerVisible: false
        }, paneIndex);

        const levelMinus1Line = priceChart.addSeries(LightweightCharts.LineSeries, {
            priceFormat: { type: 'volume' },
            color: '#888888',
            lineWidth: 1,
            lineStyle: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            title: '',
            pointMarkersVisible: false,
            lastPriceAnimation: 0,
            crosshairMarkerVisible: false
        }, paneIndex);

        const referenceLines = {};
        referenceLines.level1 = level1Line;
        referenceLines.levelMinus1 = levelMinus1Line;
        // Removed duplicate reference lines for 1, 0.5, -0.5, -1 to avoid double rendering.

        priceChart.applyOptions({
            layout: {
                background: { color: "rgba(15, 20, 26, 1.0)", type: 'solid' },
                panes: { separatorColor: '#2A2A2A', separatorHoverColor: 'rgba(255, 0, 0, 0.1)', enableResize: true }
            }
        });

        const components = { chart: priceChart, pane: indicatorPane, series: indicatorSeries, zeroLine, referenceLines };
        disableCrosshairMarkers(components);
        return components;
    }

    function initializeImbalanceData(components, spotData, futuresData, oiData) {
        if (!spotData?.length || !futuresData?.length) {
            components.series.setData([]);
            const now = Math.floor(Date.now() / 1000);
            components.zeroLine.setData([{ time: now - 86400, value: 0 }, { time: now, value: 0 }]);
            return { imbalanceData: [], normalizedData: [], spotPerpDiff: [] };
        }

        const oiDataFallback = oiData?.length ? oiData : futuresData.map(bar => ({ ...bar }));
        const spotCumulative = computeCumulativeDelta(spotData);
        const futuresCumulative = computeCumulativeDelta(futuresData);
        const imbalance = spotData.map((bar, i) => ({
            time: bar.time,
            value: futuresCumulative[i] - spotCumulative[i]
        }));

        const oi = oiDataFallback.map(bar => ({ time: bar.time, value: bar.close }));
        historicalImbalanceData = imbalance.slice();
        historicalOIData = oi.slice();

        if (imbalance.length > 0) {
            pendingUpdates.spotCVD = spotCumulative[spotCumulative.length - 1];
            pendingUpdates.futuresCVD = futuresCumulative[futuresCumulative.length - 1];
        }

        const lookbackPeriod = PERP_IMBALANCE_CONFIG.lookbackPeriod;
        const imbalanceMinMax = computeRollingMinMax(imbalance, lookbackPeriod);
        const oiMinMax = computeRollingMinMax(oi, lookbackPeriod);

        const wangerData = imbalance.map((bar, i) => {
            if (i === 0) {
                return { time: bar.time, value: 0, color: getIndicatorColor(0) };
            } else {
                const prevLiqs = normalizeImbalance(
                    imbalance[i - 1].value,
                    imbalanceMinMax.minValues[i - 1],
                    imbalanceMinMax.maxValues[i - 1]
                );
                const prevOI = normalizeImbalance(
                    oi[i - 1].value,
                    oiMinMax.minValues[i - 1],
                    oiMinMax.maxValues[i - 1]
                );
                const wangerValue = calculateWanger(prevLiqs, prevOI);
                return { time: bar.time, value: wangerValue, color: getIndicatorColor(wangerValue) };
            }
        });

        try {
            requestAnimationFrame(() => {
                components.series.setData(wangerData);
            });
        } catch (error) {
            console.error('Error setting perpImbalance data:', error);
        }

        if (wangerData.length > 0) {
            const firstTime = wangerData[0].time;
            const lastTime = wangerData[wangerData.length - 1].time;
            const zeroLineData = [{ time: firstTime, value: 0 }, { time: lastTime, value: 0 }];
            const level1LineData = [{ time: firstTime, value: 1 }, { time: lastTime, value: 1 }];
            const levelMinus1LineData = [{ time: firstTime, value: -1 }, { time: lastTime, value: -1 }];
            try {
                requestAnimationFrame(() => {
                    components.zeroLine.setData(zeroLineData);
                    if (components.referenceLines.level1)
                        components.referenceLines.level1.setData(level1LineData);
                    if (components.referenceLines.levelMinus1)
                        components.referenceLines.levelMinus1.setData(levelMinus1LineData);
                });
            } catch (error) {
                console.error('Error setting zero/1/-1 line data:', error);
            }

            const lastDataPoint = wangerData[wangerData.length - 1];
            if (lastDataPoint) {
                pendingUpdates.lastBarTime = lastDataPoint.time;
                pendingUpdates.pendingValue = lastDataPoint.value;
                pendingUpdates.lastImbalanceValue = imbalance[imbalance.length - 1].value;
                pendingUpdates.hasUpdate = true;
            }
        }

        disableCrosshairMarkers(components);
        return { imbalanceData: imbalance, normalizedData: wangerData, spotPerpDiff: [] };
    }

    function updateImbalance(components, spotBar, futuresBar, oiBar) {
        if (!spotBar || !futuresBar || !components || components.series._internal_isDisposed) return;

        if (!oiBar) oiBar = { ...futuresBar };

        const spotDelta = spotBar.volume * (spotBar.close - spotBar.open);
        const futuresDelta = futuresBar.volume * (futuresBar.close - futuresBar.open);
        pendingUpdates.spotCVD += spotDelta;
        pendingUpdates.futuresCVD += futuresDelta;

        const imbalanceValue = pendingUpdates.futuresCVD - pendingUpdates.spotCVD;
        const oiValue = oiBar.close;

        if (historicalImbalanceData.length > 0 && historicalImbalanceData[historicalImbalanceData.length - 1].time === spotBar.time) {
            historicalImbalanceData[historicalImbalanceData.length - 1].value = imbalanceValue;
        } else {
            historicalImbalanceData.push({ time: spotBar.time, value: imbalanceValue });
        }

        if (historicalOIData.length > 0 && historicalOIData[historicalOIData.length - 1].time === spotBar.time) {
            historicalOIData[historicalOIData.length - 1].value = oiValue;
        } else {
            historicalOIData.push({ time: spotBar.time, value: oiValue });
        }

        pendingUpdates.lastBarTime = spotBar.time;
        pendingUpdates.lastImbalanceValue = imbalanceValue;
        pendingUpdates.hasUpdate = true;

        // Intra-bar update logic removed: rendering only occurs after bar close.
    }

    function renderPendingUpdates(components) {
        if (!components?.series || components.series._internal_isDisposed || !pendingUpdates.hasUpdate) return;

        try {
            const now = Math.floor(Date.now() / 1000);
            const barInterval = 300;
            const currentBarTime = Math.floor(now / barInterval) * barInterval;

            if (currentBarTime > pendingUpdates.lastBarTime && historicalImbalanceData.length >= 2) {
                const lastClosedBarTime = currentBarTime - barInterval;
                const prevBarIndex = historicalImbalanceData.findIndex(bar => bar.time === lastClosedBarTime);

                if (prevBarIndex >= 1) {
                    const lookbackPeriod = PERP_IMBALANCE_CONFIG.lookbackPeriod;
                    const lookbackData = historicalImbalanceData.slice(Math.max(0, prevBarIndex - lookbackPeriod + 1), prevBarIndex + 1);
                    const oiLookbackData = historicalOIData.slice(Math.max(0, prevBarIndex - lookbackPeriod + 1), prevBarIndex + 1);
                    const imbalanceMin = Math.min(...lookbackData.map(d => d.value));
                    const imbalanceMax = Math.max(...lookbackData.map(d => d.value));
                    const oiMin = Math.min(...oiLookbackData.map(d => d.value));
                    const oiMax = Math.max(...oiLookbackData.map(d => d.value));
                    const prevLiqs = normalizeImbalance(historicalImbalanceData[prevBarIndex - 1].value, imbalanceMin, imbalanceMax);
                    const prevOI = normalizeImbalance(historicalOIData[prevBarIndex - 1].value, oiMin, oiMax);
                    const wangerValue = calculateWanger(prevLiqs, prevOI);

                    components.series.update({
                        time: lastClosedBarTime,
                        value: wangerValue,
                        color: getIndicatorColor(wangerValue)
                    });

                    pendingUpdates.lastBarTime = currentBarTime;
                    pendingUpdates.pendingValue = wangerValue;
                    pendingUpdates.hasUpdate = false;

                    try {
                        const state = window.chartStates?.get(window.currentPair);
                        if (state?.chart?.cvdComponents?.syncResources?.updateIndicatorColor) {
                            state.chart.cvdComponents.syncResources.updateIndicatorColor();
                        }
                    } catch (bgError) {
                        console.debug('Error updating indicator color from perpImbalance render:', bgError);
                    }
                }
            }

            try {
                if (components.chart && !components.chart._internal_isDisposed) {
                    const visibleRange = components.chart.timeScale().getVisibleRange();
                    if (visibleRange && visibleRange.from && visibleRange.to) {
                        components.zeroLine.setData([{ time: visibleRange.from, value: 0 }, { time: visibleRange.to, value: 0 }]);
                        if (components.referenceLines) {
                            try {
                                if (components.referenceLines.level1 && !components.referenceLines.level1._internal_isDisposed) {
                                    components.referenceLines.level1.setData([{ time: visibleRange.from, value: 1 }, { time: visibleRange.to, value: 1 }]);
                                }
                                if (components.referenceLines.level05 && !components.referenceLines.level05._internal_isDisposed) {
                                    components.referenceLines.level05.setData([{ time: visibleRange.from, value: 0.5 }, { time: visibleRange.to, value: 0.5 }]);
                                }
                                if (components.referenceLines.levelMinus05 && !components.referenceLines.levelMinus05._internal_isDisposed) {
                                    components.referenceLines.levelMinus05.setData([{ time: visibleRange.from, value: -0.5 }, { time: visibleRange.to, value: -0.5 }]);
                                }
                                if (components.referenceLines.levelMinus1 && !components.referenceLines.levelMinus1._internal_isDisposed) {
                                    components.referenceLines.levelMinus1.setData([{ time: visibleRange.from, value: -1 }, { time: visibleRange.to, value: -1 }]);
                                }
                            } catch (err) {
                                console.error('Error updating reference lines:', err);
                            }
                        }
                    }
                }
            } catch (e) {}
        } catch (e) {}
    }

    // Refactored to use IndicatorChartUtils
    // Use window.IndicatorChartUtils if needed (attach to window in its file)

    function synchronizeCharts(components, priceChart) {
        return window.IndicatorChartUtils
            ? window.IndicatorChartUtils.synchronizeCharts(components, priceChart, {
                referenceLevels: {
                    level1: 1,
                    level05: 0.5,
                    levelMinus05: -0.5,
                    levelMinus1: -1
                }
            })
            : null;
    }

    // Refactored to use IndicatorChartUtils
    function cleanupIndicator(components) {
        if (!components) return;
        // Unsubscribe from background data store updates
        if (typeof unsubscribePerpImbalance === 'function') {
            unsubscribePerpImbalance();
            unsubscribePerpImbalance = null;
        }
        if (window.IndicatorChartUtils) {
            window.IndicatorChartUtils.cleanupIndicator(
                components,
                [typeof perpUpdateInterval !== 'undefined' ? perpUpdateInterval : null, typeof pointColorFixInterval !== 'undefined' ? pointColorFixInterval : null],
                {
                    [typeof pendingUpdates !== 'undefined' ? pendingUpdates : {}]: {
                        lastBarTime: 0,
                        pendingValue: 0,
                        lastImbalanceValue: 0,
                        hasUpdate: false,
                        spotCVD: 0,
                        futuresCVD: 0,
                        oiCVD: 0,
                        prevSpotBar: null,
                        prevFuturesBar: null,
                        prevOIBar: null,
                        gradientOpacity: 100,
                        spotPerpDiff: 0
                    },
                    [typeof historicalImbalanceData !== 'undefined' ? historicalImbalanceData : []]: [],
                    [typeof historicalOIData !== 'undefined' ? historicalOIData : []]: []
                }
            );
        }
    }

    function disableCrosshairMarkers(components) {
        if (!components) return;
        try {
            if (components.series && !components.series._internal_isDisposed) {
                components.series.applyOptions({
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false,
                    pointsVisible: false
                });
            }
            if (components.zeroLine && !components.zeroLine._internal_isDisposed) {
                components.zeroLine.applyOptions({ crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
            }
            Object.values(components.referenceLines || {}).forEach(line => {
                if (line && !line._internal_isDisposed) {
                    try {
                        line.applyOptions({ crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false });
                    } catch (err) {
                        console.error('Error disabling markers for reference line:', err);
                    }
                }
            });
        } catch (e) {}
    }

    // Access the global PerpImbalance data store via window
    const subscribePerpImbalance = window.subscribePerpImbalance;
    const getCurrentPerpImbalance = window.getCurrentPerpImbalance;
    let unsubscribePerpImbalance = null;

    function setupPerpUpdateInterval(components) {
        if (unsubscribePerpImbalance) {
            unsubscribePerpImbalance();
            unsubscribePerpImbalance = null;
        }
        unsubscribePerpImbalance = subscribePerpImbalance((imbalanceData) => {
            if (!components || components.series._internal_isDisposed) return;
            // Assume imbalanceData has normalized value and time
            if (imbalanceData && imbalanceData.time && imbalanceData.value !== undefined) {
                const color = getIndicatorColor(imbalanceData.value);
                components.series.update({ time: imbalanceData.time, value: imbalanceData.value, color });
            }
        });

        // Keep the pointColorFixInterval logic if needed for UI
        if (pointColorFixInterval) clearInterval(pointColorFixInterval);
        pointColorFixInterval = setInterval(() => {
            if (!components || components.series._internal_isDisposed) {
                clearInterval(pointColorFixInterval);
                return;
            }
            components.series.applyOptions({
                pointsVisible: false
            });
        }, 2000);

        return unsubscribePerpImbalance;
    }

    // Helper Functions
    function computeCumulativeDelta(bars) {
        let cumulative = 0;
        return bars.map(bar => {
            const delta = bar.volume * (bar.close - bar.open);
            cumulative += delta;
            return cumulative;
        });
    }

    const rollingMinMaxCache = new WeakMap();
    function computeRollingMinMax(data, windowSize) {
        const cacheKey = `${windowSize}`;
        if (!rollingMinMaxCache.has(data)) rollingMinMaxCache.set(data, {});
        const cache = rollingMinMaxCache.get(data);
        if (cache[cacheKey]) return cache[cacheKey];
        const minValues = [];
        const maxValues = [];
        for (let i = 0; i < data.length; i++) {
            const start = Math.max(0, i - windowSize + 1);
            const window = data.slice(start, i + 1).map(p => p.value);
            minValues[i] = Math.min(...window);
            maxValues[i] = Math.max(...window);
        }
        cache[cacheKey] = { minValues, maxValues };
        return cache[cacheKey];
    }

    function normalizeImbalance(value, min, max) {
        return window.utils.normalizeImbalance(value, min, max);
    }

    function calculateWanger(liqsVal, oiVal) {
        return window.utils.calculateWanger(liqsVal, oiVal);
    }

    function getComponents() {
        if (window.chartStates && window.currentPair) {
            const state = window.chartStates.get(window.currentPair);
            if (state && state.chart && state.chart.perpImbalanceComponents) {
                return state.chart.perpImbalanceComponents;
            }
        }
        return null;
    }

    // Export Module
    window.perpImbalance = {
        createPerpImbalanceIndicator,
        initializeImbalanceData,
        updateImbalance,
        renderPendingUpdates,
        cleanupIndicator,
        disableCrosshairMarkers,
        setupPerpUpdateInterval,
        synchronizeCharts,
        getComponents,
        pendingUpdates,
        config: PERP_IMBALANCE_CONFIG
    };
})();
(function() {
    // Check if utils.js loaded correctly
    if (!window.utils) {
        console.debug('utils.js not loaded yet, retrying in 500ms...');
        setTimeout(() => {
            if (window.utils) {
                console.debug('utils.js loaded, proceeding with CVD initialization');
                // Re-initialize or proceed with logic here
            } else {
                console.debug('utils.js still not loaded, skipping CVD initialization');
            }
        }, 500);
        return; // Exit early to avoid errors
    }
    const { getIndicatorColor, formatLargeNumber } = window.utils;
    const { normalize, computeRollingMinMax, ema, stdev, clamp, lerp, weightedAverage } = window.mathUtils;

    // Configuration
    const CVD_CONFIG = {
        volumeMAPeriod: 90,
        volumeAdjustment: {
            enabled: true,
            buyMultiplier: 1.0,
            sellMultiplier: 1.0,
            useWicks: true,
            useBodySize: true,
            useCloseRelative: true
        },
        renderOnCandleCloseOnly: true,
        normalizationBuffer: 0,
        minSmoothingPeriod: 5,
        maxSmoothingPeriod: 20,
        adaptiveSmoothingFactor: 0.5,
        volumeWeighting: {
            enabled: true,
            weightFactor: 0.5
        },
        lookbackPeriod: (() => {
            const savedWindow = localStorage.getItem('normalizationWindow');
            return savedWindow ? parseInt(savedWindow) : 1440;
        })()
    };

    window.CVD_CONFIG = CVD_CONFIG;

    // State Management
    const pendingCVDUpdates = {
        lastBarTime: 0,
        lastCvdValue: 0,
        pendingValue: 0,
        pendingEmaValue: 0,
        hasUpdate: false,
        avgVolume: 0
    };

    let historicalCVDData = [];

    // Access the global PerpCVD data store via window
    const subscribePerpCVD = window.subscribePerpCVD;
    const getCurrentPerpCVD = window.getCurrentPerpCVD;
    let unsubscribePerpCVD = null;

    // Ensure unsubscribe logic is called when indicator components are unmounted
    function cleanupCVD(cvdComponents) {
        if (unsubscribePerpCVD) {
            unsubscribePerpCVD();
            unsubscribePerpCVD = null;
        }
        // ... (existing cleanup logic, if any)
    }

    function createCVDChart(container, priceChart) {
        let cvdPane;
        try {
            const panes = priceChart.panes();
            if (panes && panes.length > 1) {
                cvdPane = panes[1];
                cvdPane.applyOptions({ visible: true });
                if (typeof cvdPane.setHeight === 'function') {
                    cvdPane.setHeight(150);
                }
                cvdPane.applyOptions({
                    rightPriceScale: {
                        visible: true,
                        borderColor: '#2A2A2A',
                        scaleMargins: { top: 0.1, bottom: 0.1 },
                        formatter: {
                            format: (price) => formatLargeNumber(price)
                        }
                    }
                });
            } else if (window.DEBUG_MODE) {
                console.debug('No CVD pane available');
            }
        } catch (e) {
            if (window.DEBUG_MODE) console.warn('Pane access error:', e);
        }

        const cvdSeries = priceChart.addSeries(LightweightCharts.LineSeries, {
            priceFormat: {
                type: 'volume',
                formatter: (price) => formatLargeNumber(price)
            },
            lineWidth: 1.5,
            lastValueVisible: false,
            priceLineVisible: false,
            title: 'PERP CVD',
            pointsVisible: false,
            lastPriceAnimation: 0,
            autoscaleInfoProvider: () => ({
                priceRange: { minValue: -1.05, maxValue: 1.05 },
                margins: { above: 5, below: 5 }
            }),
            crosshairMarkerVisible: false
        }, 1);

        const cvdMASeries = {
            update: () => {},
            setData: () => {},
            applyOptions: () => {},
            _internal_isDisposed: false
        };

        const zeroLine = priceChart.addSeries(LightweightCharts.LineSeries, {
            priceFormat: { type: 'volume' },
            color: '#444444',
            lineWidth: 1,
            lineStyle: 2, // match dashed style of other reference lines
            lastValueVisible: false,
            priceLineVisible: false,
            title: '',
            pointsVisible: false,
            lastPriceAnimation: 0,
            crosshairMarkerVisible: false
        }, 1);

        // Add dashed reference lines at y=1 and y=-1
        const level1Line = priceChart.addSeries(LightweightCharts.LineSeries, {
            priceFormat: { type: 'volume' },
            color: '#888888',
            lineWidth: 1,
            lineStyle: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            title: '',
            pointsVisible: false,
            lastPriceAnimation: 0,
            crosshairMarkerVisible: false
        }, 1);

        const levelMinus1Line = priceChart.addSeries(LightweightCharts.LineSeries, {
            priceFormat: { type: 'volume' },
            color: '#888888',
            lineWidth: 1,
            lineStyle: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            title: '',
            pointsVisible: false,
            lastPriceAnimation: 0,
            crosshairMarkerVisible: false
        }, 1);

        const referenceLines = {};
        referenceLines.level1 = level1Line;
        referenceLines.levelMinus1 = levelMinus1Line;

        priceChart.applyOptions({
            layout: {
                background: { color: "rgba(15, 20, 26, 1.0)", type: 'solid' },
                panes: { separatorColor: '#2A2A2A', separatorHoverColor: 'rgba(255, 0, 0, 0.1)', enableResize: true }
            }
        });

        try {
            const chartContainer = container.querySelector('.tv-lightweight-charts');
            if (chartContainer) {
                chartContainer.style.backgroundColor = 'rgba(15, 20, 26, 1.0)';
            }
        } catch (e) {
            console.warn('Error styling chart container:', e);
        }

        return {
            chart: priceChart,
            pane: cvdPane,
            series: cvdSeries,
            zeroLine: zeroLine,
            referenceLines: referenceLines
        };
    }

    function calculateAdjustedVolume(bar, prevBar) {
        if (!bar) return 0;
        const volume = (bar.volume !== undefined && !isNaN(bar.volume)) ? bar.volume : 0;
        if (volume === 0) return 0;
        let isBuyBar = true;
        if (CVD_CONFIG.volumeAdjustment.useCloseRelative && prevBar && prevBar.close !== undefined && !isNaN(prevBar.close)) {
            isBuyBar = bar.close >= prevBar.close;
        } else {
            isBuyBar = bar.close >= bar.open;
        }
        let adjustmentFactor = 1.0;
        if (CVD_CONFIG.volumeAdjustment.useBodySize) {
            const bodySize = Math.abs(bar.close - bar.open);
            const range = bar.high - bar.low;
            if (range > 0 && isFinite(bodySize) && isFinite(range)) {
                const bodySizePercent = bodySize / range;
                adjustmentFactor *= (0.7 + bodySizePercent * 0.6);
            }
        }
        if (CVD_CONFIG.volumeAdjustment.useWicks) {
            const totalRange = bar.high - bar.low;
            if (totalRange > 0 && isFinite(totalRange)) {
                const upperWick = bar.high - Math.max(bar.open, bar.close);
                const lowerWick = Math.min(bar.open, bar.close) - bar.low;
                if (isFinite(upperWick) && isFinite(lowerWick)) {
                    if (isBuyBar) {
                        const lowerWickPercent = lowerWick / totalRange;
                        adjustmentFactor *= (1 + lowerWickPercent * 0.8);
                    } else {
                        const upperWickPercent = upperWick / totalRange;
                        adjustmentFactor *= (1 + upperWickPercent * 0.8);
                    }
                }
            }
        }
        adjustmentFactor = Math.max(0.5, Math.min(2.0, adjustmentFactor));
        return isBuyBar ? volume * adjustmentFactor * CVD_CONFIG.volumeAdjustment.buyMultiplier : -volume * adjustmentFactor * CVD_CONFIG.volumeAdjustment.sellMultiplier;
    }

    const cvdDataCache = new WeakMap();
    function calculateCVDData(priceData) {
        if (cvdDataCache.has(priceData)) return cvdDataCache.get(priceData);
        const cvdData = [];
        let cumulativeDelta = 0;
        for (let i = 0; i < priceData.length; i++) {
            const bar = priceData[i];
            const prevBar = i > 0 ? priceData[i-1] : null;
            if (!bar || !bar.time || (bar.volume === undefined)) continue;
            const barDelta = calculateAdjustedVolume(bar, prevBar);
            cumulativeDelta += barDelta;
            cvdData.push({ time: bar.time, value: cumulativeDelta });
        }
        cvdDataCache.set(priceData, cvdData);
        return cvdData;
    }



    // Use computeRollingMinMax and normalize from window.mathUtils

    function getCVDColor(normalizedValue) {
        if (normalizedValue > 0.5) {
            return 'rgba(255, 0, 0, 0.4)';
        } else if (normalizedValue < -0.5) {
            return 'rgba(0, 255, 255, 0.4)';
        } else {
            return 'rgba(170, 170, 170, 0.8)';
        }
    }

    function initializeCVDData(cvdComponents, priceData) {
        const cvdData = calculateCVDData(priceData);
        historicalCVDData = cvdData.slice();
        const { minValues, maxValues } = computeRollingMinMax(cvdData, CVD_CONFIG.lookbackPeriod, p => p.value);
        const normalizedCVDData = cvdData.map((point, i) => {
            const min = minValues[i];
            const max = maxValues[i];
            const normalizedValue = normalize(point.value, min, max, { range: [-1, 1] });
            const color = getCVDColor(normalizedValue);
            return { time: point.time, value: normalizedValue, color: color };
        });
        const emptyMAData = cvdData.map(point => ({ time: point.time, value: 0 }));
        const zeroLineData = [];
        if (priceData.length > 0) {
            const firstTime = priceData[0].time;
            const lastTime = priceData[priceData.length - 1].time;
            zeroLineData.push({ time: firstTime, value: 0 });
            zeroLineData.push({ time: lastTime, value: 0 });
            const lastDataPoint = normalizedCVDData[normalizedCVDData.length - 1];
            if (lastDataPoint) {
                pendingCVDUpdates.lastBarTime = lastDataPoint.time;
                pendingCVDUpdates.pendingValue = lastDataPoint.value;
                pendingCVDUpdates.pendingEmaValue = 0;
                pendingCVDUpdates.lastCvdValue = cvdData[cvdData.length - 1].value;
                pendingCVDUpdates.hasUpdate = true;
            }
        } else {
            const now = Math.floor(Date.now() / 1000);
            zeroLineData.push({ time: now - 86400, value: 0 });
            zeroLineData.push({ time: now, value: 0 });
        }
        // Batch DOM updates for performance
        requestAnimationFrame(() => {
            cvdComponents.series.setData(normalizedCVDData);
            cvdComponents.zeroLine.setData(zeroLineData);
            if (cvdComponents.referenceLines.level1)
                cvdComponents.referenceLines.level1.setData(zeroLineData.map(d => ({ ...d, value: 1 })));
            if (cvdComponents.referenceLines.levelMinus1)
                cvdComponents.referenceLines.levelMinus1.setData(zeroLineData.map(d => ({ ...d, value: -1 })));
        });
        return { cvdData: normalizedCVDData, cvdMAData: emptyMAData };
    }

    // Use window.IndicatorChartUtils for browser compatibility

    function synchronizeCharts(cvdComponents, priceChart) {
        // Use shared utility for zero/reference lines
        const syncHandle = window.IndicatorChartUtils
            ? window.IndicatorChartUtils.synchronizeCharts(
                cvdComponents,
                priceChart,
                {
                    referenceLevels: {
                        // Add reference levels if needed for coloredZeroLine, etc.
                        // Example: level1: 1, levelMinus1: -1
                    }
                }
            )
            : null;

        // Custom color update logic (specific to CVD)
        const updateIndicatorColor = () => {};

        updateIndicatorColor();
        const colorUpdateInterval = setInterval(updateIndicatorColor, 1000);

        return {
            unsubscribe: () => {
                try {
                    syncHandle.unsubscribe();
                    clearInterval(colorUpdateInterval);
                } catch (e) {}
            },
            updateIndicatorColor: updateIndicatorColor
        };
    }

    function normalizeCVDWithComponents(value, cvdComponents) {
        try {
            if (historicalCVDData.length === 0) {
                const currentData = cvdComponents.series.data();
                if (currentData && currentData.length > 0) {
                    historicalCVDData = currentData.map(d => ({ time: d.time, value: d.value }));
                }
            }
            const now = Math.floor(Date.now() / 1000);
            const barInterval = 300;
            const currentBarTime = Math.floor(now / barInterval) * barInterval;
            if (historicalCVDData.length === 0 || historicalCVDData[historicalCVDData.length - 1].time !== currentBarTime) {
                historicalCVDData.push({ time: currentBarTime, value: value });
                if (historicalCVDData.length > CVD_CONFIG.lookbackPeriod * 2) {
                    historicalCVDData = historicalCVDData.slice(-CVD_CONFIG.lookbackPeriod * 2);
                }
            } else {
                historicalCVDData[historicalCVDData.length - 1].value = value;
            }
            const lookbackData = historicalCVDData.slice(-CVD_CONFIG.lookbackPeriod);
            if (lookbackData.length === 0) {
                return value >= 0 ? 0.5 : -0.5;
            }
            const min = Math.min(...lookbackData.map(d => d.value));
            const max = Math.max(...lookbackData.map(d => d.value));
            return normalizeCVD(value, min, max);
        } catch (e) {
            console.debug('Error normalizing CVD with components:', e);
            return value >= 0 ? 0.5 : -0.5;
        }
    }

    function updateCVD(cvdComponents, bar, prevBar, lastCvdValue = 0) {
        if (!bar || bar.volume === undefined || isNaN(bar.volume)) {
            console.debug('Skipping CVD update due to invalid bar data');
            return lastCvdValue;
        }
        let timeGapMinutes = 0;
        if (prevBar && bar.time > prevBar.time) {
            timeGapMinutes = (bar.time - prevBar.time) / 60;
        }
        const volume = (bar.volume !== undefined && !isNaN(bar.volume)) ? bar.volume : 0;
        const barDelta = calculateAdjustedVolume(bar, prevBar);
        let weightedDelta = barDelta;
        if (CVD_CONFIG.volumeWeighting.enabled && volume > 0) {
            let avgVolume = volume;
            if (pendingCVDUpdates && pendingCVDUpdates.avgVolume) {
                avgVolume = pendingCVDUpdates.avgVolume * 0.9 + volume * 0.1;
            }
            if (pendingCVDUpdates) {
                pendingCVDUpdates.avgVolume = avgVolume;
            }
            const volumeRatio = volume / avgVolume;
            const weightFactor = CVD_CONFIG.volumeWeighting.weightFactor;
            weightedDelta = barDelta * (1 + weightFactor * (volumeRatio - 1)) / (1 + weightFactor);
        }
        const newCvdValue = lastCvdValue + weightedDelta;
        let smoothedCvdValue = newCvdValue;
        if (timeGapMinutes > 5) {
            const prevCvdValue = pendingCVDUpdates.lastCvdValue || lastCvdValue;
            const basePeriod = 5;
            const additionalSmoothing = timeGapMinutes * CVD_CONFIG.adaptiveSmoothingFactor;
            const adaptivePeriod = Math.min(CVD_CONFIG.maxSmoothingPeriod, Math.max(CVD_CONFIG.minSmoothingPeriod, basePeriod + additionalSmoothing));
            const alpha = 2 / (adaptivePeriod + 1);
            smoothedCvdValue = alpha * newCvdValue + (1 - alpha) * prevCvdValue;
        }
        const normalizedCVDValue = normalizeCVDWithComponents(smoothedCvdValue, cvdComponents);
        const displayValue = normalizedCVDValue;
        let cvdColor;
        if (displayValue >= 0) {
            cvdColor = 'rgba(255, 0, 0, 0.8)'; // red for positive or zero
        } else {
            cvdColor = 'rgba(0, 255, 255, 0.8)'; // aqua for negative
        }
        const newMaValue = 0;
        if (CVD_CONFIG.renderOnCandleCloseOnly) {
            if (bar.time !== pendingCVDUpdates.lastBarTime) {
                if (pendingCVDUpdates.hasUpdate) {
                    cvdComponents.series.update({
                        time: pendingCVDUpdates.lastBarTime,
                        value: pendingCVDUpdates.pendingValue,
                        color: pendingCVDUpdates.pendingValue >= 0 ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 255, 255, 0.8)'
                    });
                }
                pendingCVDUpdates.lastBarTime = bar.time;
                pendingCVDUpdates.pendingValue = displayValue;
                pendingCVDUpdates.pendingEmaValue = newMaValue;
                pendingCVDUpdates.lastCvdValue = newCvdValue;
                pendingCVDUpdates.hasUpdate = true;
            } else {
                pendingCVDUpdates.pendingValue = displayValue;
                pendingCVDUpdates.pendingEmaValue = newMaValue;
                pendingCVDUpdates.lastCvdValue = newCvdValue;
                pendingCVDUpdates.hasUpdate = true;
            }
        } else {
            cvdComponents.series.update({ time: bar.time, value: displayValue, color: cvdColor });
        }
        pendingCVDUpdates.lastCvdValue = newCvdValue;
        if (cvdComponents.syncResources && typeof cvdComponents.syncResources.updateIndicatorColor === 'function') {
            cvdComponents.syncResources.updateIndicatorColor();
        }
        return newCvdValue;
    }

    function resizeCVDChart(cvdComponents, _width, height) {
        try {
            if (cvdComponents && cvdComponents.chart) {
                if (cvdComponents.pane) {
                    const cvdHeight = Math.max(150, Math.floor(height * 0.2));
                    if (typeof cvdComponents.pane.setHeight === 'function') {
                        cvdComponents.pane.setHeight(cvdHeight);
                    }
                } else {
                    const chartContainer = document.querySelector('.price-chart-container');
                    if (chartContainer) {
                        const chartElement = chartContainer.querySelector('.tv-lightweight-charts');
                        if (chartElement) {
                            chartElement.style.backgroundColor = 'rgba(15, 20, 26, 1.0)';
                            try {
                                const panes = cvdComponents.chart.panes();
                                if (panes && panes.length > 1) {
                                    const cvdPane = panes[1];
                                    cvdComponents.pane = cvdPane;
                                    const cvdHeight = Math.max(150, Math.floor(height * 0.2));
                                    if (typeof cvdPane.setHeight === 'function') {
                                        cvdPane.setHeight(cvdHeight);
                                    }
                                }
                            } catch (paneError) {
                                console.debug('Could not access panes API, falling back to DOM manipulation');
                                const paneElements = chartElement.querySelectorAll('.tv-lightweight-charts__pane');
                                if (paneElements && paneElements.length > 1) {
                                    const cvdPaneElement = paneElements[1];
                                    if (cvdPaneElement) {
                                        cvdPaneElement.style.zIndex = '3';
                                        cvdPaneElement.style.borderTop = '1px solid #2A2A2A';
                                        cvdPaneElement.style.boxSizing = 'border-box';
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Error resizing CVD chart:', e);
        }
    }

    function cleanupCVD(cvdComponents, syncResources) {
        // Use shared utility for cleanup
        IndicatorChartUtils.cleanupIndicator(
            cvdComponents,
            [cvdUpdateInterval, typeof syncResources === 'number' ? syncResources : undefined],
            {
                pendingCVDUpdates: {
                    lastBarTime: 0,
                    lastCvdValue: 0,
                    pendingValue: 0,
                    pendingEmaValue: 0,
                    hasUpdate: false,
                    avgVolume: 0
                }
            }
        );
        cvdUpdateInterval = null;
    }

    // Performance-optimized rendering
    let lastRenderTime = 0;
    function renderPendingCVDUpdates(cvdComponents) {
        if (!cvdComponents?.series?._internal_isDisposed) return;
        
        // Throttle to 2 seconds (reduced from 1s)
        const now = Date.now();
        if (now - lastRenderTime < 2000) return;
        lastRenderTime = now;

        // Defer non-critical work
        requestIdleCallback(() => {
            try {
                const currentBarTime = Math.floor(Date.now() / 1000 / 300) * 300;
                const isNewCandle = currentBarTime > pendingCVDUpdates.lastBarTime;
                if (pendingCVDUpdates.hasUpdate || isNewCandle) {
                    const value = pendingCVDUpdates.pendingValue;
                    const cvdColor = value >= 0 ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 255, 255, 0.8)';
                    cvdComponents.series.update({ time: pendingCVDUpdates.lastBarTime, value, color: cvdColor });
                    
                    if (isNewCandle) {
                        pendingCVDUpdates.lastBarTime = currentBarTime;
                        if (pendingCVDUpdates.lastCvdValue !== undefined) {
                            pendingCVDUpdates.pendingValue = normalizeCVDWithComponents(pendingCVDUpdates.lastCvdValue, cvdComponents);
                        }
                    }
                    pendingCVDUpdates.hasUpdate = false;
                }
            } catch (e) {
                if (window.DEBUG_MODE) console.debug('Render error:', e);
            }
        }, { timeout: 1000 }); // 1s fallback
    }

    // Subscribe to global PerpCVD data updates and update chart only if mounted
    function setupCVDUpdateInterval(cvdComponents) {
        if (unsubscribePerpCVD) {
            unsubscribePerpCVD();
            unsubscribePerpCVD = null;
        }
        unsubscribePerpCVD = subscribePerpCVD((cvdData) => {
            if (!cvdComponents || cvdComponents.series._internal_isDisposed) return;
            // Assume cvdData has normalized value and time
            if (cvdData && cvdData.time && cvdData.value !== undefined) {
                const color = cvdData.value >= 0 ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 255, 255, 0.8)';
                cvdComponents.series.update({ time: cvdData.time, value: cvdData.value, color });
            }
        });
        return unsubscribePerpCVD;
    }

    window.perpCvdModule = {
        createCVDChart,
        calculateAdjustedVolume,
        calculateCVDData,
        getCVDColor,
        initializeCVDData,
        synchronizeCharts,
        normalizeCVDWithComponents,
        updateCVD,
        resizeCVDChart,
        cleanupCVD,
        renderPendingCVDUpdates,
        setupCVDUpdateInterval
    };
})();
// indicatorChartUtils.js - Shared utilities for indicator chart synchronization and cleanup

const IndicatorChartUtils = {
    /**
     * Synchronize zero/reference lines with the visible range of the price chart.
     * Handles subscription and returns an unsubscribe handle.
     * @param {Object} components - Indicator components (series, zeroLine, referenceLines, etc.)
     * @param {Object} priceChart - Chart instance
     * @param {Object} [options] - Optional config for reference lines
     * @returns {Object} unsubscribe handle
     */
    synchronizeCharts(components, priceChart, options = {}) {
        const updateZeroLine = () => {
            try {
                if (!components || !components.zeroLine || !priceChart) return;
                if (components.zeroLine._internal_isDisposed || priceChart._internal_isDisposed) return;
                const visibleRange = priceChart.timeScale().getVisibleRange();
                if (visibleRange && visibleRange.from && visibleRange.to) {
                    components.zeroLine.setData([
                        { time: visibleRange.from, value: 0 },
                        { time: visibleRange.to, value: 0 }
                    ]);
                    if (components.referenceLines) {
                        Object.entries(components.referenceLines).forEach(([level, line]) => {
                            if (line && !line._internal_isDisposed && options.referenceLevels && options.referenceLevels[level] !== undefined) {
                                line.setData([
                                    { time: visibleRange.from, value: options.referenceLevels[level] },
                                    { time: visibleRange.to, value: options.referenceLevels[level] }
                                ]);
                            }
                        });
                    }
                }
            } catch (e) {}
        };

        try {
            if (components.series) {
                components.series.applyOptions({ lastValueVisible: false, pointsVisible: false, crosshairMarkerVisible: false });
            }
            if (components.zeroLine) {
                components.zeroLine.applyOptions({ lastValueVisible: false, pointsVisible: false, crosshairMarkerVisible: false });
            }
            if (components.referenceLines) {
                Object.values(components.referenceLines).forEach(line => {
                    if (line) line.applyOptions({ lastValueVisible: false, pointsVisible: false, crosshairMarkerVisible: false });
                });
            }
        } catch (e) {}

        updateZeroLine();
        const timeScaleSubscription = priceChart.timeScale().subscribeVisibleTimeRangeChange(updateZeroLine);

        return {
            unsubscribe: () => {
                try {
                    timeScaleSubscription.unsubscribe();
                } catch (e) {}
            }
        };
    },

    /**
     * Cleanup indicator resources: intervals, subscriptions, chart series, and reset state.
     * @param {Object} components - Indicator components (series, zeroLine, referenceLines, syncResources, chart, etc.)
     * @param {Array} intervals - Array of interval IDs to clear
     * @param {Object} stateObjects - Objects to reset (pendingUpdates, historicalData, etc.)
     */
    cleanupIndicator(components, intervals = [], stateObjects = {}) {
        try {
            // Clear intervals
            intervals.forEach(intervalId => {
                if (intervalId) clearInterval(intervalId);
            });

            // Unsubscribe from syncResources
            if (components.syncResources) {
                if (typeof components.syncResources.unsubscribe === 'function') {
                    try {
                        components.syncResources.unsubscribe();
                    } catch (e) {}
                } else if (components.syncResources.interval) {
                    clearInterval(components.syncResources.interval);
                }
            }

            // Remove reference lines
            if (components.referenceLines) {
                Object.values(components.referenceLines).forEach(line => {
                    if (line && !line._internal_isDisposed && components.chart) {
                        try {
                            components.chart.removeSeries(line);
                        } catch (e) {}
                    }
                });
            }

            // Remove series from the chart
            ['series', 'zeroLine'].forEach(key => {
                const series = components[key];
                if (series && !series._internal_isDisposed && components.chart) {
                    try {
                        components.chart.removeSeries(series);
                    } catch (e) {}
                }
            });

            // Reset state objects
            Object.entries(stateObjects).forEach(([obj, resetValue]) => {
                if (typeof obj === 'object') {
                    Object.assign(obj, resetValue);
                }
            });
        } catch (e) {}
    }
};

// Attach to window for browser use
if (typeof window !== 'undefined') {
    window.IndicatorChartUtils = IndicatorChartUtils;
}


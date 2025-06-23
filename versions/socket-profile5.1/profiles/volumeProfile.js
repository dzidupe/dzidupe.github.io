// Volume Profile for Lightweight Charts
// Based on TradingView's volume profile example

window.volumeProfileManager = (() => {
    const DEFAULT_CONFIG = {
        priceRange: 150, // Default number of volume profile lines
        barWidth: 0.8,
        position: 0.1, // Position parameter (used for centered profile, ignored for left-aligned)
        alignLeft: false, // Whether to align the profile to the left border instead of using centerline
        colors: {
            bullish: 'rgba(192, 192, 192, 0.7)', // Silver for buy volume
            bearish: 'rgba(64, 64, 64, 0.7)',    // Dark grey for sell volume
            median: 'rgba(255, 255, 255, 0.8)',
        },
        showMedian: true,
        visible: true,
        liveUpdate: true,
        maxBars: 6000, // Doubled from 3000 to 6000
    };

    // Add memory optimization for large datasets
    const optimizeDataForCalculation = (priceData, maxBars) => {
        if (priceData.length <= maxBars) return priceData;

        // If we have more data than needed, use the most recent maxBars
        return priceData.slice(-maxBars);
    };

    const profiles = new Map();

    // Memoization for volume profile calculation
    const volumeProfileCache = new WeakMap();
    const calculateVolumeProfile = (priceData, config) => {
        if (volumeProfileCache.has(priceData)) {
            const cached = volumeProfileCache.get(priceData);
            if (cached.configHash === JSON.stringify(config)) return cached.result;
        }
        if (!priceData?.length) return null;

        // Optimize data if needed
        const optimizedData = optimizeDataForCalculation(priceData, config.maxBars);

        let minPrice = Infinity;
        let maxPrice = -Infinity;

        optimizedData.forEach(bar => {
            minPrice = Math.min(minPrice, bar.low);
            maxPrice = Math.max(maxPrice, bar.high);
        });

        const padding = (maxPrice - minPrice) * 0.05;
        minPrice -= padding;
        maxPrice += padding;

        const priceStep = (maxPrice - minPrice) / config.priceRange;
        const priceLevels = Array.from({ length: config.priceRange }, (_, i) => ({
            price: minPrice + (i * priceStep) + (priceStep / 2),
            bullVolume: 0,
            bearVolume: 0,
            totalVolume: 0,
        }));

        priceData.forEach(bar => {
            if (!bar.volume) return;

            const isBullish = bar.close >= bar.open;
            const avgPrice = (bar.high + bar.low) / 2;
            const levelIndex = Math.floor((avgPrice - minPrice) / priceStep);

            if (levelIndex >= 0 && levelIndex < priceLevels.length) {
                const level = priceLevels[levelIndex];
                level.totalVolume += bar.volume;
                if (isBullish) {
                    level.bullVolume += bar.volume;
                } else {
                    level.bearVolume += bar.volume;
                }
            }
        });

        const maxVolumeLevel = priceLevels.reduce((max, level) =>
            level.totalVolume > max.totalVolume ? level : max,
            priceLevels[0]
        );

        const result = { levels: priceLevels, maxVolumeLevel, minPrice, maxPrice, priceStep };
        volumeProfileCache.set(priceData, { configHash: JSON.stringify(config), result });
        return result;
    };

    const updateProfile = (symbol) => {
        const profile = profiles.get(symbol);
        if (!profile) return;

        const { chartState, config } = profile;

        // Check if we need to update the profile (within the same candle)
        const now = Math.floor(Date.now() / 1000);
        const currentCandleTime = Math.floor(now / chartState.config.barInterval) * chartState.config.barInterval;

        // Use a worker or requestIdleCallback for heavy calculations if available
        const updateProfileData = () => {
            // Get the most recent data up to maxBars
            const recentData = chartState.data.priceData.slice(-config.maxBars);

            profile.data = calculateVolumeProfile(recentData, config);
            if (profile.drawVolumeProfile) {
                requestAnimationFrame(() => profile.drawVolumeProfile());
            }
        };

        // Use requestIdleCallback if available, otherwise use setTimeout
        if (window.requestIdleCallback) {
            window.requestIdleCallback(() => updateProfileData(), { timeout: 1000 });
        } else {
            setTimeout(updateProfileData, 0);
        }
    };

    const toggleVisibility = (symbol) => {
        const profile = profiles.get(symbol);
        if (!profile) return false;

        profile.visible = !profile.visible;
        profile.drawVolumeProfile?.();
        return profile.visible;
    };

    const initialize = (chartState, config = {}) => {
        const mergedConfig = { ...DEFAULT_CONFIG, ...config };
        const { chartContainer, chart: { priceChart, priceSeries } } = chartState;

        const profile = {
            config: mergedConfig,
            chartState,
            data: null,
            visible: mergedConfig.visible,
            priceRangeCache: { topPrice: null, bottomPrice: null, height: null, timestamp: Date.now() },
            lastCandleTime: Math.floor(Date.now() / 1000 / chartState.config.barInterval) * chartState.config.barInterval
        };

        profiles.set(chartState.config.ticker.symbol, profile);
        updateProfile(chartState.config.ticker.symbol);

        if (!chartContainer || !priceChart) {
            console.error('Chart container or price chart not found');
            return null;
        }

        const volumeProfileCanvas = document.createElement('canvas');
        volumeProfileCanvas.id = 'volume-profile-canvas'; // Add ID for easier selection
        Object.assign(volumeProfileCanvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            pointerEvents: 'none',
            zIndex: '2',
        });
        chartContainer.appendChild(volumeProfileCanvas);
        profile.volumeProfileCanvas = volumeProfileCanvas;

        const chartCanvas = chartContainer.querySelector('canvas');
        if (!chartCanvas) {
            console.error('Chart canvas not found');
            return null;
        }
        profile.chartCanvas = chartCanvas;

        const priceToY = (price, height) => {
            try {
                if (typeof priceSeries.priceToCoordinate === 'function') {
                    return priceSeries.priceToCoordinate(price) || 0;
                }

                const priceScale = priceSeries.priceScale();
                if (!priceScale) return 0;

                let topPrice, bottomPrice;
                if (priceScale.priceRange) {
                    const range = priceScale.priceRange();
                    if (!range) return 0;
                    topPrice = range.maxValue?.() ?? range.max;
                    bottomPrice = range.minValue?.() ?? range.min;
                } else if (priceScale.getVisibleRange) {
                    const range = priceScale.getVisibleRange();
                    if (!range) return 0;
                    topPrice = range.maxValue;
                    bottomPrice = range.minValue;
                } else {
                    const data = priceSeries.data();
                    if (!data?.length) return height / 2;
                    topPrice = Math.max(...data.map(bar => bar.high));
                    bottomPrice = Math.min(...data.map(bar => bar.low));
                }

                profile.priceRangeCache = { topPrice, bottomPrice, height, timestamp: Date.now() };
                const priceDiff = topPrice - bottomPrice;
                return priceDiff === 0 ? height / 2 : height - ((price - bottomPrice) / priceDiff * height);
            } catch (e) {
                console.warn('Error converting price to coordinate:', e);
                return height / 2;
            }
        };

        const drawVolumeProfile = () => {
            if (!profile.visible || !profile.data?.levels || !profile.data.maxVolumeLevel ||
                !volumeProfileCanvas || !chartCanvas) return;

            if (chartCanvas.width !== volumeProfileCanvas.width ||
                chartCanvas.height !== volumeProfileCanvas.height) {
                volumeProfileCanvas.width = chartCanvas.width;
                volumeProfileCanvas.height = chartCanvas.height;
            }

            const ctx = volumeProfileCanvas.getContext('2d');
            if (!ctx) return;

            ctx.clearRect(0, 0, volumeProfileCanvas.width, volumeProfileCanvas.height);
            const width = volumeProfileCanvas.width;
            const height = volumeProfileCanvas.height;
            const pixelRatio = window.devicePixelRatio || 1;
            const { levels, maxVolumeLevel } = profile.data;
            const { colors, barWidth, position, alignLeft, showMedian } = profile.config;

            // Calculate profile dimensions and position
            // Make the profile width fixed at 80px to match the open interest profile
            const profileWidth = 80;
            let startX;

            // Determine starting X position based on alignment setting
            if (alignLeft) {
                // Position volume profile right after the Open Interest profile
                const openInterestProfileWidth = 80; // Width of the Open Interest profile
                startX = openInterestProfileWidth;

                // Draw a background for the entire profile column to block chart data
                ctx.fillStyle = 'rgba(15, 20, 26, 1.0)'; // Fully opaque background
                ctx.fillRect(startX, 0, profileWidth, height);

                // Draw vertical borders on both sides of the volume profile
                ctx.strokeStyle = 'rgba(100, 100, 100, 0.7)';
                ctx.lineWidth = 1;

                // Right border
                ctx.beginPath();
                ctx.moveTo(startX + profileWidth, 0);
                ctx.lineTo(startX + profileWidth, height);
                ctx.stroke();

                // Left border
                ctx.beginPath();
                ctx.moveTo(startX, 0);
                ctx.lineTo(startX, height);
                ctx.stroke();
            } else {
                // Otherwise use the position parameter for centered approach
                startX = width * position - (profileWidth / 2);

                // Draw a background for the entire profile column to block chart data
                ctx.fillStyle = 'rgba(15, 20, 26, 1.0)'; // Fully opaque background
                ctx.fillRect(startX, 0, profileWidth, height);

                // Draw vertical borders on both sides of the volume profile when centered
                ctx.strokeStyle = 'rgba(100, 100, 100, 0.7)';
                ctx.lineWidth = 1;

                // Right border
                ctx.beginPath();
                ctx.moveTo(startX + profileWidth, 0);
                ctx.lineTo(startX + profileWidth, height);
                ctx.stroke();

                // Left border (needed for centered profile)
                ctx.beginPath();
                ctx.moveTo(startX, 0);
                ctx.lineTo(startX, height);
                ctx.stroke();
            }

            const maxVolume = maxVolumeLevel.totalVolume;

            levels.forEach(level => {
                if (level.totalVolume === 0) return;

                const volumeRatio = level.totalVolume / maxVolume;
                const barLength = profileWidth * barWidth * volumeRatio;
                const y = priceToY(level.price, height);
                // Ensure minimum bar height of 1 pixel even with doubled price levels
                const barHeight = Math.max(1, Math.abs(priceToY(level.price + profile.data.priceStep, height) - y));

                // Calculate bar position based on alignment
                let barStartX;
                if (alignLeft) {
                    // If left-aligned, start at the left border with padding
                    barStartX = startX;
                } else {
                    // If centered, calculate center position
                    barStartX = startX + (profileWidth - barLength) / 2;
                }

                if (level.bullVolume > 0) {
                    const bullLength = barLength * (level.bullVolume / level.totalVolume);
                    ctx.fillStyle = colors.bullish;
                    ctx.fillRect(barStartX, y - barHeight / 2, bullLength, barHeight);

                    // Add outline with slightly more intense border
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                    ctx.lineWidth = 0.5;
                    ctx.strokeRect(barStartX, y - barHeight / 2, bullLength, barHeight);
                }

                if (level.bearVolume > 0) {
                    const bearLength = barLength * (level.bearVolume / level.totalVolume);
                    const bearStartX = barStartX + (barLength - bearLength);

                    ctx.fillStyle = colors.bearish;
                    ctx.fillRect(bearStartX, y - barHeight / 2, bearLength, barHeight);

                    // Add outline with slightly more intense border
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                    ctx.lineWidth = 0.5;
                    ctx.strokeRect(bearStartX, y - barHeight / 2, bearLength, barHeight);
                }
            });

            if (profile.data.levels?.length) {
                const sortedLevels = [...profile.data.levels].sort((a, b) => b.totalVolume - a.totalVolume);
                const totalVolume = sortedLevels.reduce((sum, level) => sum + level.totalVolume, 0);
                const valueAreaVolume = totalVolume * 0.7; // Standard 70% value area

                let cumulativeVolume = 0;
                const valueAreaLevels = [];

                // First add POC (Point of Control)
                const poc = sortedLevels[0];
                valueAreaLevels.push(poc);
                cumulativeVolume += poc.totalVolume;

                // Then add levels alternating above and below POC until we reach 70% volume
                let aboveIndex = 0;
                let belowIndex = 0;
                const pocIndex = sortedLevels.findIndex(level => level.price === poc.price);

                while (cumulativeVolume < valueAreaVolume &&
                       (pocIndex + aboveIndex + 1 < sortedLevels.length ||
                        pocIndex - belowIndex - 1 >= 0)) {

                    // Try to add level above if available
                    if (pocIndex + aboveIndex + 1 < sortedLevels.length) {
                        aboveIndex++;
                        const levelAbove = sortedLevels[pocIndex + aboveIndex];
                        if (!valueAreaLevels.includes(levelAbove)) {
                            valueAreaLevels.push(levelAbove);
                            cumulativeVolume += levelAbove.totalVolume;
                        }
                    }

                    // If we haven't reached 70% yet, try to add level below
                    if (cumulativeVolume < valueAreaVolume && pocIndex - belowIndex - 1 >= 0) {
                        belowIndex++;
                        const levelBelow = sortedLevels[pocIndex - belowIndex];
                        if (!valueAreaLevels.includes(levelBelow)) {
                            valueAreaLevels.push(levelBelow);
                            cumulativeVolume += levelBelow.totalVolume;
                        }
                    }
                }

                const valueAreaHigh = Math.max(...valueAreaLevels.map(level => level.price));
                const valueAreaLow = Math.min(...valueAreaLevels.map(level => level.price));
                const vahY = priceToY(valueAreaHigh, height);
                const valY = priceToY(valueAreaLow, height);

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.lineWidth = 2 * pixelRatio;
                ctx.setLineDash([4 * pixelRatio, 2 * pixelRatio]);

                // Draw VAH line only within the volume profile column
                ctx.beginPath();
                ctx.moveTo(startX, vahY);
                ctx.lineTo(startX + profileWidth, vahY);
                ctx.stroke();

                // Draw VAL line only within the volume profile column
                ctx.beginPath();
                ctx.moveTo(startX, valY);
                ctx.lineTo(startX + profileWidth, valY);
                ctx.stroke();

                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.font = `${Math.round(10 * pixelRatio)}px sans-serif`;
                ctx.textAlign = 'left';

                if (vahY > 10 && vahY < height - 10) {
                    // Position VAH label at the volume profile border
                    ctx.fillText(`VAH: ${valueAreaHigh.toFixed(2)}`, startX, vahY - 5);
                }
                if (valY > 10 && valY < height - 10) {
                    // Position VAL label at the volume profile border
                    ctx.fillText(`VAL: ${valueAreaLow.toFixed(2)}`, startX, valY - 5);
                }
            }

            if (showMedian && maxVolumeLevel) {
                const y = priceToY(maxVolumeLevel.price, height);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.lineWidth = 2 * pixelRatio;
                ctx.setLineDash([4 * pixelRatio, 2 * pixelRatio]);
                ctx.beginPath();
                ctx.moveTo(startX, y);
                ctx.lineTo(startX + profileWidth, y);
                ctx.stroke();
                ctx.setLineDash([]);

                // Add a label for the volume profile
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.font = `${Math.round(10 * pixelRatio)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText('VOLUME', startX + profileWidth / 2, 20);

                // Add a horizontal line below the title (matching liquidation console title)
                ctx.strokeStyle = 'rgba(100, 100, 100, 0.7)';
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(startX, 30);
                ctx.lineTo(startX + profileWidth, 30);
                ctx.stroke();

                if (y > 30 && y < height - 10) {
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                    ctx.font = `${Math.round(10 * pixelRatio)}px sans-serif`;
                    ctx.textAlign = 'left';
                    // Position POC label at the volume profile border
                    ctx.fillText(`POC: ${maxVolumeLevel.price.toFixed(2)}`, startX, y - 5);
                }
            }
        };

        profile.drawVolumeProfile = () => requestAnimationFrame(drawVolumeProfile);

        const debounce = (func, wait) => {
            let timeout;
            return (...args) => {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        };

        const debouncedDraw = debounce(drawVolumeProfile, 50);

        try {
            const resizeObserver = new ResizeObserver(() => {
                profile.priceRangeCache.timestamp = 0;
                debouncedDraw();
            });
            resizeObserver.observe(chartCanvas);
            resizeObserver.observe(chartContainer);
            profile.resizeObserver = resizeObserver;
        } catch (e) {
            console.warn('ResizeObserver not supported, falling back to window resize event');
            const windowResizeHandler = () => {
                profile.priceRangeCache.timestamp = 0;
                debouncedDraw();
            };
            window.addEventListener('resize', windowResizeHandler);
            profile.windowResizeHandler = windowResizeHandler;
        }

        const chartInteractionHandler = () => debouncedDraw();
        chartCanvas.addEventListener('mousemove', chartInteractionHandler);
        chartCanvas.addEventListener('click', chartInteractionHandler);
        profile.chartInteractionHandler = chartInteractionHandler;

        if (priceChart?.timeScale) {
            try {
                profile.timeScaleUnsubscribe = priceChart.timeScale().subscribeVisibleTimeRangeChange(() => {
                    profile.priceRangeCache.timestamp = 0;
                    debouncedDraw();
                });
            } catch (err) {
                console.warn('Could not subscribe to timeScale changes:', err);
            }
        }

        if (mergedConfig.liveUpdate) {
            const originalUpdate = chartState.throttledFunctions.throttledPriceUpdate;
            chartState.throttledFunctions.throttledPriceUpdate = function(bar) {
                originalUpdate.call(this, bar);

                // Check if this is a new candle
                const profile = profiles.get(chartState.config.ticker.symbol);
                if (!profile) return;

                // Get current candle time based on bar interval (usually 300 seconds for 5-min)
                const barInterval = chartState.config.barInterval || 300;
                const currentCandleTime = Math.floor(bar.time / barInterval) * barInterval;

                if (currentCandleTime > profile.lastCandleTime) {
                    // This is a new candle, update the lastCandleTime and refresh the volume profile
                    profile.lastCandleTime = currentCandleTime;
                    // New candle detected, refreshing volume profile

                    // Recalculate the volume profile with the latest data
                    // Make sure we're using the correct data source (chartState.data.priceData)
                    profile.data = calculateVolumeProfile(
                        chartState.data.priceData.slice(-profile.config.maxBars),
                        profile.config
                    );

                    // Force a complete redraw to ensure all calculations (POC, VAH, VAL) are updated
                    if (profile.drawVolumeProfile) {
                        profile.drawVolumeProfile();
                    }
                } else if (mergedConfig.liveUpdate) {
                    // Only do incremental updates if liveUpdate is enabled
                    // and we're within the same candle
                    updateProfile(chartState.config.ticker.symbol);
                }
            };
        }

        setTimeout(drawVolumeProfile, 100);
        const redrawInterval = setInterval(drawVolumeProfile, 1000);
        profile.redrawInterval = redrawInterval;

        return {
            update: () => updateProfile(chartState.config.ticker.symbol),
            toggle: () => toggleVisibility(chartState.config.ticker.symbol),
            config: profile.config, // Expose the config for external access
            cleanup: () => {
                if (profile.redrawInterval) {
                    clearInterval(profile.redrawInterval);
                    profile.redrawInterval = null;
                }
                if (profile.resizeObserver) {
                    profile.resizeObserver.disconnect();
                    profile.resizeObserver = null;
                }
                if (profile.windowResizeHandler) {
                    window.removeEventListener('resize', profile.windowResizeHandler);
                    profile.windowResizeHandler = null;
                }
                if (profile.chartInteractionHandler && profile.chartCanvas) {
                    profile.chartCanvas.removeEventListener('mousemove', profile.chartInteractionHandler);
                    profile.chartCanvas.removeEventListener('click', profile.chartInteractionHandler);
                    profile.chartInteractionHandler = null;
                }
                if (profile.timeScaleUnsubscribe) {
                    try {
                        profile.timeScaleUnsubscribe();
                    } catch (e) {
                        console.warn('Error unsubscribing from timeScale:', e);
                    }
                    profile.timeScaleUnsubscribe = null;
                }
                if (profile.volumeProfileCanvas) {
                    profile.volumeProfileCanvas.remove();
                    profile.volumeProfileCanvas = null;
                }
                profiles.delete(chartState.config.ticker.symbol);
            },
        };
    };

    return { initialize, updateProfile, toggleVisibility };
})();

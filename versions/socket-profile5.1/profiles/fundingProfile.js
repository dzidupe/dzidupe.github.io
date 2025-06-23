// Funding Rate Profile Data Provider for Lightweight Charts v5
// Provides data and color rendering for openInterestProfile.js

// Use window.BaseProfile and window.mathUtils for browser compatibility

window.fundingProfileManager = (() => {
    // Initialize global storage for funding rate data
    window.globalFundingData = window.globalFundingData || {};

    const DEFAULT_CONFIG = {
        priceRange: 150, // Default value, will be updated from localStorage in initialize
        barWidth: 0.8,
        colors: {
            positive: 'rgba(0, 240, 255, 0.7)', // Aqua for positive funding (buy-side dominance)
            negative: 'rgba(255, 30, 30, 0.7)', // Red for negative funding (sell-side dominance)
            neutral: 'rgba(150, 150, 150, 0.7)' // Gray for neutral funding
        },
        maxBars: 6000 // Doubled from 3000 to 6000
    };

    // Store profiles for each symbol
    const profiles = new Map();

    // Helper functions for data processing

    // Helper function to find closest bar - optimized with binary search for sorted data
    const findClosestBar = (bars, timestamp) => {
        if (!bars.length) return null;

        // Fast path for small arrays (less than 50 elements)
        if (bars.length < 50) {
            let closestBar = null;
            let minDistance = Infinity;
            for (const bar of bars) {
                const distance = Math.abs(bar.time - timestamp);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestBar = bar;
                }
            }
            return closestBar;
        }

        // Binary search for larger arrays (much faster for large datasets)
        let low = 0;
        let high = bars.length - 1;

        // Handle edge cases
        if (timestamp <= bars[low].time) return bars[low];
        if (timestamp >= bars[high].time) return bars[high];

        // Binary search to find the closest bar
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);

            if (mid + 1 <= high && bars[mid].time <= timestamp && bars[mid + 1].time > timestamp) {
                // Found the exact position or closest match
                return timestamp - bars[mid].time < bars[mid + 1].time - timestamp ? bars[mid] : bars[mid + 1];
            }

            if (bars[mid].time < timestamp) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        // If we get here, find the closest between the two nearest bars
        const lowBar = bars[Math.max(0, low - 1)];
        const highBar = bars[Math.min(bars.length - 1, low)];
        return Math.abs(lowBar.time - timestamp) < Math.abs(highBar.time - timestamp) ? lowBar : highBar;
    };

    // Calculate funding rate profile data - optimized for performance and accuracy
    const calculateFundingProfile = (priceData, fundingData, config, volumeProfileData = null, oiProfileData = null) => {
        if (!priceData?.length) return null;
        if (!fundingData?.length) {
            return { levels: [], maxFundingLevel: null, priceStep: 1, minPrice: 0, maxPrice: 1 };
        }

        try {
            // Use the same price range calculation as volume profile
            let minPrice = Infinity;
            let maxPrice = -Infinity;

            // First try to use volume profile's price range directly
            if (volumeProfileData && volumeProfileData.minPrice !== undefined && volumeProfileData.maxPrice !== undefined) {
                minPrice = volumeProfileData.minPrice;
                maxPrice = volumeProfileData.maxPrice;
            }
            // Then try OI profile's price range
            else if (oiProfileData && oiProfileData.minPrice !== undefined && oiProfileData.maxPrice !== undefined) {
                minPrice = oiProfileData.minPrice;
                maxPrice = oiProfileData.maxPrice;
            }
            // If neither is available, calculate from price data
            else {
                for (let i = 0; i < priceData.length; i++) {
                    const bar = priceData[i];
                    minPrice = Math.min(minPrice, bar.low);
                    maxPrice = Math.max(maxPrice, bar.high);
                }

                if (minPrice === Infinity || maxPrice === -Infinity || minPrice >= maxPrice) {
                    return null;
                }

                // Add fixed padding to price range for better visualization
                const { min: paddedMin, max: paddedMax } = (new window.BaseProfile()).padRange(minPrice, maxPrice, 0.05);
                minPrice = paddedMin;
                maxPrice = paddedMax;
            }

            const effectivePriceRange = config.priceRange;
            const priceStep = (maxPrice - minPrice) / effectivePriceRange;

            // Create price levels with optimized memory usage
            const priceLevels = new Array(effectivePriceRange).fill().map((_, i) => ({
                price: minPrice + (i * priceStep) + (priceStep / 2),
                fundingRates: [], // Store all funding rates for this price level
                avgFundingRate: 0, // Average funding rate for this level
                totalFunding: 0,   // Count of funding events at this level
                interpolated: true  // Flag to track if this level is interpolated
            }));

            // Sort funding data by timestamp
            const sortedFundingData = fundingData.slice().sort((a, b) => {
                const aTime = parseInt(a.fundingRateTimestamp || a.timestamp || a.time * 1000);
                const bTime = parseInt(b.fundingRateTimestamp || b.timestamp || b.time * 1000);
                return aTime - bTime;
            });

            // Function to find the most recent funding rate for a timestamp
            const findMostRecentFundingRate = (timestamp) => {
                let left = 0;
                let right = sortedFundingData.length - 1;
                let result = null;
                while (left <= right) {
                    const mid = Math.floor((left + right) / 2);
                    const midTime = parseInt(sortedFundingData[mid].fundingRateTimestamp || sortedFundingData[mid].timestamp || sortedFundingData[mid].time * 1000);
                    if (midTime <= timestamp) {
                        result = sortedFundingData[mid];
                        left = mid + 1;
                    } else {
                        right = mid - 1;
                    }
                }
                // Return both the funding rate and its source (funding or premium index)
                if (!result) return null;
                return {
                    rate: parseFloat(result.fundingRate),
                    source: result.isPremiumIndex ? 'premium' : 'funding'
                };
            };

            // Initialize funding rate collections for each price level
            const priceLevelFundingRates = priceLevels.map(() => []);

            // Assign funding rates based on price bars
            priceData.forEach(bar => {
                const fundingRateObj = findMostRecentFundingRate(bar.time * 1000); // bar.time in seconds
                if (fundingRateObj === null) return; // Skip if no rate available

                // Filter out extreme outliers (more than 0.3%)
                if (Math.abs(fundingRateObj.rate) > 0.003) return;

                // Find price levels covered by bar's range
                const lowLevelIndex = Math.floor((bar.low - minPrice) / priceStep);
                const highLevelIndex = Math.ceil((bar.high - minPrice) / priceStep);

                // Weight the funding rate by the bar's volume if available
                const weight = bar.volume ? Math.sqrt(bar.volume) : 1;

                // Apply confidence factor based on data source
                // Premium index data is less reliable than actual funding rate data
                const confidenceFactor = fundingRateObj.source === 'premium' ? 0.7 : 1.0;
                const adjustedWeight = weight * confidenceFactor;

                for (let i = Math.max(0, lowLevelIndex); i < Math.min(priceLevels.length, highLevelIndex + 1); i++) {
                    // Store the funding rate with its weight and source
                    priceLevelFundingRates[i].push({
                        rate: fundingRateObj.rate,
                        weight: adjustedWeight,
                        source: fundingRateObj.source
                    });
                }
            });

            // Calculate weighted average funding rates and populate levels
            priceLevels.forEach((level, i) => {
                const rateObjects = priceLevelFundingRates[i];
                if (rateObjects.length > 0) {
                    // Calculate weighted average
                    let weightedSum = 0;
                    let totalWeight = 0;

                    rateObjects.forEach(obj => {
                        weightedSum += obj.rate * obj.weight;
                        totalWeight += obj.weight;
                    });

                    // Store the average funding rate
                    level.avgFundingRate = totalWeight > 0 ? weightedSum / totalWeight : 0;

                    // Store the raw rates and sources for reference
                    level.fundingRates = rateObjects.map(obj => obj.rate);
                    level.sources = rateObjects.map(obj => obj.source).filter((v, i, a) => a.indexOf(v) === i); // Unique sources
                    level.totalFunding = rateObjects.length;
                    level.interpolated = false;

                    // Add time decay - give more weight to recent funding rates
                    // This is a simple implementation of time decay
                    if (level.fundingRates.length > 1) {
                        const recentBias = 0.7; // 70% weight to most recent half of data
                        const midpoint = Math.floor(level.fundingRates.length / 2);
                        const recentRates = level.fundingRates.slice(midpoint);
                        const olderRates = level.fundingRates.slice(0, midpoint);

                        if (recentRates.length > 0) {
                            const recentAvg = recentRates.reduce((sum, rate) => sum + rate, 0) / recentRates.length;
                            const olderAvg = olderRates.length > 0 ?
                                olderRates.reduce((sum, rate) => sum + rate, 0) / olderRates.length : recentAvg;

                            // Apply time decay bias
                            level.avgFundingRate = (recentAvg * recentBias) + (olderAvg * (1 - recentBias));
                        }
                    }
                }
            });

            // Interpolation for levels without data
            const levelsWithData = priceLevels.filter(level => level.fundingRates.length > 0);
            if (levelsWithData.length === 0) {
                console.warn('No price levels have funding data, cannot interpolate');
                return null;
            }
            const avgFundingRate = levelsWithData.reduce((sum, level) => sum + (level.avgFundingRate || 0), 0) / levelsWithData.length;

            for (let i = 0; i < priceLevels.length; i++) {
                const level = priceLevels[i];
                if (level.fundingRates.length === 0) {
                    let lowerLevel = null, upperLevel = null;
                    let lowerDist = Infinity, upperDist = Infinity;

                    for (let j = i - 1; j >= 0; j--) {
                        if (priceLevels[j].fundingRates.length > 0) {
                            lowerLevel = priceLevels[j];
                            lowerDist = i - j;
                            break;
                        }
                    }

                    for (let j = i + 1; j < priceLevels.length; j++) {
                        if (priceLevels[j].fundingRates.length > 0) {
                            upperLevel = priceLevels[j];
                            upperDist = j - i;
                            break;
                        }
                    }

                    if (lowerLevel && upperLevel) {
                        const lowerWeight = 1 / (lowerDist * lowerDist);
                        const upperWeight = 1 / (upperDist * upperDist);
                        const totalWeight = lowerWeight + upperWeight;
                        const normalizedLowerWeight = lowerWeight / totalWeight;
                        const normalizedUpperWeight = upperWeight / totalWeight;
                        const interpolatedRate = (lowerLevel.avgFundingRate * normalizedLowerWeight) + (upperLevel.avgFundingRate * normalizedUpperWeight);
                        level.fundingRates.push(interpolatedRate);
                        level.avgFundingRate = interpolatedRate;
                        level.totalFunding = 1;
                        level.interpolated = true;
                        // Track sources from both levels used for interpolation
                        level.sources = [...new Set([
                            ...(lowerLevel.sources || []),
                            ...(upperLevel.sources || []),
                            'interpolated'
                        ])];
                    } else if (lowerLevel) {
                        level.fundingRates.push(lowerLevel.avgFundingRate);
                        level.avgFundingRate = lowerLevel.avgFundingRate;
                        level.totalFunding = 1;
                        level.interpolated = true;
                        level.sources = [...new Set([
                            ...(lowerLevel.sources || []),
                            'interpolated'
                        ])];
                    } else if (upperLevel) {
                        level.fundingRates.push(upperLevel.avgFundingRate);
                        level.avgFundingRate = upperLevel.avgFundingRate;
                        level.totalFunding = 1;
                        level.interpolated = true;
                        level.sources = [...new Set([
                            ...(upperLevel.sources || []),
                            'interpolated'
                        ])];
                    } else {
                        level.fundingRates.push(avgFundingRate);
                        level.avgFundingRate = avgFundingRate;
                        level.totalFunding = 1;
                        level.interpolated = true;
                        level.sources = ['interpolated', 'global_average'];
                    }
                }
            }

            // Find the maximum absolute funding rate for scaling
            let maxAbsFundingRate = 0;
            priceLevels.forEach(level => {
                if (Math.abs(level.avgFundingRate) > maxAbsFundingRate) {
                    maxAbsFundingRate = Math.abs(level.avgFundingRate);
                }
            });
            maxAbsFundingRate = Math.max(maxAbsFundingRate, 0.0001);

            // Find the price level with the highest absolute funding rate
            const maxFundingLevel = priceLevels.reduce((max, level) =>
                Math.abs(level.avgFundingRate) > Math.abs(max.avgFundingRate) ? level : max,
                { avgFundingRate: 0 }
            );

            return {
                levels: priceLevels,
                maxFundingLevel: maxFundingLevel.avgFundingRate !== 0 ? maxFundingLevel : null,
                maxAbsFundingRate,
                priceStep,
                minPrice,
                maxPrice
            };
        } catch (error) {
            console.error('Error calculating funding profile:', error);
            return { levels: [], maxFundingLevel: null, priceStep: 1, minPrice: 0, maxPrice: 1 };
        }
    };

    // Update profile for a given symbol - simplified to only update data
    function updateProfile(symbol) {
        const profile = profiles.get(symbol);
        if (!profile?.dataLoaded) return;

        const { chartState, config } = profile;

        // Use references instead of creating copies to improve performance
        const recentData = chartState.data.priceData.slice(-config.maxBars);
        const fundingData = chartState.data.fundingData || [];
        if (!recentData.length) return;

        // Get volume and OI profile data for consistent price range
        const volumeProfileData = chartState.volumeProfile?.data;
        const oiProfileData = chartState.openInterestProfile?.data;

        // Recalculate the profile with the current config and consistent price range
        const newProfileData = calculateFundingProfile(
            recentData,
            fundingData,
            config,
            volumeProfileData,
            oiProfileData
        );

        if (newProfileData?.levels) {
            profile.data = newProfileData;
        }
    }

    // Toggle profile visibility - simplified to just update state
    function toggleVisibility(symbol) {
        const profile = profiles.get(symbol);
        if (!profile) return false;
        profile.visible = !profile.visible;
        return profile.visible;
    }

    // Utility function to get funding color for a specific price level
    function getFundingColorForPrice(symbol, price, priceStep) {
        const profile = profiles.get(symbol);
        if (!profile?.data?.levels?.length) return null;
        return profile.getFundingColorForPrice?.(price, priceStep) || null;
    }

    // Expose API at the end of the IIFE
})();
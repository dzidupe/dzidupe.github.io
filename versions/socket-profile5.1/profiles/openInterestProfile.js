// Open Interest Profile for Lightweight Charts
// Based on the volume profile implementation

window.openInterestProfileManager = (() => {
    // Constants and Defaults
    const DEFAULT_CONFIG = {
        priceRange: (() => {
            const savedVPLines = localStorage.getItem('volumeProfileLines');
            return savedVPLines ? parseInt(savedVPLines) : 150;
        })(),
        barWidth: 0.8,
        position: 0.1,
        alignLeft: true,
        colors: {
            bullish: 'rgba(192, 192, 192, 0.7)', // Grey color for OI bars
            bearish: 'rgba(64, 64, 64, 0.7)',
            median: 'rgba(255, 255, 255, 0.8)',
            // Enhanced color palette for dynamic coloration
            buyStrong: 'rgba(0, 240, 255, 0.8)',    // Strong buy - bright aqua
            buyMedium: 'rgba(0, 200, 255, 0.7)',    // Medium buy - medium aqua
            buyWeak: 'rgba(100, 200, 255, 0.6)',    // Weak buy - light blue
            neutral: 'rgba(150, 150, 150, 0.5)',    // Neutral - gray
            sellWeak: 'rgba(255, 100, 100, 0.6)',   // Weak sell - light red
            sellMedium: 'rgba(255, 50, 50, 0.7)',   // Medium sell - medium red
            sellStrong: 'rgba(255, 30, 30, 0.8)',   // Strong sell - bright red
        },
        // Thresholds for buy/sell determination (can be adjusted dynamically)
        thresholds: {
            buyStrong: 0.7,    // >70% buy ratio for strong buy
            buyMedium: 0.6,    // >60% buy ratio for medium buy
            buyWeak: 0.55,     // >55% buy ratio for weak buy
            sellWeak: 0.45,    // <45% buy ratio for weak sell
            sellMedium: 0.4,   // <40% buy ratio for medium sell
            sellStrong: 0.3,   // <30% buy ratio for strong sell
        },
        // Visual indicators for data sources
        dataSourceIndicators: true,
        // Market context awareness
        adaptiveColoration: true,
        showMedian: false,
        visible: true,
        liveUpdate: true,
        maxBars: 6000, // Doubled from 3000 to 6000
    };

    const profiles = new Map();

    // Utility Functions
    const debounce = (func, wait) => {
        let timeout;
        const debounced = function (...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), wait);
        };
        debounced.cancel = () => clearTimeout(timeout);
        return debounced;
    };

    const optimizeDataForCalculation = (priceData, maxBars) => {
        if (priceData.length <= maxBars) return priceData;
        return priceData.slice(-maxBars);
    };

    // Calculate adaptive thresholds based on recent market data
    const calculateAdaptiveThresholds = (recentData, config) => {
        // If no data or adaptiveColoration is disabled, return default thresholds
        if (!recentData || !recentData.length || !config.adaptiveColoration) {
            return config.thresholds;
        }

        // Extract buy ratios from recent data
        const buyRatios = [];
        recentData.forEach(point => {
            if (point.buyFlow > 0 || point.sellFlow > 0) {
                const totalFlow = point.buyFlow + point.sellFlow;
                buyRatios.push(point.buyFlow / totalFlow);
            }
        });

        // If not enough data points, return default thresholds
        if (buyRatios.length < 10) {
            return config.thresholds;
        }

        // Sort ratios to find distribution
        buyRatios.sort((a, b) => a - b);

        // Use percentiles to determine thresholds
        const getPercentile = (arr, percentile) => {
            const index = Math.floor(arr.length * percentile);
            return arr[Math.min(arr.length - 1, index)];
        };

        // Calculate adaptive thresholds based on distribution
        const adaptiveThresholds = {
            buyStrong: Math.min(0.8, Math.max(0.65, getPercentile(buyRatios, 0.85))),
            buyMedium: Math.min(0.7, Math.max(0.6, getPercentile(buyRatios, 0.7))),
            buyWeak: Math.min(0.6, Math.max(0.52, getPercentile(buyRatios, 0.6))),
            sellWeak: Math.min(0.48, Math.max(0.4, getPercentile(buyRatios, 0.4))),
            sellMedium: Math.min(0.4, Math.max(0.3, getPercentile(buyRatios, 0.3))),
            sellStrong: Math.min(0.35, Math.max(0.2, getPercentile(buyRatios, 0.15)))
        };

        return adaptiveThresholds;
    };

    // Analyze market context (trending, ranging, volatile)
    const analyzeMarketContext = (priceData) => {
        if (!priceData || priceData.length < 50) {
            return { type: 'normal', volatility: 0.5 };
        }

        const recentData = priceData.slice(-50);
        const firstPrice = recentData[0].close;
        const lastPrice = recentData[recentData.length - 1].close;
        const priceChange = (lastPrice - firstPrice) / firstPrice;

        // Calculate volatility
        const returns = [];
        for (let i = 1; i < recentData.length; i++) {
            returns.push(Math.abs(recentData[i].close / recentData[i-1].close - 1));
        }
        const avgReturn = returns.reduce((sum, val) => sum + val, 0) / returns.length;
        const volatility = Math.min(1, avgReturn * 100); // Scale for easier use

        // Determine market type
        let type = 'normal';
        if (volatility > 0.008) {
            type = 'volatile';
        } else if (Math.abs(priceChange) > 0.03) {
            type = priceChange > 0 ? 'uptrend' : 'downtrend';
        } else {
            type = 'ranging';
        }

        return { type, volatility, priceChange };
    };

    // Memoization for open interest profile calculation
    const oiProfileCache = new WeakMap();
    const calculateOpenInterestProfile = (priceData, openInterestData, config) => {
        if (oiProfileCache.has(priceData)) {
            const cached = oiProfileCache.get(priceData);
            if (cached.configHash === JSON.stringify(config) && cached.oiData === openInterestData) return cached.result;
        }
        try {
            if (!Array.isArray(priceData) || !priceData.length) return null;
            if (!Array.isArray(openInterestData)) openInterestData = [];
            config = { ...DEFAULT_CONFIG, ...config };

            const optimizedData = optimizeDataForCalculation(priceData, config.maxBars);
            if (!optimizedData || !optimizedData.length) return null;

            let minPrice = Infinity;
            let maxPrice = -Infinity;
            optimizedData.forEach(bar => {
                minPrice = Math.min(minPrice, bar.low);
                maxPrice = Math.max(maxPrice, bar.high);
            });
            if (minPrice === Infinity || maxPrice === -Infinity || minPrice >= maxPrice) return null;

            const padding = (maxPrice - minPrice) * 0.05;
            minPrice -= padding;
            maxPrice += padding;

            const priceStep = (maxPrice - minPrice) / config.priceRange;
            const priceLevels = Array.from({ length: config.priceRange }, (_, i) => ({
                price: minPrice + (i * priceStep) + (priceStep / 2),
                totalOI: 0,
                oiChange: 0,       // Track change in open interest
                buyPressure: 0,    // Positive value indicates buy pressure
                sellPressure: 0,   // Positive value indicates sell pressure
                buyFlow: 0,        // Tracks buy orders from order flow data
                sellFlow: 0,       // Tracks sell orders from order flow data
                flowConfidence: 0  // Confidence level in the order flow data (0-1)
            }));

            if (openInterestData.length) {
                // Sort open interest data by time (oldest to newest)
                const sortedOIData = [...openInterestData].sort((a, b) => a.time - b.time);

                // Process open interest data to calculate changes and pressure
                const oiByLevel = new Map(); // Map to track OI by price level

                sortedOIData.forEach(oiPoint => {
                    if (!oiPoint.price || !oiPoint.openInterest) return;

                    // Find the closest price level
                    let closestLevel = null;
                    let minDistance = Infinity;
                    let levelIndex = -1;

                    for (let i = 0; i < priceLevels.length; i++) {
                        const level = priceLevels[i];
                        const distance = Math.abs(level.price - oiPoint.price);
                        if (distance < minDistance) {
                            minDistance = distance;
                            closestLevel = level;
                            levelIndex = i;
                        }
                    }

                    if (closestLevel && minDistance <= priceStep * 1.5) {
                        // Add to total OI
                        closestLevel.totalOI += oiPoint.openInterest;

                        // Calculate OI change
                        const levelKey = levelIndex.toString();
                        const prevOI = oiByLevel.get(levelKey) || 0;
                        const oiChange = oiPoint.openInterest - prevOI;

                        // Store current OI for next comparison
                        oiByLevel.set(levelKey, oiPoint.openInterest);

                        // Update OI change
                        if (oiChange !== 0) {
                            closestLevel.oiChange += oiChange;

                            // Calculate the relative size of this OI change compared to the average
                            // This gives more weight to larger position changes
                            const avgOIChange = closestLevel.totalOI > 0 ? closestLevel.totalOI / 10 : 1; // Assume average is 10% of total
                            const sizeMultiplier = Math.min(3, Math.max(0.5, Math.abs(oiChange) / avgOIChange));

                            // Apply size multiplier to make larger changes have more impact
                            const weightedChange = oiChange * sizeMultiplier;

                            // First check if we have order flow data for this point
                            if (oiPoint.hasOrderFlow && oiPoint.buyFlow + oiPoint.sellFlow > 0) {
                                // We have order flow data - use it as the primary signal
                                const totalFlow = oiPoint.buyFlow + oiPoint.sellFlow;
                                const buyRatio = oiPoint.buyFlow / totalFlow;

                                // Update the flow data for this level
                                closestLevel.buyFlow += oiPoint.buyFlow;
                                closestLevel.sellFlow += oiPoint.sellFlow;

                                // Increase confidence in order flow data
                                closestLevel.flowConfidence = Math.min(1, closestLevel.flowConfidence + 0.2);

                                if (oiChange > 0) { // OI increased
                                    if (buyRatio > 0.6) {
                                        // Strong buy flow (>60% buy orders)
                                        closestLevel.buyPressure += weightedChange * buyRatio;
                                        closestLevel.sellPressure += weightedChange * (1 - buyRatio);
                                    } else if (buyRatio < 0.4) {
                                        // Strong sell flow (<40% buy orders)
                                        closestLevel.sellPressure += weightedChange * (1 - buyRatio);
                                        closestLevel.buyPressure += weightedChange * buyRatio;
                                    } else {
                                        // Mixed flow - distribute based on exact ratio
                                        closestLevel.buyPressure += weightedChange * buyRatio;
                                        closestLevel.sellPressure += weightedChange * (1 - buyRatio);
                                    }
                                }
                            } else {
                                // No order flow data - fall back to price change and funding rate
                                const priceChange = oiPoint.priceChange || 0;
                                const fundingRate = oiPoint.fundingRate || 0;

                                // Positive price change + positive funding rate = stronger buy signal
                                // Negative price change + negative funding rate = stronger sell signal
                                if (oiChange > 0) { // OI increased
                                    if (priceChange > 0 || fundingRate > 0) {
                                        // Price going up or positive funding rate suggests buy pressure
                                        closestLevel.buyPressure += weightedChange;
                                    } else if (priceChange < 0 || fundingRate < 0) {
                                        // Price going down or negative funding rate suggests sell pressure
                                        closestLevel.sellPressure += weightedChange;
                                    } else {
                                        // Neutral case - distribute evenly
                                        closestLevel.buyPressure += weightedChange / 2;
                                        closestLevel.sellPressure += weightedChange / 2;
                                    }
                                }
                            }
                        }
                    }
                });
            }

            // Calculate maximum values for scaling
            const maxOI = Math.max(1, ...priceLevels.map(level => level.totalOI));
            const maxBuyPressure = Math.max(1, ...priceLevels.map(level => level.buyPressure));
            const maxSellPressure = Math.max(1, ...priceLevels.map(level => level.sellPressure));

            return {
                levels: priceLevels,
                maxOI,
                maxBuyPressure,
                maxSellPressure,
                priceStep,
                minPrice,
                maxPrice
            };
        } catch (error) {
            console.error('Error calculating open interest profile:', error);
            return null;
        }
    };

    // Profile Management
    const updateProfile = (symbol) => {
        const profile = profiles.get(symbol);
        if (!profile || !profile.dataLoaded) return;

        const { chartState, config } = profile;
        const updateProfileData = () => {
            try {
                const currentPriceRange = config.priceRange;
                const recentData = chartState.data.priceData.slice(-config.maxBars).map(bar => ({ ...bar }));
                const openInterestData = (chartState.data.openInterestData || []).map(point => ({ ...point }));
                if (!recentData.length) return;

                // Update market context analysis if adaptive coloration is enabled
                if (config.adaptiveColoration) {
                    profile.marketContext = analyzeMarketContext(recentData);

                    // Recalculate adaptive thresholds periodically
                    const now = Date.now();
                    if (!profile.lastThresholdUpdate || now - profile.lastThresholdUpdate > 60000) { // Update every minute
                        profile.adaptiveThresholds = calculateAdaptiveThresholds(openInterestData, config);
                        profile.lastThresholdUpdate = now;
                    }
                }

                const newProfileData = calculateOpenInterestProfile(recentData, openInterestData, { ...config });
                if (newProfileData && newProfileData.levels) {
                    profile.data = newProfileData;
                    config.priceRange = currentPriceRange;
                    profile.drawOpenInterestProfile?.();
                }
            } catch (error) {
                console.error('Error updating open interest profile:', error);
            }
        };

        if (!profile.debouncedUpdate) profile.debouncedUpdate = debounce(updateProfileData, 200);
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
        profile.drawOpenInterestProfile?.();
        return profile.visible;
    };

    // Initialization and Drawing
    const initialize = (chartState, config = {}) => {
        const mergedConfig = { ...DEFAULT_CONFIG, ...config };
        const { chartContainer, chart: { priceChart, priceSeries } } = chartState;

        const profile = {
            config: mergedConfig,
            chartState,
            data: null,
            visible: mergedConfig.visible,
            priceRangeCache: { topPrice: null, bottomPrice: null, height: null, timestamp: Date.now() },
            lastCandleTime: Math.floor(Date.now() / 1000 / chartState.config.barInterval) * chartState.config.barInterval,
            dataLoaded: false,
            // Initialize market context and adaptive thresholds
            marketContext: mergedConfig.adaptiveColoration ? analyzeMarketContext(chartState.data.priceData) : { type: 'normal', volatility: 0.5 },
            adaptiveThresholds: mergedConfig.thresholds,
            lastThresholdUpdate: Date.now()
        };

        profiles.set(chartState.config.ticker.symbol, profile);
        chartState.data.openInterestData = [];

        if (window.bybitWsManager) {
            const symbol = `${chartState.config.ticker.symbol}USDT`;
            const tickerChannel = `tickers.${symbol}`;
            const fundingChannel = `funding.${symbol}`;
            let latestFundingRate = 0;

            const loadOpenInterestData = async () => {
                try {
                    const endTime = Date.now();
                    const startTime = endTime - (6000 * 5 * 60 * 1000) - (12 * 60 * 60 * 1000);
                    const category = 'linear';
                    // Only use 5-minute interval
                    const interval = '5min';
                    let historicalOI = [];
                    const timeMap = new Map();
                    let totalDataPoints = 0;

                    // Fetch data in parallel batches
                    const maxBatches = 8; // Number of parallel batches
                    const batchPromises = [];

                    // Create multiple API calls in parallel
                    for (let batchCount = 0; batchCount < maxBatches; batchCount++) {
                        // Calculate time offset for each batch to cover different time periods
                        const timeOffset = batchCount === 0 ? 0 : (batchCount * 1000 * 300); // Offset by 1000 bars * 300 seconds each
                        const batchEndTime = endTime - timeOffset;

                        const apiUrl = `https://api.bybit.com/v5/market/open-interest?category=${category}&symbol=${symbol}&intervalTime=${interval}&startTime=${startTime}&endTime=${batchEndTime}&limit=1000`;

                        // Add the fetch promise to the batch
                        batchPromises.push(
                            (async () => {
                                try {
                                    let response;
                                    try {
                                        response = await fetch(apiUrl, { mode: 'cors' });
                                    } catch {
                                        try {
                                            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`;
                                            response = await fetch(proxyUrl);
                                        } catch {
                                            const altProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`;
                                            response = await fetch(altProxyUrl);
                                        }
                                    }

                                    if (!response.ok) return [];
                                    const data = await response.json();
                                    if (data.retCode !== 0 || !data.result.list.length) return [];

                                    return [...data.result.list].reverse();
                                } catch (e) {
                                    return [];
                                }
                            })()
                        );
                    }

                    // Wait for all requests to complete
                    const batchResults = await Promise.all(batchPromises);

                    // Process all batch results
                    for (const batchList of batchResults) {
                        if (batchList.length > 0) {
                            totalDataPoints += batchList.length;
                            processOpenInterestData(batchList, historicalOI, chartState.data.priceData, latestFundingRate, timeMap);
                        }
                    }

                    if (totalDataPoints === 0) {
                        console.log('No data returned from API calls, check API endpoints');
                    }

                    historicalOI.sort((a, b) => a.time - b.time);
                    if (historicalOI.length > 6000) historicalOI = historicalOI.slice(-6000);

                    if (historicalOI.length < 4000) {
                        await fetchDataInParallel();
                    } else {
                        chartState.data.openInterestData = historicalOI;
                        profile.data = calculateOpenInterestProfile(
                            chartState.data.priceData.slice(-profile.config.maxBars),
                            chartState.data.openInterestData,
                            profile.config
                        );
                        profile.dataLoaded = true;
                        updateProfile(chartState.config.ticker.symbol);
                    }
                } catch (error) {
                    console.error('Error loading open interest data:', error);
                    chartState.data.openInterestData = [];
                    profile.dataLoaded = true;
                    profile.data = calculateOpenInterestProfile(
                        chartState.data.priceData.slice(-profile.config.maxBars),
                        chartState.data.openInterestData,
                        profile.config
                    );
                    updateProfile(chartState.config.ticker.symbol);
                }

                function processOpenInterestData(list, historicalOI, priceData, fundingRate, timeMap) {
                    list.forEach(item => {
                        const timestamp = parseInt(item.timestamp) / 1000;
                        if (timeMap.has(timestamp)) return;
                        const closestBar = findClosestBar(priceData, timestamp);
                        if (closestBar) {
                            const openInterestValue = parseFloat(item.openInterest);

                            // Create the OI data point with additional fields for order flow
                            const oiPoint = {
                                time: closestBar.time,
                                price: closestBar.close,
                                openInterest: openInterestValue,
                                priceChange: (closestBar.close - closestBar.open) / closestBar.open,
                                fundingRate,
                                // Initialize order flow fields (will be populated later if available)
                                buyFlow: 0,
                                sellFlow: 0,
                                hasOrderFlow: false
                            };

                            historicalOI.push(oiPoint);
                            timeMap.set(timestamp, true);
                        }
                    });
                }

                // New function to process order flow data and merge with OI data
                function processOrderFlowData(orderFlowData, historicalOI, priceStep) {
                    if (!orderFlowData || !orderFlowData.length || !historicalOI || !historicalOI.length) return;

                    // Sort order flow data by time
                    orderFlowData.sort((a, b) => a.time - b.time);

                    // Create a map of OI data points by time for quick lookup
                    const oiByTime = new Map();
                    historicalOI.forEach(oiPoint => {
                        oiByTime.set(oiPoint.time, oiPoint);
                    });

                    // Process each order flow data point
                    orderFlowData.forEach(flowPoint => {
                        // Find the closest OI data point in time
                        const closestTime = findClosestTime(flowPoint.time, historicalOI);
                        if (!closestTime) return;

                        const oiPoint = oiByTime.get(closestTime);
                        if (!oiPoint) return;

                        // Check if the price levels are close enough
                        if (Math.abs(oiPoint.price - flowPoint.price) <= priceStep * 1.5) {
                            // Add order flow data to the OI point
                            oiPoint.buyFlow = (oiPoint.buyFlow || 0) + (flowPoint.buyVolume || 0);
                            oiPoint.sellFlow = (oiPoint.sellFlow || 0) + (flowPoint.sellVolume || 0);
                            oiPoint.hasOrderFlow = true;
                        }
                    });
                }

                // Helper function to find the closest time in the OI data
                function findClosestTime(time, oiData) {
                    if (!oiData || !oiData.length) return null;

                    let closestTime = null;
                    let minDiff = Infinity;

                    for (const point of oiData) {
                        const diff = Math.abs(point.time - time);
                        if (diff < minDiff) {
                            minDiff = diff;
                            closestTime = point.time;
                        }
                    }

                    // Only return if within 5 minutes (300 seconds)
                    return minDiff <= 300 ? closestTime : null;
                }

                // Function to fetch order flow data from the exchange
                async function fetchOrderFlowData() {
                    try {
                        // This is a placeholder for the actual API call to fetch order flow data
                        // In a real implementation, you would call the exchange's API to get order flow data
                        // For example: trades with aggressor flag, market orders vs limit orders, etc.

                        // For now, we'll simulate order flow data based on recent trades

                        // Use the correct Bybit API endpoint for recent trades
                        // The endpoint is 'recent-trade' (singular) in Bybit v5 API
                        const apiUrl = `https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${symbol}USDT&limit=1000`;

                        let response;
                        try {
                            response = await fetch(apiUrl, { mode: 'cors' });
                        } catch {
                            try {
                                const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`;
                                response = await fetch(proxyUrl);
                            } catch {
                                const altProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`;
                                response = await fetch(altProxyUrl);
                            }
                        }

                        if (!response || !response.ok) {
                            console.log('Failed to fetch order flow data, falling back to other signals');
                            return null;
                        }

                        const data = await response.json();
                        if (data.retCode !== 0 || !data.result || !data.result.list) {
                            return null;
                        }

                        // Process the trade data into order flow data
                        const orderFlowData = [];
                        data.result.list.forEach(trade => {
                            // Handle different response formats
                            // The recent-trade endpoint uses 'time' field (timestamp in milliseconds)
                            const timestamp = parseInt(trade.time);
                            const price = parseFloat(trade.price);
                            // The recent-trade endpoint uses 'size' field
                            const size = parseFloat(trade.size);
                            const side = trade.side.toLowerCase(); // 'buy' or 'sell'

                            // Create order flow data point
                            orderFlowData.push({
                                time: Math.floor(timestamp / 1000), // Convert to seconds
                                price: price,
                                buyVolume: side === 'buy' ? size : 0,
                                sellVolume: side === 'sell' ? size : 0
                            });
                        });

                        return orderFlowData;
                    } catch (error) {
                        console.error('Error fetching order flow data:', error);
                        return null;
                    }
                }

                async function fetchDataInParallel() {
                    try {
                        const interval = '5min'; // Only use 5-minute interval
                        const endTime = Date.now();
                        const totalDuration = 6000 * 5 * 60 * 1000; // 6000 bars of 5-minute data

                        // Create more parallel requests with smaller time chunks for better performance
                        const numChunks = 24; // Increased from 20 to 24 for more parallelism
                        const chunkSize = totalDuration / numChunks;

                        // Create time ranges for parallel fetching
                        const timeRanges = Array.from({ length: numChunks }, (_, i) => ({
                            start: endTime - ((i + 1) * chunkSize),
                            end: i === 0 ? endTime : endTime - (i * chunkSize),
                        }));

                        // Function to fetch a single chunk of data
                        const fetchChunk = async (startTime, endTime) => {
                            const apiUrl = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
                            let response;
                            try {
                                response = await fetch(apiUrl, { mode: 'cors' });
                            } catch {
                                try {
                                    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`;
                                    response = await fetch(proxyUrl);
                                } catch {
                                    const altProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`;
                                    response = await fetch(altProxyUrl);
                                }
                            }
                            if (!response.ok) return [];
                            const data = await response.json();
                            return data.retCode === 0 ? data.result.list : [];
                        };

                        // Fetch both open interest data and order flow data in parallel
                        const [chunkResults, orderFlowData] = await Promise.all([
                            Promise.all(timeRanges.map(range => fetchChunk(range.start, range.end))),
                            fetchOrderFlowData()
                        ]);

                        let allData = [].concat(...chunkResults);
                        const uniqueData = [];
                        const timestampSet = new Set();
                        allData.forEach(item => {
                            if (!timestampSet.has(item.timestamp)) {
                                timestampSet.add(item.timestamp);
                                uniqueData.push(item);
                            }
                        });
                        uniqueData.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
                        const processedData = [];
                        const timeMap = new Map();
                        uniqueData.forEach(item => {
                            const timestamp = parseInt(item.timestamp) / 1000;
                            if (timeMap.has(timestamp)) return;
                            const closestBar = findClosestBar(chartState.data.priceData, timestamp);
                            if (closestBar) {
                                const openInterestValue = parseFloat(item.openInterest);
                                processedData.push({
                                    time: closestBar.time,
                                    price: closestBar.close,
                                    openInterest: openInterestValue,
                                    priceChange: (closestBar.close - closestBar.open) / closestBar.open,
                                    fundingRate: latestFundingRate,
                                    // Initialize order flow fields
                                    buyFlow: 0,
                                    sellFlow: 0,
                                    hasOrderFlow: false
                                });
                                timeMap.set(timestamp, true);
                            }
                        });

                        // Process and merge order flow data if available
                        if (orderFlowData && orderFlowData.length > 0) {
                            // Calculate price step for matching order flow data to OI data points
                            const priceStep = profile.data?.priceStep ||
                                (chartState.data.priceData.length > 0 ?
                                    chartState.data.priceData[chartState.data.priceData.length - 1].close * 0.0001 : 1);

                            processOrderFlowData(orderFlowData, processedData, priceStep);
                        }
                        processedData.sort((a, b) => a.time - b.time);
                        const finalData = processedData.slice(-6000);
                        chartState.data.openInterestData = finalData;
                        profile.data = calculateOpenInterestProfile(
                            chartState.data.priceData.slice(-profile.config.maxBars),
                            chartState.data.openInterestData,
                            profile.config
                        );
                        profile.dataLoaded = true;
                        updateProfile(chartState.config.ticker.symbol);
                    } catch (error) {
                        console.error('Error fetching data in parallel:', error);
                        profile.dataLoaded = true;
                        profile.data = calculateOpenInterestProfile(
                            chartState.data.priceData.slice(-profile.config.maxBars),
                            chartState.data.openInterestData || [],
                            profile.config
                        );
                        updateProfile(chartState.config.ticker.symbol);
                    }
                }

                function findClosestBar(priceBars, timestamp) {
                    if (!priceBars.length) return null;
                    let closestBar = null;
                    let minDistance = Infinity;
                    for (const bar of priceBars) {
                        const distance = Math.abs(bar.time - timestamp);
                        if (distance < minDistance) {
                            minDistance = distance;
                            closestBar = bar;
                        }
                    }
                    return closestBar;
                }
            };

            loadOpenInterestData();

            window.bybitWsManager.subscribe(fundingChannel, data => {
                if (data.topic === fundingChannel && data.data) {
                    latestFundingRate = parseFloat(data.data.fundingRate || 0);
                }
            });

            window.bybitWsManager.subscribe(tickerChannel, data => {
                if (data.topic === tickerChannel && data.data) {
                    const { openInterest, lastPrice, price24hPcnt } = data.data;
                    if (openInterest && lastPrice) {
                        const price = parseFloat(lastPrice);
                        const openInterestValue = parseFloat(openInterest);
                        const priceChangePercent = parseFloat(price24hPcnt || 0);
                        chartState.data.openInterestData.push({
                            time: Math.floor(Date.now() / 1000),
                            price,
                            openInterest: openInterestValue,
                            priceChange: priceChangePercent,
                            fundingRate: latestFundingRate,
                            // Initialize order flow fields for real-time data
                            buyFlow: 0,
                            sellFlow: 0,
                            hasOrderFlow: false
                        });
                        if (chartState.data.openInterestData.length > mergedConfig.maxBars) {
                            chartState.data.openInterestData = chartState.data.openInterestData.slice(-mergedConfig.maxBars);
                        }
                        if (mergedConfig.liveUpdate) updateProfile(chartState.config.ticker.symbol);
                    }
                }
            });
        }

        updateProfile(chartState.config.ticker.symbol);

        if (!chartContainer || !priceChart) return null;

        const openInterestProfileCanvas = document.createElement('canvas');
        openInterestProfileCanvas.id = 'open-interest-profile-canvas';
        Object.assign(openInterestProfileCanvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            pointerEvents: 'none',
            zIndex: '5',
        });
        chartContainer.appendChild(openInterestProfileCanvas);
        profile.openInterestProfileCanvas = openInterestProfileCanvas;

        const chartCanvas = chartContainer.querySelector('canvas');
        if (!chartCanvas) return null;
        profile.chartCanvas = chartCanvas;

        const priceToY = (price, height) => {
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
                const visibleBars = priceChart.timeScale().getVisibleRange();
                if (!visibleBars) return height / 2;
                const now = Date.now();
                const cacheExpiry = 500;
                if (profile.priceRangeCache.timestamp + cacheExpiry > now && profile.priceRangeCache.height === height) {
                    topPrice = profile.priceRangeCache.topPrice;
                    bottomPrice = profile.priceRangeCache.bottomPrice;
                } else {
                    const visibleData = chartState.data.priceData.filter(
                        bar => bar.time >= visibleBars.from && bar.time <= visibleBars.to
                    );
                    if (!visibleData.length) return height / 2;
                    topPrice = Math.max(...visibleData.map(bar => bar.high));
                    bottomPrice = Math.min(...visibleData.map(bar => bar.low));
                    const padding = (topPrice - bottomPrice) * 0.1;
                    topPrice += padding;
                    bottomPrice -= padding;
                    profile.priceRangeCache = { topPrice, bottomPrice, height, timestamp: Date.now() };
                }
            }
            const priceDiff = topPrice - bottomPrice;
            return priceDiff === 0 ? height / 2 : height - ((price - bottomPrice) / priceDiff * height);
        };

        const drawOpenInterestProfile = () => {
            try {
                if (!profile.dataLoaded) {
                    const ctx = openInterestProfileCanvas.getContext('2d');
                    if (ctx) {
                        if (chartCanvas.width !== openInterestProfileCanvas.width || chartCanvas.height !== openInterestProfileCanvas.height) {
                            openInterestProfileCanvas.width = chartCanvas.width;
                            openInterestProfileCanvas.height = chartCanvas.height;
                        }
                        ctx.clearRect(0, 0, openInterestProfileCanvas.width, openInterestProfileCanvas.height);
                        const height = openInterestProfileCanvas.height;
                        // Move OI profile to where funding profile was (right after liquidation console)
                        const liquidationConsoleWidth = profile.config.liquidationConsoleWidth || 85;
                        const profileWidth = 80;
                        // Add 1px offset for better visual separation from liquidation console (same as funding profile used)
                        const startX = liquidationConsoleWidth + 1;
                        ctx.fillStyle = 'rgba(15, 20, 26, 1.0)';
                        ctx.fillRect(startX, 0, profileWidth, height);
                        ctx.strokeStyle = 'rgba(100, 100, 100, 0.7)';
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(startX + profileWidth, 0);
                        ctx.lineTo(startX + profileWidth, height);
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.moveTo(startX, 0);
                        ctx.lineTo(startX, height);
                        ctx.stroke();
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                        ctx.font = '10px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('OI', startX + profileWidth / 2, 20);
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(startX, 30);
                        ctx.lineTo(startX + profileWidth, 30);
                        ctx.stroke();
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                        ctx.font = '9px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('Loading...', startX + profileWidth / 2, height / 2);
                        const now = Date.now();
                        const phase = (now % 2000) / 2000;
                        const radius = 10;
                        const centerX = startX + profileWidth / 2;
                        const centerY = height / 2 + 20;
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2 * phase);
                        ctx.stroke();
                    }
                    return;
                }

                if (!profile.visible || !profile.data?.levels || !openInterestProfileCanvas || !chartCanvas) return;
                if (!Array.isArray(profile.data.levels) || profile.data.levels.length === 0) return;

                if (chartCanvas.width !== openInterestProfileCanvas.width || chartCanvas.height !== openInterestProfileCanvas.height) {
                    openInterestProfileCanvas.width = chartCanvas.width;
                    openInterestProfileCanvas.height = chartCanvas.height;
                }
                const ctx = openInterestProfileCanvas.getContext('2d');
                if (!ctx) return;

                ctx.clearRect(0, 0, openInterestProfileCanvas.width, openInterestProfileCanvas.height);
                const height = openInterestProfileCanvas.height;
                const pixelRatio = window.devicePixelRatio || 1;
                const { levels } = profile.data;
                const { barWidth } = profile.config;
                const profileWidth = 80;
                // Position OI profile at the left border of the chart container
                const startX = 0;

                ctx.fillStyle = 'rgba(15, 20, 26, 1.0)';
                ctx.fillRect(startX, 0, profileWidth, height);
                ctx.strokeStyle = 'rgba(100, 100, 100, 0.7)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(startX + profileWidth, 0);
                ctx.lineTo(startX + profileWidth, height);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(startX, 0);
                ctx.lineTo(startX, height);
                ctx.stroke();

                const maxOI = Math.max(1, ...levels.map(level => level.totalOI));
                ctx.save();
                ctx.scale(pixelRatio, pixelRatio);

                // We don't need market context for the new coloration system

                // We don't need adaptive thresholds for the new coloration system

                // We don't need the color palette for the new coloration system

                // Calculate position concentration and liquidation vulnerability
                const calculatePositionConcentration = (level) => {
                    // Base concentration on total OI at this level relative to nearby levels
                    const oiRatio = level.totalOI / maxOI;

                    // Calculate directional bias based on available signals
                    let longBias = 0.5; // Default to neutral
                    let signalConfidence = 0;

                    // Use order flow data if available (most reliable)
                    if (level.buyFlow > 0 || level.sellFlow > 0) {
                        const totalFlow = level.buyFlow + level.sellFlow;
                        longBias = level.buyFlow / totalFlow;
                        signalConfidence = Math.min(1, totalFlow / (level.totalOI * 0.1));
                    }
                    // Otherwise use buy/sell pressure
                    else if (level.buyPressure > 0 || level.sellPressure > 0) {
                        const totalPressure = level.buyPressure + level.sellPressure;
                        longBias = level.buyPressure / totalPressure;
                        signalConfidence = Math.min(1, totalPressure / (level.totalOI * 0.15));
                    }

                    // Use funding rate to adjust bias (critical for identifying leveraged positions)
                    let fundingRate = 0;
                    let hasFundingData = false;

                    if (chartState.fundingProfile && window.fundingProfileManager) {
                        const fundingProfile = window.fundingProfileManager.getProfile(chartState.config.ticker.symbol);
                        if (fundingProfile && fundingProfile.data && fundingProfile.data.levels) {
                            const matchingLevel = fundingProfile.data.levels.find(fLevel =>
                                Math.abs(fLevel.price - level.price) < profile.data.priceStep / 2);

                            if (matchingLevel && matchingLevel.avgFundingRate !== undefined) {
                                fundingRate = matchingLevel.avgFundingRate;
                                hasFundingData = true;

                                // Positive funding rate means longs are paying shorts
                                // This indicates excessive long positions
                                if (fundingRate > 0) {
                                    // Increase long bias confidence if order flow also shows long bias
                                    if (longBias > 0.5) {
                                        // The higher the funding rate, the more we adjust the bias
                                        const adjustment = Math.min(0.3, fundingRate * 1500);
                                        longBias = Math.min(0.95, longBias + adjustment);
                                        signalConfidence = Math.min(1, signalConfidence + 0.2);
                                    }
                                }
                                // Negative funding rate means shorts are paying longs
                                // This indicates excessive short positions
                                else if (fundingRate < 0) {
                                    // Increase short bias confidence if order flow also shows short bias
                                    if (longBias < 0.5) {
                                        // The more negative the funding rate, the more we adjust the bias
                                        const adjustment = Math.min(0.3, Math.abs(fundingRate) * 1500);
                                        longBias = Math.max(0.05, longBias - adjustment);
                                        signalConfidence = Math.min(1, signalConfidence + 0.2);
                                    }
                                }
                            }
                        }
                    }

                    // Calculate one-sidedness (0 = neutral, 1 = completely one-sided)
                    const oneSidedness = Math.abs(longBias - 0.5) * 2;

                    // Calculate liquidation vulnerability
                    // Higher for extreme bias + high OI + high confidence
                    const liquidationVulnerability = oiRatio * oneSidedness * (0.5 + (signalConfidence * 0.5));

                    return {
                        oiRatio,
                        longBias,
                        oneSidedness,
                        signalConfidence,
                        liquidationVulnerability,
                        isLongHeavy: longBias > 0.5,
                        fundingRate,
                        hasFundingData
                    };
                };

                // Get color based on position concentration and liquidation vulnerability
                const getLiquidationVulnerabilityColor = (concentration) => {
                    const { oiRatio, liquidationVulnerability, isLongHeavy } = concentration;

                    // Only highlight significant concentrations
                    if (liquidationVulnerability < 0.15 || oiRatio < 0.1) {
                        return { color: 'rgba(100, 100, 100, 0.5)' }; // Neutral gray for insignificant levels
                    }

                    // Scale vulnerability for visual impact (0.15-1.0 range to 0-1 range)
                    const scaledVulnerability = Math.min(1, (liquidationVulnerability - 0.15) / 0.85);

                    // Base alpha on OI ratio and vulnerability
                    const alpha = Math.max(0.3, Math.min(0.9, 0.3 + (oiRatio * 0.3) + (scaledVulnerability * 0.3)));

                    // Color hue based on long/short bias
                    if (isLongHeavy) {
                        // Long-heavy positions - use aqua/cyan colors consistent with codebase
                        // More intense aqua = more vulnerable to liquidation
                        const r = 0;
                        const g = Math.min(255, 200 + Math.round(55 * scaledVulnerability));
                        const b = Math.min(255, 220 + Math.round(35 * scaledVulnerability));
                        return { color: `rgba(${r}, ${g}, ${b}, ${alpha})` };
                    } else {
                        // Short-heavy positions - use red colors consistent with codebase
                        // More intense red = more vulnerable to liquidation
                        const r = Math.min(255, 220 + Math.round(35 * scaledVulnerability));
                        const g = Math.max(0, 50 - Math.round(20 * scaledVulnerability));
                        const b = Math.max(0, 50 - Math.round(20 * scaledVulnerability));
                        return { color: `rgba(${r}, ${g}, ${b}, ${alpha})` };
                    }
                };

                // Function to get dynamic color based on level data
                const getDynamicColor = (_, __, ___, level) => {
                    // Calculate position concentration and liquidation vulnerability
                    const concentration = calculatePositionConcentration(level);

                    // Use the liquidation vulnerability coloration
                    return getLiquidationVulnerabilityColor(concentration);
                };

                levels.forEach(level => {
                    const y = priceToY(level.price, height);
                    if (y < 0 || y > height || level.totalOI === 0) return;
                    const oiRatio = level.totalOI / maxOI;
                    const barLength = profileWidth * barWidth * oiRatio;
                    const nextPrice = level.price + profile.data.priceStep;
                    const nextY = priceToY(nextPrice, height);
                    const barHeight = Math.max(1, Math.abs(nextY - y));
                    const barStartX = startX;

                    // Determine bar color based on multiple factors
                    let barColor;

                    // First check if we have order flow data
                    if (level.buyFlow > 0 || level.sellFlow > 0) {
                        // We have order flow data - this is the most reliable signal
                        const totalFlow = level.buyFlow + level.sellFlow;
                        const buyRatio = level.buyFlow / totalFlow;

                        // Calculate confidence factor based on amount of order flow data
                        const flowConfidence = level.flowConfidence || 0;

                        // Determine color intensity based on the strength of the signal and confidence
                        const baseIntensity = Math.min(1, totalFlow / (level.totalOI * 0.05)); // Cap at 5% of total OI
                        const confidenceAdjustedIntensity = baseIntensity * (0.7 + (0.3 * flowConfidence));
                        const adjustedIntensity = Math.max(0.3, Math.pow(confidenceAdjustedIntensity, 0.7));

                        // Get dynamic color based on buy ratio and intensity
                        const { color } = getDynamicColor(buyRatio, adjustedIntensity, 'orderFlow', level);
                        barColor = color;
                    }
                    // Next check if we have buy/sell pressure data
                    else if (level.buyPressure > 0 || level.sellPressure > 0) {
                        // Calculate the ratio of buy vs sell pressure
                        const totalPressure = level.buyPressure + level.sellPressure;
                        const buyRatio = level.buyPressure / totalPressure;

                        // Determine color intensity based on the strength of the signal
                        const intensity = Math.min(1, totalPressure / (level.totalOI * 0.1)); // Cap at 10% of total OI
                        const adjustedIntensity = Math.max(0.3, Math.pow(intensity, 0.7));

                        // Get dynamic color based on buy ratio and intensity
                        const { color } = getDynamicColor(buyRatio, adjustedIntensity, 'pressure', level);
                        barColor = color;
                    } else {
                        // If no pressure data, fall back to funding rate
                        if (chartState.fundingProfile && window.fundingProfileManager) {
                            // Use the dedicated function from fundingProfileManager
                            barColor = window.fundingProfileManager.getFundingColorForPrice(
                                chartState.config.ticker.symbol,
                                level.price,
                                profile.data.priceStep
                            );
                        }

                        // If still no color, use a default based on recent price action
                        if (!barColor) {
                            // Find the most recent open interest data point for this price level
                            const recentOIPoints = chartState.data.openInterestData
                                .filter(point => Math.abs(point.price - level.price) < profile.data.priceStep)
                                .sort((a, b) => b.time - a.time);

                            if (recentOIPoints.length > 0) {
                                const recentPoint = recentOIPoints[0];
                                // Use price change as a secondary indicator for buy/sell pressure
                                let buyRatio;
                                if (recentPoint.priceChange > 0.0005) {
                                    // Positive price change suggests buy pressure
                                    buyRatio = 0.65; // Medium buy
                                } else if (recentPoint.priceChange < -0.0005) {
                                    // Negative price change suggests sell pressure
                                    buyRatio = 0.35; // Medium sell
                                } else {
                                    // Neutral price change
                                    buyRatio = 0.5; // Neutral
                                }

                                const { color } = getDynamicColor(buyRatio, 0.5, 'price', level);
                                barColor = color;
                            } else {
                                // Default to dark grey when no data is available
                                barColor = 'rgba(64, 64, 64, 0.7)';
                            }
                        }
                    }

                    // Draw a single bar for total OI with the determined color
                    ctx.fillStyle = barColor;
                    ctx.fillRect(barStartX, y - barHeight / 2, barLength, barHeight);
                });

                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.font = `${Math.round(10 * pixelRatio)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText('OI', startX + profileWidth / 2, 20);

                ctx.strokeStyle = 'rgba(100, 100, 100, 0.7)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(startX, 30);
                ctx.lineTo(startX + profileWidth, 30);
                ctx.stroke();
                ctx.restore();
            } catch (error) {
                console.error('Error drawing open interest profile:', error);
                if (openInterestProfileCanvas && openInterestProfileCanvas.getContext) {
                    const ctx = openInterestProfileCanvas.getContext('2d');
                    if (ctx) ctx.clearRect(0, 0, openInterestProfileCanvas.width, openInterestProfileCanvas.height);
                }
            }
        };

        profile.drawOpenInterestProfile = drawOpenInterestProfile;
        const debouncedDraw = debounce(drawOpenInterestProfile, 50);

        try {
            const resizeObserver = new ResizeObserver(() => {
                profile.priceRangeCache.timestamp = 0;
                debouncedDraw();
            });
            resizeObserver.observe(chartCanvas);
            resizeObserver.observe(chartContainer);
            profile.resizeObserver = resizeObserver;
        } catch {
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
            } catch {}
        }

        if (mergedConfig.liveUpdate) {
            const originalUpdate = chartState.throttledFunctions.throttledPriceUpdate;
            chartState.throttledFunctions.throttledPriceUpdate = function (bar) {
                originalUpdate.call(this, bar);
                const profile = profiles.get(chartState.config.ticker.symbol);
                if (!profile) return;
                const barInterval = chartState.config.barInterval || 300;
                const currentCandleTime = Math.floor(bar.time / barInterval) * barInterval;
                if (currentCandleTime > profile.lastCandleTime) {
                    profile.lastCandleTime = currentCandleTime;
                    const currentPriceRange = profile.config.priceRange;
                    try {
                        const priceDataCopy = chartState.data.priceData.slice(-profile.config.maxBars).map(bar => ({ ...bar }));
                        const openInterestDataCopy = (chartState.data.openInterestData || []).map(point => ({ ...point }));
                        const newProfileData = calculateOpenInterestProfile(priceDataCopy, openInterestDataCopy, { ...profile.config });
                        if (newProfileData && newProfileData.levels) {
                            profile.data = newProfileData;
                            profile.config.priceRange = currentPriceRange;
                            profile.drawOpenInterestProfile?.();
                        }
                    } catch (error) {
                        console.error('Error recalculating profile:', error);
                        profile.config.priceRange = currentPriceRange;
                    }
                } else if (mergedConfig.liveUpdate) {
                    if (profile.debouncedUpdate) profile.debouncedUpdate();
                    else updateProfile(chartState.config.ticker.symbol);
                }
            };
        }

        setTimeout(drawOpenInterestProfile, 100);
        setTimeout(drawOpenInterestProfile, 500);
        setTimeout(drawOpenInterestProfile, 1000);
        setTimeout(drawOpenInterestProfile, 2000);
        const redrawInterval = setInterval(() => {
            if (!profile.dataLoaded) requestAnimationFrame(drawOpenInterestProfile);
            else drawOpenInterestProfile();
        }, 100);
        profile.redrawInterval = redrawInterval;

        return {
            update: () => updateProfile(chartState.config.ticker.symbol),
            toggle: () => toggleVisibility(chartState.config.ticker.symbol),
            config: profile.config,
            cleanup: () => {
                if (profile.redrawInterval) clearInterval(profile.redrawInterval);
                if (profile.resizeObserver) profile.resizeObserver.disconnect();
                if (profile.windowResizeHandler) window.removeEventListener('resize', profile.windowResizeHandler);
                if (profile.chartInteractionHandler && profile.chartCanvas) {
                    profile.chartCanvas.removeEventListener('mousemove', profile.chartInteractionHandler);
                    profile.chartCanvas.removeEventListener('click', profile.chartInteractionHandler);
                }
                if (profile.timeScaleUnsubscribe) profile.timeScaleUnsubscribe();
                if (profile.openInterestProfileCanvas) profile.openInterestProfileCanvas.remove();
                profiles.delete(chartState.config.ticker.symbol);
            },
        };
    };

    return { initialize, updateProfile, toggleVisibility };
})();

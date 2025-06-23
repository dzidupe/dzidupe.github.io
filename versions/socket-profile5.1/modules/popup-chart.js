(function() {
    // === Utility Functions ===
    function logError(message, error) {
        console.error(`${message}: ${error.message}`);
        // Optional: Add integration with an error reporting service like Sentry
    }

    // Use global utility for formatting large numbers
    function formatLargeNumber(value) {
        return window.utils && window.utils.formatLargeNumber
            ? window.utils.formatLargeNumber(value)
            : value;
    }

    function throttle(fn, limit) {
        let timeout;
        const throttled = function(...args) {
            if (!timeout) {
                timeout = setTimeout(() => {
                    fn(...args);
                    timeout = null;
                }, limit);
            }
        };
        // Register cleanup for this timeout
        if (window.CleanupManager && window.CleanupManager.registerCleanup) {
            window.CleanupManager.registerCleanup(() => { if (timeout) clearTimeout(timeout); });
        }
        return throttled;
    }

    async function tryFetchWithProxies(url, signal) {
        const proxies = [
            url, // Direct fetch
            `https://corsproxy.io/?${encodeURIComponent(url)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
        ];

        for (const proxyUrl of proxies) {
            try {
                const fetchOptions = signal ? { signal } : {};
                const response = await fetch(proxyUrl, fetchOptions);
                if (response.ok) {
                    return await response.json();
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                // Fetch attempt failed, trying next proxy
            }
        }
        throw new Error("All fetch attempts failed");
    }

    // Register cleanup for any global references if set in this module
    if (window.CleanupManager && window.CleanupManager.registerCleanup) {
        window.CleanupManager.registerCleanup(() => {
            // Example: if you attach anything to window, clean it here
            // window.popupChartModule = null;
        });
    }

    // === Drawing Primitives ===
    class LinePrimitive {
        constructor(options = {}) {
            this.options = {
                color: options.color || 'rgba(255, 255, 255, 0.8)',
                lineWidth: options.lineWidth || 2,
                lineStyle: options.lineStyle || 0, // 0 = solid, 1 = dotted, 2 = dashed
            };
            this.points = options.points || { x1: 0, y1: 0, x2: 0, y2: 0 };
            this.id = options.id || `line_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this._paneViews = null;
        }

        setPoints(points) {
            this.points = points;
            this._paneViews = null;
        }

        updateAllViews() {
            this._paneViews = null;
        }

        get paneViews() {
            if (!this._paneViews) {
                this._paneViews = [new LinePaneView(this)];
            }
            return this._paneViews;
        }
    }

    class LinePaneView {
        constructor(primitive) {
            this.primitive = primitive;
        }

        renderer() {
            return {
                draw: (target) => {
                    const ctx = target.context;
                    const points = this.primitive.points;

                    if (!points || !points.x1 || !points.y1 || !points.x2 || !points.y2) {
                        return;
                    }

                    ctx.save();

                    ctx.strokeStyle = this.primitive.options.color;
                    ctx.lineWidth = this.primitive.options.lineWidth;

                    // Set line style
                    if (this.primitive.options.lineStyle === 1) {
                        ctx.setLineDash([2, 2]); // Dotted
                    } else if (this.primitive.options.lineStyle === 2) {
                        ctx.setLineDash([6, 3]); // Dashed
                    }

                    ctx.beginPath();
                    ctx.moveTo(points.x1, points.y1);
                    ctx.lineTo(points.x2, points.y2);
                    ctx.stroke();

                    ctx.restore();
                }
            };
        }

        get zOrder() {
            return 'top';
        }
    }

    class RectanglePrimitive {
        constructor(options = {}) {
            this.options = {
                color: options.color || 'rgba(255, 255, 255, 0.8)',
                lineWidth: options.lineWidth || 2,
                fillColor: options.fillColor || 'rgba(255, 255, 255, 0.1)',
                lineStyle: options.lineStyle || 0, // 0 = solid, 1 = dotted, 2 = dashed
            };
            this.points = options.points || { x1: 0, y1: 0, x2: 0, y2: 0 };
            this.id = options.id || `rect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this._paneViews = null;
        }

        setPoints(points) {
            this.points = points;
            this._paneViews = null;
        }

        updateAllViews() {
            this._paneViews = null;
        }

        get paneViews() {
            if (!this._paneViews) {
                this._paneViews = [new RectanglePaneView(this)];
            }
            return this._paneViews;
        }
    }

    class RectanglePaneView {
        constructor(primitive) {
            this.primitive = primitive;
        }

        renderer() {
            return {
                draw: (target) => {
                    const ctx = target.context;
                    const points = this.primitive.points;

                    if (!points || !points.x1 || !points.y1 || !points.x2 || !points.y2) {
                        return;
                    }

                    ctx.save();

                    // Calculate rectangle coordinates
                    const x = Math.min(points.x1, points.x2);
                    const y = Math.min(points.y1, points.y2);
                    const width = Math.abs(points.x2 - points.x1);
                    const height = Math.abs(points.y2 - points.y1);

                    // Fill rectangle
                    ctx.fillStyle = this.primitive.options.fillColor;
                    ctx.fillRect(x, y, width, height);

                    // Draw border
                    ctx.strokeStyle = this.primitive.options.color;
                    ctx.lineWidth = this.primitive.options.lineWidth;

                    // Set line style
                    if (this.primitive.options.lineStyle === 1) {
                        ctx.setLineDash([2, 2]); // Dotted
                    } else if (this.primitive.options.lineStyle === 2) {
                        ctx.setLineDash([6, 3]); // Dashed
                    }

                    ctx.strokeRect(x, y, width, height);

                    ctx.restore();
                }
            };
        }

        get zOrder() {
            return 'top';
        }
    }

    // === Popup Chart Object ===
    window.popupChart = {
        // State variables
        chart: null,
        series: null,
        container: null,
        chartData: [],
        isInitializing: false,
        currentSymbol: null,
        currentInterval: '60', // Default to 1 hour
        currentBar: null,

        // Event handlers
        handleResize: null,
        wsHandler: null,

        // === Methods ===

        /**
         * Initializes the chart with the specified symbol and interval.
         * @param {string} symbol - The market symbol (e.g., 'BTCUSD').
         * @param {string} interval - The timeframe interval (e.g., '60' for 1 hour).
         */
        initialize: function(symbol, interval) {
            if (this.isInitializing) {
                // Popup chart initialization already in progress, skipping
                return;
            }
            // Initializing popup chart
            this.isInitializing = true;

            try {
                this.cleanup();
                this.container = document.getElementById('popup-chart-container');
                if (!this.container) {
                    throw new Error("Popup chart container not found");
                }
                this.container.style.display = 'block';
                const width = this.container.clientWidth || 400;
                const height = this.container.clientHeight || 300;

                if (typeof LightweightCharts === 'undefined') {
                    throw new Error("LightweightCharts library not loaded");
                }

                this.chart = LightweightCharts.createChart(this.container, {
                    width: width,
                    height: height,
                    layout: {
                        background: { color: "#0f141a", type: 'solid' },
                        textColor: "#D3D3D3",
                        fontSize: 12,
                        attributionLogo: false
                    },
                    grid: {
                        vertLines: { visible: false },
                        horzLines: { visible: false }
                    },
                    timeScale: {
                        timeVisible: true,
                        secondsVisible: false,
                        borderColor: "#2A2A2A"
                    },
                    rightPriceScale: {
                        borderColor: "#2A2A2A",
                        scaleMargins: { top: 0.1, bottom: 0.1 }
                    }
                });

                // Set up ResizeObserver for the container
                if (typeof ResizeObserver !== 'undefined') {
                    const resizeObserver = new ResizeObserver(entries => {
                        for (const entry of entries) {
                            const { width, height } = entry.contentRect;
                            if (width > 50 && height > 50) {
                                // Resizing chart
                                this.chart.resize(width, height);
                            }
                        }
                    });
                    resizeObserver.observe(this.container);
                    this.resizeObserver = resizeObserver;
                    console.log("ResizeObserver added for container");
                }

                // Creating candlestick series
                this.series = this.chart.addSeries(LightweightCharts.CandlestickSeries, {
                    upColor: "#AAAAAA",
                    downColor: "#AAAAAA",
                    borderColor: "#AAAAAA",
                    wickUpColor: "#AAAAAA",
                    wickDownColor: "#AAAAAA",
                    lastValueVisible: true,
                    priceLineVisible: true,
                    priceLineSource: LightweightCharts.PriceLineSource.LastBar,
                    priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
                });

                // Hide crosshair when mouse leaves chart area
                this.chart.subscribeCrosshairMove(param => {
                    if (!param.point) {
                        // Hide crosshair: set mode to hidden
                        this.chart.applyOptions({
                            crosshair: { mode: LightweightCharts.CrosshairMode.Hidden }
                        });
                    } else {
                        // Restore crosshair: set mode to normal
                        this.chart.applyOptions({
                            crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
                        });
                    }
                });

                this.currentSymbol = symbol;
                this.currentInterval = interval || '60';
                this.loadChartData(symbol, this.currentInterval);
                
                // Subscribe to websocket updates
                this.subscribeToWebSocket();

                window.addEventListener('resize', this.handleResize);
                if (typeof ResizeObserver !== 'undefined') {
                    const resizeObserver = new ResizeObserver(() => this.handleResize());
                    resizeObserver.observe(this.container);
                    this.resizeObserver = resizeObserver;
                    console.log("ResizeObserver added for container");
                }
                // Popup chart initialized successfully
            } catch (error) {
                logError("Error initializing popup chart", error);
            } finally {
                this.isInitializing = false;
            }
        },

        /**
         * Handles chart resizing with throttling.
         */
        handleResize: throttle(function() {
            if (!this.chart || !this.container) return;
            try {
                const width = this.container.clientWidth || 400;
                const height = this.container.clientHeight || 300;
                if (width > 50 && height > 50) {
                    // Resizing chart
                    this.chart.resize(width, height);
                }
            } catch (error) {
                logError("Error resizing chart", error);
            }
        }, 100),

        /**
         * Updates the chart timeframe and reloads data.
         * @param {string} interval - The new interval to switch to.
         */
        updateTimeframe: function(interval) {
            if (!this.currentSymbol) {
                logError("No current symbol found for popup chart", new Error("Missing symbol"));
                return;
            }
            if (this.currentInterval === interval) {
                // Already using the same interval
                return;
            }

            // Updating popup chart timeframe
            
            // Unsubscribe from old interval's websocket
            this.unsubscribeFromWebSocket();
            
            this.currentInterval = interval;
            this.currentBar = null;
            this.loadChartData(this.currentSymbol, interval);
            
            // Subscribe to new interval's websocket
            this.subscribeToWebSocket();
        },

        /**
         * Cleans up the chart and removes event listeners.
         */
        cleanup: function() {
            // Cleaning up popup chart
            try {
                // Unsubscribe from websocket updates
                this.unsubscribeFromWebSocket();
                
                window.removeEventListener('resize', this.handleResize);
                if (this.resizeObserver) {
                    this.resizeObserver.disconnect();
                    this.resizeObserver = null;
                }

                // Clear chart data and state
                this.chartData = [];
                this.currentBar = null;
                this.wsHandler = null;

                // Properly clean up series
                if (this.series) {
                    this.series = null;
                }

                if (this.chart) {
                    try {
                        this.chart.remove();
                    } catch (e) {
                        logError("Error removing chart", e);
                    }
                    this.chart = null;
                }

                // Clear container
                if (this.container) {
                    this.container.innerHTML = '';
                    this.container.style.display = 'none';
                }
                this.container = null;

                // Cleanup completed successfully
            } catch (error) {
                logError("Error during cleanup", error);
            }
        },

        /**
         * Loads and displays chart data for the specified symbol and interval.
         * Uses cached data if available, otherwise fetches from APIs with fallback.
         * @param {string} symbol - The market symbol (e.g., 'BTCUSD').
         * @param {string} interval - The timeframe interval (e.g., '60' for 1 hour).
         * @param {boolean} [isLineSeries=false] - Whether to display as a line series instead of candlesticks.
         */
        loadChartData: function(symbol, interval, isLineSeries = false) {
            if (!this.series || !this.chart) {
                logError("Cannot load data - chart or series not initialized", new Error("Missing chart or series"));
                return;
            }
            // Loading chart data

            const existingIndicator = document.getElementById('chart-loading-indicator');
            if (existingIndicator) existingIndicator.remove();
            this.showLoadingIndicator(this.container);

            const formattedSymbol = symbol.replace('USD', '').toLowerCase() + 'usd';
            const apiInterval = this.mapIntervalToApi(interval);
            const cacheKey = `${formattedSymbol}_${apiInterval}`;
            const cachedData = this.getCachedData(cacheKey);

            if (cachedData && cachedData.length > 0) {
                // Using cached data
                document.getElementById('chart-loading-indicator')?.remove();
                this.processChartData(cachedData, isLineSeries);
                setTimeout(() => this.fetchMarketData(formattedSymbol, apiInterval)
                    .then(freshData => {
                        if (freshData && freshData.length > 0 && this.currentSymbol === symbol && this.currentInterval === interval) {
                            this.cacheData(cacheKey, freshData);
                            this.processChartData(freshData, isLineSeries);
                        }
                    })
                    .catch(error => logError("Background data fetch error", error)), 100);
                return;
            }

            const controller = new AbortController();
            const signal = controller.signal;
            const abortTimeout = setTimeout(() => controller.abort(), 7000);

            Promise.race([
                this.fetchMarketData(formattedSymbol, apiInterval, signal),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Data fetch timeout')), 8000))
            ])
            .then(data => {
                clearTimeout(abortTimeout);
                document.getElementById('chart-loading-indicator')?.remove();
                this.processFetchedData(data, cacheKey, isLineSeries);
                setTimeout(() => this.fetchAdditionalData(formattedSymbol, apiInterval, data), 200);
            })
            .catch(error => {
                clearTimeout(abortTimeout);
                logError("Error fetching market data", error);
                document.getElementById('chart-loading-indicator')?.remove();
                // Handle fallback and error display
                if (this.container) {
                    const errorMessage = document.createElement('div');
                    errorMessage.id = 'chart-error-message';
                    errorMessage.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 4px; z-index: 10;';
                    errorMessage.textContent = 'Failed to load chart data. Retrying...';
                    this.container.appendChild(errorMessage);

                    setTimeout(() => {
                        errorMessage.remove();
                        this.fetchBybitData(symbol.replace('USD', '').toUpperCase(), interval)
                            .then(data => {
                                if (data && data.length > 0) {
                                    // Received data from fallback API
                                    this.cacheData(cacheKey, data);
                                    this.processChartData(data, isLineSeries);
                                } else {
                                    throw new Error("No data from fallback source");
                                }
                            })
                            .catch(fallbackError => {
                                logError("Fallback data source failed", fallbackError);
                                const finalError = document.createElement('div');
                                finalError.id = 'chart-final-error';
                                finalError.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 4px; z-index: 10;';
                                finalError.textContent = 'Failed to load chart data';
                                this.container.appendChild(finalError);
                                setTimeout(() => finalError.remove(), 3000);
                            });
                    }, 500);
                }
            });
        },

        /**
         * Shows a loading indicator in the chart container.
         * @param {HTMLElement} container - The chart container element.
         */
        showLoadingIndicator: function(container) {
            if (!container || document.getElementById('popup-chart-loading') || document.getElementById('popup-chart-priority-loading')) return;
            const loadingIndicator = document.createElement('div');
            loadingIndicator.id = 'chart-loading-indicator';
            loadingIndicator.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 4px; z-index: 10;';
            loadingIndicator.textContent = 'Loading chart data...';
            container.appendChild(loadingIndicator);
        },

        /**
         * Processes and displays the fetched chart data.
         * @param {Array} data - The chart data to display.
         * @param {string} cacheKey - The key for caching the data.
         * @param {boolean} isLineSeries - Whether to display as a line series.
         */
        processFetchedData: function(data, cacheKey, isLineSeries) {
            if (!data || data.length === 0) {
                throw new Error("No data received from API");
            }
            // Received data from API
            this.cacheData(cacheKey, data);
            this.processChartData(data, isLineSeries);
        },

        /**
         * Fetches market data from APIs with fallback.
         * @param {string} symbol - The formatted symbol for API requests.
         * @param {number} interval - The API interval.
         * @param {AbortSignal} signal - The abort signal for fetch requests.
         * @returns {Promise<Array>} The fetched data.
         */
        fetchMarketData: async function(symbol, interval, signal) {
            try {
                // Attempt Bitstamp first for its reliability
                const bitstampData = await this.fetchBitstampData(symbol, interval, signal);
                if (bitstampData && bitstampData.length > 0) return bitstampData;

                // Fallback to Bybit if Bitstamp fails
                const bybitData = await this.fetchBybitData(symbol.replace('usd', '').toUpperCase(), interval, signal);
                if (bybitData && bybitData.length > 0) return bybitData;

                throw new Error("Failed to fetch data from both APIs");
            } catch (error) {
                logError("Error fetching market data", error);
                throw error;
            }
        },

        /**
         * Fetches data from Bitstamp API.
         * @param {string} symbol - The symbol for the API request.
         * @param {number} interval - The interval for the API request.
         * @param {AbortSignal} signal - The abort signal for fetch requests.
         * @returns {Promise<Array>} The processed data.
         */
        fetchBitstampData: async function(symbol, interval, signal) {
            try {
                const url = `https://www.bitstamp.net/api/v2/ohlc/${symbol}/?step=${interval}&limit=1000`;
                const data = await tryFetchWithProxies(url, signal);
                if (!data?.data?.ohlc) {
                    console.error("Invalid or missing Bitstamp data");
                    return [];
                }
                return data.data.ohlc.map(bar => ({
                    time: parseInt(bar.timestamp),
                    open: parseFloat(bar.open),
                    high: parseFloat(bar.high),
                    low: parseFloat(bar.low),
                    close: parseFloat(bar.close),
                    volume: parseFloat(bar.volume)
                }));
            } catch (error) {
                logError("Error fetching Bitstamp data", error);
                return [];
            }
        },

        /**
         * Fetches data from Bybit API.
         * @param {string} symbol - The symbol for the API request.
         * @param {number} interval - The interval for the API request.
         * @param {AbortSignal} signal - The abort signal for fetch requests.
         * @returns {Promise<Array>} The processed data.
         */
        fetchBybitData: async function(symbol, interval, signal) {
            try {
                const intervalMap = {
                    60: '1',    // 1 minute
                    300: '5',   // 5 minutes
                    900: '15',  // 15 minutes
                    1800: '30', // 30 minutes
                    3600: '60', // 1 hour
                    14400: '240', // 4 hours
                    86400: 'D',  // 1 day
                    'D': 'D',    // 1 day (string)
                    '1D': 'D'    // 1 day (alternate)
                };
                const bybitInterval = intervalMap[interval] || '60';
                const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=${bybitInterval}&limit=1000`;
                const data = await tryFetchWithProxies(url, signal);
                if (!data?.result?.list) {
                    console.error("Invalid or missing Bybit data");
                    return [];
                }
                const bars = data.result.list.map(bar => ({
                    time: parseInt(bar[0]) / 1000,
                    open: parseFloat(bar[1]),
                    high: parseFloat(bar[2]),
                    low: parseFloat(bar[3]),
                    close: parseFloat(bar[4]),
                    volume: parseFloat(bar[5])
                })).sort((a, b) => a.time - b.time);

                if (bybitInterval === 'D') {
                    // Bybit API returned data
                }
                return bars;
            } catch (error) {
                logError("Error fetching Bybit data", error);
                return [];
            }
        },

        /**
         * Maps chart interval to API-compatible interval.
         * @param {string} interval - The chart interval (e.g., '60').
         * @returns {number} The API interval in seconds.
         */
        mapIntervalToApi: function(interval) {
            const intervals = {
                '1': 60,      // 1 minute
                '5': 300,     // 5 minutes
                '15': 900,    // 15 minutes
                '30': 1800,   // 30 minutes
                '60': 3600,   // 1 hour
                '240': 14400, // 4 hours
                'D': 86400,   // 1 day
                '1D': 86400   // 1 day (alternate)
            };
            return intervals[interval] || 3600; // Default to 1 hour
        },

        /**
         * Caches chart data for future use.
         * @param {string} key - The cache key.
         * @param {Array} data - The data to cache.
         */
        cacheData: function(key, data) {
            this.chartData[key] = data;
        },

        /**
         * Retrieves cached chart data.
         * @param {string} key - The cache key.
         * @returns {Array|null} The cached data or null if not found.
         */
        getCachedData: function(key) {
            return this.chartData[key] || null;
        },

        /**
         * Processes chart data and updates the series.
         * @param {Array} data - The data to process.
         * @param {boolean} isLineSeries - Whether to display as a line series.
         */
        processChartData: function(data, isLineSeries) {
            if (!this.series) {
                console.error("No series found when processing chart data.");
                return;
            }
            if (isLineSeries) {
                const lineData = data.map(d => ({ time: d.time, value: d.close }));
                this.series.setData(lineData);
            } else {
                // Defensive: log and check data for 1D interval
                if (this.currentInterval === 'D' || this.currentInterval === '1D') {
                    // Processing chart data
                    if (!Array.isArray(data) || data.length === 0) {
                        console.error('[1D] No data provided to setData for 1D interval.');
                    } else if (!('time' in data[0] && 'open' in data[0] && 'high' in data[0] && 'low' in data[0] && 'close' in data[0])) {
                        console.error('[1D] Data format invalid for 1D interval:', data[0]);
                    }
                }
                try {
                    this.series.setData(data);
                } catch (e) {
                    console.error("Error calling setData on series:", e, data);
                }
                
                // Initialize current bar from the last bar in the data
                if (data.length > 0) {
                    const lastBar = data[data.length - 1];
                    const now = Math.floor(Date.now() / 1000);
                    const interval = this.mapIntervalToApi(this.currentInterval);
                    const currentBarTime = Math.floor(now / interval) * interval;
                    
                    if (lastBar.time === currentBarTime) {
                        // Use the last bar as our current bar if it's from the current interval
                        this.currentBar = { ...lastBar };
                    } else {
                        // Initialize a new bar using the last known price
                        this.currentBar = {
                            time: currentBarTime,
                            open: lastBar.close,
                            high: lastBar.close,
                            low: lastBar.close,
                            close: lastBar.close,
                            volume: 0
                        };
                    }
                }
            }
            try {
                this.chart.timeScale().fitContent();
            } catch (e) {
                console.error("Error fitting chart content:", e);
            }
        },

        /**
         * Fetches additional data for pagination or updates (stub method).
         * @param {string} symbol - The formatted symbol.
         * @param {number} interval - The API interval.
         * @param {Array} existingData - The current data.
         */
        fetchAdditionalData: function(symbol, interval, existingData) {
            // Stub for future pagination or real-time updates
            // Fetching additional data
        },

        /**
         * Subscribes to websocket updates for the current symbol.
         */
        subscribeToWebSocket: function() {
            if (!this.currentSymbol || !window.orderBooksBitstampWsManager) return;
            const symbol = this.currentSymbol.replace('USD', '').toLowerCase();
            const channel = `live_trades_${symbol}usd`;
            if (!this.wsHandler) {
                this.wsHandler = (message) => {
                    if (message.event === "trade" && message.data) {
                        const price = parseFloat(message.data.price);
                        const volume = parseFloat(message.data.amount);
                        const type = message.data.type;
                        if (Number.isFinite(price) && Number.isFinite(volume)) {
                            this.updateRealTimeBar(price, volume, type === 0);
                        }
                    }
                };
            }
            window.orderBooksBitstampWsManager.subscribe(channel, this.wsHandler);
        },

        /**
         * Unsubscribes from websocket updates.
         */
        unsubscribeFromWebSocket: function() {
            if (!this.currentSymbol || !window.orderBooksBitstampWsManager || !this.wsHandler) return;
            const symbol = this.currentSymbol.replace('USD', '').toLowerCase();
            const channel = `live_trades_${symbol}usd`;
            window.orderBooksBitstampWsManager.unsubscribe(channel);
        },

        /**
         * Updates the current bar with real-time price data.
         */
        updateRealTimeBar: function(price, volume, isBuy) {
            if (!this.series || !price) return;
            const now = Math.floor(Date.now() / 1000);
            const interval = this.mapIntervalToApi(this.currentInterval);
            const barTime = Math.floor(now / interval) * interval;

            if (!this.currentBar || this.currentBar.time < barTime) {
                // Create a new bar if we don't have one or if it's time for a new one
                if (this.currentBar) {
                    // Push the completed bar to the series
                    this.series.update(this.currentBar);
                }
                this.currentBar = {
                    time: barTime,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: volume || 0
                };
            } else {
                // Update the current bar
                this.currentBar.high = Math.max(this.currentBar.high, price);
                this.currentBar.low = Math.min(this.currentBar.low, price);
                this.currentBar.close = price;
                this.currentBar.volume += volume || 0;
            }
            
            // Update the series with the latest data
            this.series.update(this.currentBar);
        },
    };
})();

class MarkerManager {
    constructor(chart, priceSeries) {
        this.chart = chart;
        this.priceSeries = priceSeries;
        this.markers = new Map(); // Key: marker type, Value: marker data
    }

    addMarker(type, time, price, options = {}) {
        const marker = {
            time,
            position: 'aboveBar',
            color: options.color || (options.side === 'buy' ? '#00FF00' : '#FF0000'),
            shape: options.shape || (options.size > 100000 ? 'arrowUp' : 'circle'),
            text: options.text || `$${options.size?.toLocaleString() || ''}`,
        };
        this.markers.set(type, [...(this.markers.get(type) || []), marker]);
        this._updateMarkers();
    }

    clearMarkers(type) {
        if (type) this.markers.delete(type);
        else this.markers.clear();
        this._updateMarkers();
    }

    _updateMarkers() {
        const allMarkers = Array.from(this.markers.values()).flat();
        this.priceSeries.setMarkers(allMarkers);
    }
}
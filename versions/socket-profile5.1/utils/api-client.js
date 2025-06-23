/**
 * Unified API Client for fetching cryptocurrency market data
 * Provides a consistent interface with automatic fallbacks between different exchanges
 */
class CryptoApiClient {
    /**
     * Fetches market data with automatic fallback between exchanges
     * @param {string} symbol - The cryptocurrency symbol (e.g., 'btcusd')
     * @param {number} interval - The timeframe interval in seconds
     * @param {Object} options - Additional options
     * @param {AbortSignal} [options.signal] - AbortSignal for fetch requests
     * @returns {Promise<Array>} - Processed OHLCV data
     */
    static async fetchData(symbol, interval, options = {}) {
        try {
            // Try Bitstamp first for its reliability
            const bitstampData = await this.fetchFromBitstamp(symbol, interval, options.signal);
            if (bitstampData && bitstampData.length > 0) return bitstampData;

            // Fallback to Bybit if Bitstamp fails
            const bybitSymbol = symbol.replace('usd', '').toUpperCase();
            const bybitData = await this.fetchFromBybit(bybitSymbol, interval, options.signal);
            if (bybitData && bybitData.length > 0) return bybitData;

            throw new Error("Failed to fetch data from all available exchanges");
        } catch (error) {
            console.error("Error in unified data fetch:", error.message);
            throw error;
        }
    }

    /**
     * Fetches data from Bitstamp API
     * @param {string} symbol - The symbol for the API request
     * @param {number} interval - The interval for the API request in seconds
     * @param {AbortSignal} signal - The abort signal for fetch requests
     * @returns {Promise<Array>} The processed OHLCV data
     */
    static async fetchFromBitstamp(symbol, interval, signal) {
        try {
            const url = `https://www.bitstamp.net/api/v2/ohlc/${symbol}/?step=${interval}&limit=1000`;
            const data = await this._fetchWithProxies(url, signal);
            
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
            console.error("Error fetching Bitstamp data:", error.message);
            return [];
        }
    }

    /**
     * Fetches data from Bybit API
     * @param {string} symbol - The symbol for the API request (without USD suffix)
     * @param {number} interval - The interval for the API request in seconds
     * @param {AbortSignal} signal - The abort signal for fetch requests
     * @returns {Promise<Array>} The processed OHLCV data
     */
    static async fetchFromBybit(symbol, interval, signal) {
        try {
            const intervalMap = {
                60: '1',      // 1 minute
                300: '5',     // 5 minutes
                900: '15',    // 15 minutes
                1800: '30',   // 30 minutes
                3600: '60',   // 1 hour
                14400: '240', // 4 hours
                86400: 'D',   // 1 day
                'D': 'D',     // 1 day (string)
                '1D': 'D'     // 1 day (alternate)
            };
            
            const bybitInterval = intervalMap[interval] || '60';
            const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=${bybitInterval}&limit=1000`;
            
            const data = await this._fetchWithProxies(url, signal);
            
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

            return bars;
        } catch (error) {
            console.error("Error fetching Bybit data:", error.message);
            return [];
        }
    }

    /**
     * Attempts to fetch data using multiple CORS proxies if direct fetch fails
     * @param {string} url - The URL to fetch
     * @param {AbortSignal} signal - The abort signal for fetch requests
     * @returns {Promise<Object>} The parsed JSON response
     */
    static async _fetchWithProxies(url, signal) {
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
}

// Export for use in other modules
window.CryptoApiClient = CryptoApiClient;

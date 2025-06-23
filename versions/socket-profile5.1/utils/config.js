/**
 * Global configuration system for the crypto dashboard
 * Centralizes all configuration values to reduce duplication and improve maintainability
 */
window.CONFIG = {
    // WebSocket configurations
    websockets: {
        bitstamp: {
            url: 'wss://ws.bitstamp.net',
            pingInterval: 30000,
            reconnectDelay: 2000,
            maxReconnectAttempts: 10
        },
        bybit: {
            url: 'wss://stream.bybit.com/v5/public/linear',
            pingInterval: 20000,
            reconnectDelay: 2000,
            maxReconnectAttempts: 10
        }
    },
    
    // Time intervals mapping
    intervals: {
        '1m': { seconds: 60, apiValue: '60', label: '1 Min' },
        '5m': { seconds: 300, apiValue: '300', label: '5 Min' },
        '15m': { seconds: 900, apiValue: '900', label: '15 Min' },
        '30m': { seconds: 1800, apiValue: '1800', label: '30 Min' },
        '1h': { seconds: 3600, apiValue: '60', label: '1 Hour' },
        '4h': { seconds: 14400, apiValue: '240', label: '4 Hour' },
        '1d': { seconds: 86400, apiValue: 'D', label: '1 Day' }
    },
    
    // Supported cryptocurrencies
    cryptocurrencies: [
        { symbol: 'BTC', name: 'Bitcoin', color: '#F7931A' },
        { symbol: 'ETH', name: 'Ethereum', color: '#627EEA' },
        { symbol: 'LTC', name: 'Litecoin', color: '#BFBBBB' },
        { symbol: 'SOL', name: 'Solana', color: '#00FFA3' }
    ],
    
    // Chart configurations
    chart: {
        defaultColors: {
            background: '#0f141a',
            text: '#D3D3D3',
            grid: '#2A2A2A',
            upColor: '#26a69a',
            downColor: '#ef5350',
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350'
        },
        candlestick: {
            upColor: '#AAAAAA',
            downColor: '#AAAAAA',
            borderColor: '#AAAAAA',
            wickUpColor: '#AAAAAA',
            wickDownColor: '#AAAAAA'
        }
    },
    
    // Drawing primitives configurations
    primitives: {
        line: {
            defaultColor: 'rgba(255, 255, 255, 0.8)',
            defaultWidth: 2,
            styles: {
                solid: 0,
                dotted: 1,
                dashed: 2
            }
        },
        rectangle: {
            defaultColor: 'rgba(255, 255, 255, 0.8)',
            defaultFillColor: 'rgba(255, 255, 255, 0.1)',
            defaultWidth: 2
        }
    },
    
    // API endpoints and settings
    api: {
        bitstamp: {
            baseUrl: 'https://www.bitstamp.net/api/v2',
            endpoints: {
                ohlc: '/ohlc/{symbol}/?step={interval}&limit=1000'
            }
        },
        bybit: {
            baseUrl: 'https://api.bybit.com/v5',
            endpoints: {
                kline: '/market/kline?category=linear&symbol={symbol}USDT&interval={interval}&limit=1000'
            }
        }
    },
    
    // CORS proxies for API fallbacks
    corsProxies: [
        '', // Direct fetch (no proxy)
        'https://corsproxy.io/?{url}',
        'https://api.allorigins.win/raw?url={url}'
    ],
    
    // UI settings
    ui: {
        loadingTimeout: 7000,
        errorDisplayTime: 3000,
        throttleDelay: 100,
        resizeThrottleDelay: 100
    }
};

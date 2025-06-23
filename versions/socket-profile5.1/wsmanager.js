class WebSocketManager {
    constructor(url, exchange, options = {}) {
        this.url = url;
        this.exchange = exchange;
        this.name = options.name || exchange;
        this.connected = false;
        this.connecting = false;
        this.reconnectDelay = options.reconnectDelay || 2000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.pingInterval = options.pingInterval || 30000;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.subscriptions = new Set();
        this.pendingSubscriptions = new Set();
        this.handlers = {}; // Initialize handlers as an empty object
        this.pingTimer = null;
        this.lastPongTime = 0;
        this.intentionalClose = false;
        this.connectionTimeout = null;
        this.messageCallback = null;
        this.networkStatus = navigator.onLine;

        // Track last message received time for freeze detection (Bitstamp)
        this.lastMessageTimestamp = Date.now();

        // DEBUG flag for easy removal of debug logs
        this.DEBUG = false; 

        // Throttle log messages to avoid console spam
        this.throttledLog = this.throttle(console.log, 1000);

        // Bind methods that will be used as callbacks
        this._handleNetworkStatusChange = this._handleNetworkStatusChange.bind(this);
        this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
        this._handleConnectionOpen = this._handleConnectionOpen.bind(this);
        this._handleMessage = this._handleMessage.bind(this);

        // Add event listeners for online/offline events
        window.addEventListener('online', () => this._handleNetworkStatusChange(true));
        window.addEventListener('offline', () => this._handleNetworkStatusChange(false));

        // Add event listener for visibility change (tab focus/blur, sleep/wake)
        document.addEventListener('visibilitychange', () => this._handleVisibilityChange());

        // Connect immediately
        this.connect();
    }

    throttle(func, limit) {
        let lastCall = 0;
        let lastResult;
        
        return (...args) => {
            const now = Date.now();
            if (now - lastCall >= limit) {
                lastCall = now;
                lastResult = func(...args);
            }
            return lastResult;
        };
    }

    // Add ping/pong mechanism
    startPingPong() {
        this.stopPingPong(); 
        this.lastPongTime = Date.now();

        this.pingTimer = setInterval(() => {
            if (!this.connected || !this.ws) {
                this.stopPingPong();
                return;
            }

            // Check if we've received a pong recently
            const now = Date.now();
            if (now - this.lastPongTime > this.pingInterval * 2) {
                this.reconnect(true); 
                return;
            }

            // --- Bitstamp freeze detection ---
            if (this.exchange === 'bitstamp') {
                // If no message received in 60 seconds, force reconnect
                if (now - this.lastMessageTimestamp > 60000) {
                    this.reconnect(true);
                    return;
                }
            }

            try {
                // Send ping based on exchange
                if (this.exchange === 'bybit') {
                    this.ws.send(JSON.stringify({ op: 'ping' }));
                } else if (this.exchange === 'bitstamp') {
                    // Bitstamp doesn't support ping, so we'll just check connection state
                    if (this.ws.readyState !== WebSocket.OPEN) {
                        this.reconnect(true);
                    } else {
                        // For Bitstamp, just update the pong time since we can't ping
                        this.lastPongTime = now;
                    }
                }
            } catch (error) {
                this.reconnect(true);
            }
        }, this.pingInterval);
    }

    stopPingPong() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    connect() {
        // Prevent multiple connection attempts
        if (this.connected || this.connecting) return;

        this.connecting = true;

        // Clean up any existing connection
        this._cleanupExistingConnection();

        try {
            // Check network status before attempting to connect
            if (!navigator.onLine) {
                this.connecting = false;
                setTimeout(() => this.reconnect(false), this.reconnectDelay);
                return;
            }

            // Create new WebSocket connection
            this.ws = new WebSocket(this.url);

            // Set binary type for better performance with binary messages
            if (this.exchange === 'bybit') {
                this.ws.binaryType = 'arraybuffer';
            }

            // Set connection timeout with adaptive timing based on previous attempts
            const baseTimeout = 10000; 
            const maxTimeout = 30000;  
            const timeout = Math.min(baseTimeout * (1 + this.reconnectAttempts * 0.5), maxTimeout);

            this.connectionTimeout = setTimeout(() => {
                if (!this.connected) {
                    this._cleanupExistingConnection();
                    this.connecting = false;
                    this.reconnect();
                }
            }, timeout);

            // Connection opened handler
            this.ws.onopen = this._handleConnectionOpen.bind(this);

            // Message handler with performance optimizations
            this.ws.onmessage = (event) => {
                // Update last message timestamp for freeze detection
                this.lastMessageTimestamp = Date.now();
                this._handleMessage(event);
            };

            // Error handler - log but let onclose handle reconnection
            this.ws.onerror = (error) => {
                this.reportError(error);
            };

            // Close handler with reconnection logic
            this.ws.onclose = (event) => {
                clearTimeout(this.connectionTimeout);
                this.connected = false;
                this.connecting = false;

                // Don't reconnect if we're intentionally closing
                if (!this.intentionalClose) {
                    setTimeout(() => this.reconnect(), 100);
                }
                this.intentionalClose = false;
            };
        } catch (error) {
            clearTimeout(this.connectionTimeout);
            this.connected = false;
            this.connecting = false;

            // Schedule reconnection with a small delay
            setTimeout(() => this.reconnect(), 500);
        }
    }

    reconnect(force = false) {
        // Don't attempt reconnection if we're offline
        if (!navigator.onLine) {
            return;
        }

        this.stopPingPong();

        // Clean up existing connection
        if (this.ws) {
            try {
                // Only attempt to close if the connection is still open
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.close();
                }
            } catch (e) {
                // Ignore errors when closing
            }
            this.ws = null;
        }

        if (force) {
            // Reset reconnect attempts on forced reconnect
            this.reconnectAttempts = 0;
        }

        // Check if we've reached max attempts
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn(`Max reconnect attempts reached for ${this.exchange}`);
            // Reset reconnect attempts after a longer timeout to try again later
            setTimeout(() => {
                this.reconnectAttempts = 0;
                if (navigator.onLine) this.connect();
            }, this.reconnectDelay * 10);
            return;
        }

        // Calculate exponential backoff with a maximum limit
        const maxBackoffMultiplier = 10;
        const backoffMultiplier = Math.min(Math.pow(1.5, this.reconnectAttempts), maxBackoffMultiplier);
        const delay = this.reconnectDelay * backoffMultiplier;

        this.reconnectAttempts++;

        // Log reconnection attempt
        console.log(`Reconnecting to ${this.exchange} in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        // Schedule reconnection
        setTimeout(() => {
            // Double-check online status before attempting to connect
            if (navigator.onLine) {
                this.connect();
            } else {
                console.log(`Still offline, delaying ${this.exchange} reconnect`);
                // Try again later when potentially back online
                setTimeout(() => this.reconnect(false), this.reconnectDelay);
            }
        }, delay);
    }

    processMessage(data) {
        // Find all handlers that should receive this message
        for (const channel in this.handlers) {
            const handlers = this.handlers[channel];

            // For Bitstamp
            if (this.exchange === 'bitstamp' && data.channel === channel) {
                handlers.forEach(handler => handler(data));
                return;
            }

            // For Bybit
            if (this.exchange === 'bybit' && data.topic === channel) {
                handlers.forEach(handler => handler(data));
                return;
            }
        }
    }

    subscribe(channel, handler) {
        // Initialize handlers array for this channel if it doesn't exist
        if (!this.handlers[channel]) {
            this.handlers[channel] = [];
        }

        // Add the handler
        this.handlers[channel].push(handler);

        // Add to subscriptions set
        this.subscriptions.add(channel);

        // Debug log for subscribe
        if (this.DEBUG && this.exchange === 'bitstamp') {
            console.debug(`[WS-DEBUG] [${this.exchange}] subscribe() called for channel:`, channel, 'at', new Date().toISOString());
        }

        // If already connected, send subscription immediately
        if (this.connected) {
            this.sendSubscription(channel);
        } else {
            // Otherwise, add to pending subscriptions
            this.pendingSubscriptions.add(channel);
        }

        return this; // For chaining
    }

    unsubscribe(channel, handler) {
        if (!this.handlers[channel]) return;

        if (this.DEBUG && this.exchange === 'bitstamp') {
            console.debug(`[WS-DEBUG] [${this.exchange}] unsubscribe() called for channel:`, channel, 'at', new Date().toISOString());
        }

        if (handler) {
            // Remove specific handler
            this.handlers[channel] = this.handlers[channel].filter(h => h !== handler);

            // If no handlers left, unsubscribe from channel
            if (this.handlers[channel].length === 0) {
                this.sendUnsubscription(channel);
                delete this.handlers[channel];
                this.subscriptions.delete(channel);
                this.pendingSubscriptions.delete(channel);
            }
        } else {
            // Remove all handlers for this channel
            this.sendUnsubscription(channel);
            delete this.handlers[channel];
            this.subscriptions.delete(channel);
            this.pendingSubscriptions.delete(channel);
        }
    }

    sendSubscription(channel) {
        if (!this.connected || !this.ws) return;

        try {
            if (this.exchange === 'bitstamp') {
                const msg = {
                    event: 'bts:subscribe',
                    data: { channel }
                };
                if (this.DEBUG) {
                    console.debug(`[WS-DEBUG] [${this.exchange}] Sending SUBSCRIBE:`, msg, 'at', new Date().toISOString());
                }
                this.ws.send(JSON.stringify(msg));
            } else if (this.exchange === 'bybit') {
                const msg = {
                    op: 'subscribe',
                    args: [channel]
                };
                if (this.DEBUG) {
                    console.debug(`[WS-DEBUG] [${this.exchange}] Sending SUBSCRIBE:`, msg, 'at', new Date().toISOString());
                }
                this.ws.send(JSON.stringify(msg));
            }
            // Removed debug console log for subscription
        } catch (error) {
            this.throttledLog('error', `Error subscribing to ${channel}: ${error}`);
        }
    }

    sendUnsubscription(channel) {
        if (!this.connected || !this.ws) return;

        try {
            if (this.exchange === 'bitstamp') {
                const msg = {
                    event: 'bts:unsubscribe',
                    data: { channel }
                };
                if (this.DEBUG) {
                    console.debug(`[WS-DEBUG] [${this.exchange}] Sending UNSUBSCRIBE:`, msg, 'at', new Date().toISOString());
                }
                this.ws.send(JSON.stringify(msg));
            } else if (this.exchange === 'bybit') {
                const msg = {
                    op: 'unsubscribe',
                    args: [channel]
                };
                if (this.DEBUG) {
                    console.debug(`[WS-DEBUG] [${this.exchange}] Sending UNSUBSCRIBE:`, msg, 'at', new Date().toISOString());
                }
                this.ws.send(JSON.stringify(msg));
            }
            this.throttledLog('unsubscribe', `Unsubscribed from ${this.exchange} channel: ${channel}`);
        } catch (error) {
            this.throttledLog('error', `Error unsubscribing from ${channel}: ${error}`);
            this.reportError(error);
        }
    }

    resubscribeAll() {
        // Clear pending subscriptions
        this.pendingSubscriptions.clear();

        // Resubscribe to all channels
        for (const channel of this.subscriptions) {
            this.sendSubscription(channel);
        }
    }

    close() {
        this.intentionalClose = true;
        this._cleanupExistingConnection();
        this.connected = false;
        this.connecting = false;
    }

    // Add isConnected method for external status checking
    isConnected() {
        return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN && navigator.onLine;
    }

    // Add a message callback for processing all messages
    setMessageCallback(callback) {
        if (typeof callback === 'function') {
            this.messageCallback = callback;
        }
    }

    // Report errors to the error manager
    reportError(error, options = {}) {
        // Use ErrorManager if available
        if (window.ErrorManager) {
            return window.ErrorManager.reportError('websocket', error, {
                exchange: this.exchange,
                name: this.name,
                ...options
            });
        } else {
            // Fallback to console
            console.error(`WebSocket error (${this.exchange}):`, error);
            return null;
        }
    }

    // Get connection status information
    getStatus() {
        return {
            exchange: this.exchange,
            connected: this.connected,
            connecting: this.connecting,
            reconnectAttempts: this.reconnectAttempts,
            subscriptions: Array.from(this.subscriptions),
            pendingSubscriptions: Array.from(this.pendingSubscriptions),
            lastPongTime: this.lastPongTime,
            lastMessageTime: this.lastMessageTime || 0
        };
    }

    // Debug method to log current state
    debug() {
        // Commented out debug log to reduce console noise
        // console.log(`WebSocketManager(${this.exchange}) Status:`, this.getStatus());
        return this.getStatus();
    }

    // Helper methods for cleaner code organization
    _cleanupExistingConnection() {
        if (this.ws) {
            this.intentionalClose = true;
            try {
                this.ws.close();
            } catch (e) {
                // Ignore errors when closing
            }
            this.ws = null;
        }

        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }

    _handleConnectionOpen() {
        clearTimeout(this.connectionTimeout);
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.lastPongTime = Date.now();

        // Only log the connection message once per session for each exchange
        if (!window.wsConnectionLogged) {
            window.wsConnectionLogged = {};
        }
        if (!window.wsConnectionLogged[this.exchange]) {
            console.log(`${this.exchange} WebSocket connected successfully`);
            window.wsConnectionLogged[this.exchange] = true;
        }

        // Start ping/pong for connection keepalive
        this.startPingPong();

        // Resubscribe to all channels
        this.resubscribeAll();

        // Dispatch connection event
        window.dispatchEvent(new CustomEvent(`websocket-connected-${this.exchange.toLowerCase()}`, {
            detail: { timestamp: Date.now() }
        }));
    }

    _handleMessage(e) {
        // Update timestamps for connection health monitoring
        const now = Date.now();
        this.lastMessageTime = now;
        this.lastPongTime = now; // Update pong time on any message

        try {
            let data;

            // Fast path for string data (most common case)
            if (typeof e.data === 'string') {
                // Try direct parsing first - most messages will be valid JSON
                try {
                    data = JSON.parse(e.data);
                } catch (parseError) {
                    // Only attempt recovery for specific error types
                    if (parseError.message.includes('position')) {
                        // Attempt to recover from position-based JSON errors
                        const posMatch = parseError.message.match(/position (\d+)/i);
                        if (posMatch && posMatch[1]) {
                            const errorPos = parseInt(posMatch[1]);
                            // Truncate the string slightly before the error position
                            const safePos = Math.max(0, errorPos - 10);
                            const truncated = e.data.substring(0, safePos);
                            // Try to close the JSON properly
                            const fixedJson = truncated + ']}'; // Simple fix attempt
                            try {
                                data = JSON.parse(fixedJson);
                                // Don't log recovery to reduce console noise
                            } catch (e) {
                                // If recovery failed, throw a more specific error
                                throw new Error(`Failed to recover malformed JSON: ${parseError.message}`);
                            }
                        } else {
                            throw parseError;
                        }
                    } else {
                        throw parseError;
                    }
                }
            } else if (e.data instanceof ArrayBuffer) {
                // Handle binary data for Bybit - use cached decoder if available
                if (!this._textDecoder) {
                    this._textDecoder = new TextDecoder();
                }
                const rawData = this._textDecoder.decode(e.data);
                try {
                    data = JSON.parse(rawData);
                } catch (parseError) {
                    throw new Error(`Binary data parse error: ${parseError.message}`);
                }
            } else {
                // Handle other data types (Blob, etc.) - should be rare
                throw new Error(`Unsupported message data type: ${typeof e.data}`);
            }

            // Fast return for pong messages
            if (data.op === 'pong') return;

// --- DEDUPLICATION STATE ---
if (!window._wsDedup) {
    window._wsDedup = {
        liquidations: new Set(),
        whales: new Set(),
        clearOld: function(set, ms = 5000) {
            const now = Date.now();
            const toDelete = [];
            for (const key of set) {
                const [ts] = key.split('|');
                if (now - Number(ts) > ms) toDelete.push(key);
            }
            // Batch delete operations for better performance
            toDelete.forEach(key => set.delete(key));
        }
    };
}

// Whale/Liquidation alert logic (Bybit)
if (this.exchange === 'bybit' && data.topic?.startsWith("liquidation.") && data.data) {
    const liquidation = Array.isArray(data.data) ? data.data[0] : data.data;
    const side = liquidation.side === 'Buy' ? 'LONG' : 'SHORT';
    const price = parseFloat(liquidation.price);
    const size = parseFloat(liquidation.size || liquidation.qty);
    const value = price * size;
    
    // Always get the latest threshold from localStorage or window.consoleMessageThreshold
    let liqThreshold = (
        (typeof window.consoleMessageThreshold !== "undefined" && window.consoleMessageThreshold) ||
        (typeof localStorage !== "undefined" && localStorage.getItem("liquidationThreshold") && parseFloat(localStorage.getItem("liquidationThreshold"))) ||
        100000
    );

    if (value >= liqThreshold) {
        const ts = Date.now();
        const dedupKey = `${Math.round(ts/2000)*2000}|${price}|${size}|${side}`;
        window._wsDedup.clearOld(window._wsDedup.liquidations, 5000);
        
        if (!window._wsDedup.liquidations.has(dedupKey)) {
            window._wsDedup.liquidations.add(dedupKey);
            if (window.consoleCaptureAddMessage) {
                const formattedValue = window.utils && window.utils.formatLargeNumber
                    ? window.utils.formatLargeNumber(value)
                    : value.toLocaleString(undefined, {maximumFractionDigits: 0});
                window.consoleCaptureAddMessage(`L $${formattedValue}`, side === 'LONG' ? 'long' : 'short');
            }
        }
    }
}

// Whale alert logic (Bitstamp)
if (
    this.exchange === 'bitstamp' &&
    data.channel?.startsWith("live_trades_") &&
    data.event === 'trade' &&
    data.data
) {
    const trade = data.data;
    const price = parseFloat(trade.price);
    const size = parseFloat(trade.amount || trade.size || trade.qty);
    
    // Use Bitstamp trade.type field for buy/sell detection
    let side = '';
    if ('type' in trade) {
        // According to Bitstamp docs: type: 0 = buy, 1 = sell
        side = trade.type === 0 ? 'BUY' : (trade.type === 1 ? 'SELL' : '');
    }
    
    if (side === 'BUY' || side === 'SELL') {
        const value = price * size;
        
        // Always get the latest threshold from localStorage or window.consoleMessageThreshold
        let whaleThreshold = (
            (typeof window.consoleMessageThreshold !== "undefined" && window.consoleMessageThreshold) ||
            (typeof localStorage !== "undefined" && localStorage.getItem("whaleAlertThreshold") && parseFloat(localStorage.getItem("whaleAlertThreshold"))) ||
            100000
        );

        if (value >= whaleThreshold) {
            const ts = Date.now();
            const dedupKey = `${Math.round(ts/2000)*2000}|${price}|${size}|${side}`;
            window._wsDedup.clearOld(window._wsDedup.whales, 5000);
            
            if (!window._wsDedup.whales.has(dedupKey)) {
                window._wsDedup.whales.add(dedupKey);
                if (window.consoleCaptureAddMessage) {
                    const formattedValue = window.utils && window.utils.formatLargeNumber
                        ? window.utils.formatLargeNumber(value)
                        : value.toLocaleString(undefined, {maximumFractionDigits: 0});
                    const whaleType = side === 'BUY' ? 'whale-buy' : 'whale-sell';
                    window.consoleCaptureAddMessage(`T $${formattedValue}`, whaleType);
                }
            }
        }
    }
}

            // Process message with the callback if registered
            if (this.messageCallback) {
                this.messageCallback(data);
            }

            // Process subscriptions - most important part
            this.processMessage(data);
        } catch (error) {
            // Only log errors at a throttled rate to prevent console spam
            this.throttledLog('error', `Error processing ${this.exchange} message: ${error.message}`);

            // Report to ErrorManager if available
            if (window.ErrorManager) {
                window.ErrorManager.reportError('websocket', error, {
                    exchange: this.exchange,
                    name: this.name
                });
            }
        }
    }

    // Network status change handler
    _handleNetworkStatusChange(isOnline) {
        this.throttledLog('network', `Network status changed: ${isOnline ? 'online' : 'offline'}`);
        this.networkStatus = isOnline;

        if (isOnline) {
            // We're back online, check connection and reconnect if needed
            if (!this.isConnected()) {
                this.throttledLog('network', `Network restored, reconnecting ${this.exchange} WebSocket`);
                // Reset reconnect attempts to ensure quick reconnection
                this.reconnectAttempts = 0;
                this.reconnect(true);
            }
        } else {
            // We're offline, no need to keep trying to reconnect
            this.throttledLog('network', `Network offline, pausing ${this.exchange} WebSocket reconnection`);
            this._cleanupExistingConnection();
        }
    }

    // Visibility change handler
    _handleVisibilityChange() {
        const isVisible = document.visibilityState === 'visible';
        // Removed debug console logs for visibility changes
        if (isVisible) {
            if (!this.isConnected() && navigator.onLine) {
                this.reconnectAttempts = 0;
                this.reconnect(true);
            } else if (this.isConnected()) {
                this._sendPing();
            }
        }
    }

    // Send ping to check connection
    _sendPing() {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        try {
            switch (this.exchange) {
                case 'bybit':
                    this.ws.send(JSON.stringify({ op: 'ping' }));
                    break;
                case 'bitstamp':
                    // No native ping; rely on readyState checks
                    if (this.ws.readyState !== WebSocket.OPEN) {
                        this.reconnect(true);
                    }
                    break;
                default:
                    // Fallback for other exchanges
                    this.ws.send(JSON.stringify({ op: 'ping' }));
            }
        } catch (error) {
            this.throttledLog('ping', `Error sending ping to ${this.exchange}: ${error}`);
            this.reconnect(true);
        }
    }

    // Check connection health
    checkConnectionHealth() {
        // Skip if we're offline
        if (!navigator.onLine) return false;

        const now = Date.now();
        const isStale = now - this.lastPongTime > this.pingInterval * 2;

        if (!this.isConnected() || isStale) {
            this.throttledLog('health', `${this.exchange} WebSocket connection unhealthy, reconnecting`);
            this.reconnect(true);
            return false;
        }

        return true;
    }
}

// Create just one manager per exchange
window.bitstampWsManager = new WebSocketManager('wss://ws.bitstamp.net', 'bitstamp');
window.bybitWsManager = new WebSocketManager('wss://stream.bybit.com/v5/public/linear', 'bybit');

// Make the class available globally
window.WebSocketManager = WebSocketManager;

// export default WebSocketManager;

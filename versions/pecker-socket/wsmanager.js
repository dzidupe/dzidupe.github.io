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
        
        const throttled = (...args) => {
            const now = Date.now();
            if (now - lastCall >= limit) {
                lastCall = now;
                lastResult = func(...args);
                return lastResult;
            }
            return lastResult;
        };
        
        return throttled;
    }
    
    // Add ping/pong mechanism
    startPingPong() {
        this.stopPingPong(); // Clear any existing timers
        this.lastPongTime = Date.now();
        
        this.pingTimer = setInterval(() => {
            if (!this.connected || !this.ws) {
                this.stopPingPong();
                return;
            }
            
            // Check if we've received a pong recently
            const now = Date.now();
            if (now - this.lastPongTime > this.pingInterval * 2) {
                this.throttledLog('ping', `${this.exchange} WebSocket ping timeout`);
                this.reconnect(true); // Force reconnect
                return;
            }
            
            try {
                // Send ping based on exchange
                if (this.exchange === 'bybit') {
                    this.ws.send(JSON.stringify({ op: 'ping' }));
                    // Update lastPongTime immediately for Bybit to prevent false timeouts
                    this.lastPongTime = Date.now();
                } else if (this.exchange === 'bitstamp') {
                    // Bitstamp doesn't support ping, so we'll just check connection state
                    if (this.ws.readyState !== WebSocket.OPEN) {
                        this.reconnect(true);
                    } else {
                        // For Bitstamp, just update the pong time since we can't ping
                        this.lastPongTime = Date.now();
                    }
                }
            } catch (error) {
                this.throttledLog('ping', `Error sending ping to ${this.exchange}: ${error}`);
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
        if (this.connected || this.connecting) return;
        
        this.connecting = true;
        // Remove the console log for connecting
        
        // Clean up any existing connection
        this._cleanupExistingConnection();
        
        try {
            // Use the correct endpoint based on exchange
            const url = this._getOptimalEndpoint();
            
            this.ws = new WebSocket(url);
            
            // Set binary type for better performance with binary messages
            if (this.exchange === 'bybit') {
                this.ws.binaryType = 'arraybuffer';
            }
            
            // Connection timeout with exponential backoff
            const timeout = Math.min(10000 * (1 + this.reconnectAttempts * 0.5), 30000);
            this.connectionTimeout = setTimeout(() => {
                if (!this.connected) {
                    this.throttledLog('timeout', `${this.exchange} WebSocket connection timeout after ${timeout}ms`);
                    this._cleanupExistingConnection();
                    this.connecting = false;
                    this.reconnect();
                }
            }, timeout);
            
            // Connection opened handler
            this.ws.onopen = this._handleConnectionOpen.bind(this);
            
            // Message handler with performance optimizations
            this.ws.onmessage = this._handleMessage.bind(this);
            
            // Error handler
            this.ws.onerror = (error) => {
                this.throttledLog('error', `${this.exchange} WebSocket error: ${error.message || 'Unknown error'}`);
                this.reportError(error);
                // Don't reconnect here, let onclose handle it
            };
            
            // Close handler with reconnection logic
            this.ws.onclose = (event) => {
                clearTimeout(this.connectionTimeout);
                this.connected = false;
                this.connecting = false;
                
                const reason = event.reason || 'Unknown reason';
                const code = event.code || 'Unknown code';
                this.throttledLog('close', `${this.exchange} WebSocket closed: ${code} - ${reason}`);
                
                // Don't reconnect if we're intentionally closing
                if (!this.intentionalClose) {
                    this.reconnect();
                }
                this.intentionalClose = false;
            };
        } catch (error) {
            clearTimeout(this.connectionTimeout);
            this.throttledLog('error', `Error creating ${this.exchange} WebSocket: ${error.message}`);
            this.reportError(error);
            this.connected = false;
            this.connecting = false;
            this.reconnect();
        }
    }
    
    reconnect(force = false) {
        // Don't attempt reconnection if we're offline
        if (!navigator.onLine) {
            console.log(`Network offline, skipping ${this.exchange} reconnect`);
            return;
        }
        
        this.stopPingPong();
        
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {
                // Ignore errors when closing
            }
            this.ws = null;
        }
        
        if (force) {
            // Reset reconnect attempts on forced reconnect
            this.reconnectAttempts = 0;
        }
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn(`Max reconnect attempts reached for ${this.exchange}`);
            // Reset reconnect attempts after a longer timeout to try again later
            setTimeout(() => {
                this.reconnectAttempts = 0;
                this.connect();
            }, this.reconnectDelay * 10);
            return;
        }
        
        const delay = this.reconnectDelay * Math.min(Math.pow(1.5, this.reconnectAttempts), 10);
        this.reconnectAttempts++;
        
        console.log(`Reconnecting to ${this.exchange} in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
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
                this.ws.send(JSON.stringify({
                    event: 'bts:subscribe',
                    data: { channel }
                }));
            } else if (this.exchange === 'bybit') {
                this.ws.send(JSON.stringify({
                    op: 'subscribe',
                    args: [channel]
                }));
            }
            // Remove the console log for subscription
        } catch (error) {
            this.throttledLog('error', `Error subscribing to ${channel}: ${error}`);
        }
    }
    
    sendUnsubscription(channel) {
        if (!this.connected || !this.ws) return;
        
        try {
            if (this.exchange === 'bitstamp') {
                this.ws.send(JSON.stringify({
                    event: 'bts:unsubscribe',
                    data: { channel }
                }));
            } else if (this.exchange === 'bybit') {
                this.ws.send(JSON.stringify({
                    op: 'unsubscribe',
                    args: [channel]
                }));
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
        console.log(`WebSocketManager(${this.exchange}) Status:`, this.getStatus());
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
    
    _getOptimalEndpoint() {
        if (this.exchange === 'bybit') {
            // Use v5 API for better performance and reliability
            return 'wss://stream.bybit.com/v5/public/linear';
        }
        return this.url;
    }
    
    _handleConnectionOpen() {
        clearTimeout(this.connectionTimeout);
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.lastPongTime = Date.now();
        
        console.log(`${this.exchange} WebSocket connected successfully`);
        
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
        this.lastMessageTime = Date.now();
        this.lastPongTime = Date.now(); // Update pong time on any message
        
        try {
            let data;
            
            // Optimize parsing based on message type
            if (typeof e.data === 'string') {
                data = JSON.parse(e.data);
            } else {
                // Handle binary data for Bybit
                const text = new TextDecoder().decode(e.data);
                data = JSON.parse(text);
            }
            
            // Handle pong responses
            if (data.op === 'pong') return;
            
            // Process message with the callback
            if (this.messageCallback) {
                this.messageCallback(data);
            }
            
            // Process subscriptions
            this.processMessage(data);
        } catch (error) {
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
        // Remove the console log for visibility changes
        
        if (isVisible) {
            // Tab is visible again, check connection health
            if (!this.isConnected() && navigator.onLine) {
                // Remove this console log
                // this.throttledLog('visibility', `Tab visible, checking ${this.exchange} WebSocket connection`);
                // Reset reconnect attempts to ensure quick reconnection
                this.reconnectAttempts = 0;
                this.reconnect(true);
            } else if (this.isConnected()) {
                // Connection exists but might be stale, send a ping to verify
                // Remove this console log
                // this.throttledLog('visibility', `Tab visible, verifying ${this.exchange} WebSocket connection`);
                this._sendPing();
            }
        }
    }
    
    // Send ping to check connection
    _sendPing() {
        if (!this.connected || !this.ws) return;
        
        try {
            // Send ping based on exchange
            if (this.exchange === 'bybit') {
                this.ws.send(JSON.stringify({ op: 'ping' }));
            } else if (this.exchange === 'bitstamp') {
                // For exchanges without ping support, check readyState
                if (this.ws.readyState !== WebSocket.OPEN) {
                    this.reconnect(true);
                }
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

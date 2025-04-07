// errorManager.js - Centralized error handling system

const ErrorManager = {
    // Configuration
    config: {
        maxErrors: 50,
        errorRetentionTime: 30 * 60 * 1000, // 30 minutes
        criticalErrorThreshold: 5, // Number of similar errors to consider critical
        samplingRate: 1.0, // Percentage of errors to log (1.0 = 100%)
    },
    
    // Error storage
    errors: [],
    errorCounts: new Map(), // Track error frequency
    listeners: [],
    
    // Initialize
    init() {
        // Set up global error handler
        window.addEventListener('error', this.handleGlobalError.bind(this));
        window.addEventListener('unhandledrejection', this.handleUnhandledRejection.bind(this));
        
        // Clean errors periodically
        setInterval(() => this.cleanOldErrors(), 5 * 60 * 1000);
        
        // Connect to existing error systems
        if (window.DOMOptimizer && window.DOMOptimizer.errorNotifications) {
            window.DOMOptimizer.errorNotifications.listeners.push(
                this.handleDOMOptimizerError.bind(this)
            );
        }
        
        return this;
    },
    
    // Handle global errors
    handleGlobalError(event) {
        this.reportError('window', event.error || new Error(event.message), {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error ? event.error.stack : null
        });
        
        // Don't prevent default handling
        return false;
    },
    
    // Handle unhandled promise rejections
    handleUnhandledRejection(event) {
        const error = event.reason instanceof Error ? 
            event.reason : new Error(String(event.reason));
            
        this.reportError('promise', error, {
            unhandledRejection: true
        });
    },
    
    // Handle errors from DOMOptimizer
    handleDOMOptimizerError(errorInfo) {
        // Already processed by our system, just add a tag
        errorInfo.data = errorInfo.data || {};
        errorInfo.data.source = 'DOMOptimizer';
        
        // Add to our tracking without duplicating
        this.trackError(errorInfo);
    },
    
    // Report an error
    reportError(source, error, options = {}) {
        // Apply sampling if configured
        if (this.config.samplingRate < 1.0 && Math.random() > this.config.samplingRate) {
            return null;
        }
        
        const errorInfo = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            source: source,
            message: error instanceof Error ? error.message : String(error),
            error: error instanceof Error ? error : new Error(String(error)),
            stack: error instanceof Error ? error.stack : new Error().stack,
            timestamp: Date.now(),
            data: options || {},
            fatal: options.fatal || false,
            handled: true
        };
        
        // Add to tracking
        this.trackError(errorInfo);
        
        // Log to console with appropriate level - reduce verbosity
        if (errorInfo.fatal) {
            console.error(`[FATAL] [${errorInfo.source}] ${errorInfo.message}`);
        } else if (options.silent !== true) {
            // Only log non-silent errors
            console.error(`[${errorInfo.source}] ${errorInfo.message}`);
        }
        
        // Notify listeners
        this.notifyListeners(errorInfo);
        
        // Dispatch event
        window.dispatchEvent(new CustomEvent('error-manager', {
            detail: errorInfo
        }));
        
        return errorInfo;
    },
    
    // Track error frequency and patterns
    trackError(errorInfo) {
        // Add to errors array
        this.errors.unshift(errorInfo);
        
        // Trim if needed
        if (this.errors.length > this.config.maxErrors) {
            this.errors.pop();
        }
        
        // Track error frequency by signature
        const signature = this.getErrorSignature(errorInfo);
        const count = (this.errorCounts.get(signature) || 0) + 1;
        this.errorCounts.set(signature, count);
        
        // Check if this is becoming a critical issue
        if (count >= this.config.criticalErrorThreshold) {
            this.handleCriticalError(errorInfo, count);
        }
    },
    
    // Get a unique signature for similar errors
    getErrorSignature(errorInfo) {
        // Create a signature based on error message and source
        // Strip out variable parts like timestamps, IDs, etc.
        let message = errorInfo.message;
        
        // Remove common variable parts from error messages
        message = message.replace(/\b\d+\b/g, 'N') // Replace numbers
                         .replace(/["'].*?["']/g, '"STR"') // Replace string literals
                         .replace(/\b[0-9a-f]{8,}\b/g, 'ID'); // Replace IDs
                         
        return `${errorInfo.source}:${message}`;
    },
    
    // Handle critical errors (errors that occur frequently)
    handleCriticalError(errorInfo, count) {
        // Only trigger once when threshold is reached
        if (count === this.config.criticalErrorThreshold) {
            console.warn(`CRITICAL ERROR PATTERN DETECTED: ${errorInfo.message} has occurred ${count} times`);
            
            // Create a critical error notification
            const criticalInfo = {
                ...errorInfo,
                critical: true,
                occurrences: count
            };
            
            // Dispatch critical error event
            window.dispatchEvent(new CustomEvent('critical-error', {
                detail: criticalInfo
            }));
            
            // Notify listeners with critical flag
            this.notifyListeners(criticalInfo);
        }
    },
    
    // Clean old errors
    cleanOldErrors() {
        const now = Date.now();
        const cutoff = now - this.config.errorRetentionTime;
        
        // Remove old errors
        this.errors = this.errors.filter(error => error.timestamp >= cutoff);
        
        // Reset counts for old error signatures
        for (const [signature, count] of this.errorCounts.entries()) {
            // Check if any errors with this signature still exist
            const hasRecentErrors = this.errors.some(error => 
                this.getErrorSignature(error) === signature
            );
            
            if (!hasRecentErrors) {
                this.errorCounts.delete(signature);
            }
        }
    },
    
    // Add error listener
    addListener(listener) {
        if (typeof listener === 'function' && !this.listeners.includes(listener)) {
            this.listeners.push(listener);
            return true;
        }
        return false;
    },
    
    // Remove error listener
    removeListener(listener) {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
            this.listeners.splice(index, 1);
            return true;
        }
        return false;
    },
    
    // Notify all listeners
    notifyListeners(errorInfo) {
        this.listeners.forEach(listener => {
            try {
                listener(errorInfo);
            } catch (e) {
                console.error('Error in error listener:', e);
            }
        });
    },
    
    // Get recent errors
    getRecentErrors(limit = 10, filterFn = null) {
        let result = this.errors;
        
        if (filterFn && typeof filterFn === 'function') {
            result = result.filter(filterFn);
        }
        
        return result.slice(0, limit);
    },
    
    // Get error statistics
    getErrorStats() {
        const now = Date.now();
        const last5Min = now - 5 * 60 * 1000;
        const last15Min = now - 15 * 60 * 1000;
        const last60Min = now - 60 * 60 * 1000;
        
        return {
            total: this.errors.length,
            last5Min: this.errors.filter(e => e.timestamp >= last5Min).length,
            last15Min: this.errors.filter(e => e.timestamp >= last15Min).length,
            last60Min: this.errors.filter(e => e.timestamp >= last60Min).length,
            bySource: this.getErrorCountBySource(),
            mostFrequent: this.getMostFrequentErrors(5)
        };
    },
    
    // Get error count by source
    getErrorCountBySource() {
        const counts = {};
        
        this.errors.forEach(error => {
            counts[error.source] = (counts[error.source] || 0) + 1;
        });
        
        return counts;
    },
    
    // Get most frequent errors
    getMostFrequentErrors(limit = 5) {
        const entries = Array.from(this.errorCounts.entries());
        
        // Sort by count (descending)
        entries.sort((a, b) => b[1] - a[1]);
        
        // Return top N
        return entries.slice(0, limit).map(([signature, count]) => ({
            signature,
            count,
            // Find a sample error with this signature
            sample: this.errors.find(error => this.getErrorSignature(error) === signature)
        }));
    }
};

// Initialize and expose globally
window.ErrorManager = ErrorManager.init();

export default ErrorManager;

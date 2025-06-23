// errorAnalytics.js - Shared error reporting and analytics utility

const ErrorAnalytics = {
    config: {
        maxErrors: 100,
        errorRetentionTime: 30 * 60 * 1000, // 30 minutes
        criticalErrorThreshold: 5,
        samplingRate: 1.0, // 100% by default
    },

    errors: [],
    errorCounts: new Map(),
    listeners: [],

    // Categorize errors for analytics
    categorizeError(error) {
        if (!error) return 'unknown';
        if (error.code === 'TIMEOUT') return 'timeout';
        if (error.code === 'NETWORK_ERROR') return 'network';
        if (error.code === 'CIRCUIT_OPEN') return 'circuit_breaker';
        if (error.name === 'TypeError') return 'type';
        if (error.name === 'SyntaxError') return 'syntax';
        if (error.message && error.message.includes('permission')) return 'permission';
        return 'application';
    },

    // Report error with context and analytics
    reportError(source, error, options = {}) {
        // Normalize error
        const normalizedError = error instanceof Error ? error : new Error(String(error));

        // Sampling
        if (this.config.samplingRate < 1.0 && Math.random() > this.config.samplingRate) {
            return null;
        }

        const category = this.categorizeError(normalizedError);

        const errorInfo = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            source,
            message: normalizedError.message,
            error: normalizedError,
            stack: normalizedError.stack || new Error().stack,
            timestamp: Date.now(),
            category,
            data: {
                ...options,
                userAgent: navigator?.userAgent,
                url: window.location?.href,
            },
            fatal: options.fatal || false,
            handled: true,
        };

        this._trackAndLogError(errorInfo, options.silent);
        this._notifyAndDispatch(errorInfo);

        return errorInfo;
    },

    _trackAndLogError(errorInfo, silent) {
        this.trackError(errorInfo);

        if (errorInfo.fatal) {
            console.error(`[FATAL] [${errorInfo.source}] ${errorInfo.message}`, errorInfo);
        } else if (silent !== true) {
            console.error(`[${errorInfo.source}] ${errorInfo.message}`, errorInfo.data);
        }
    },

    _notifyAndDispatch(errorInfo) {
        this.notifyListeners(errorInfo);
        window.dispatchEvent(new CustomEvent('error-analytics', { detail: errorInfo }));
    },

    // Track error frequency and patterns
    trackError(errorInfo) {
        this.errors.unshift(errorInfo);
        if (this.errors.length > this.config.maxErrors) {
            this.errors.pop();
        }

        const signature = this.getErrorSignature(errorInfo);
        const count = (this.errorCounts.get(signature) || 0) + 1;
        this.errorCounts.set(signature, count);

        if (count >= this.config.criticalErrorThreshold) {
            this.handleCriticalError(errorInfo, count);
        }
    },

    getErrorSignature(errorInfo) {
        let message = errorInfo.message;
        message = message.replace(/\b\d+\b/g, 'N')
                         .replace(/["'].*?["']/g, '"STR"')
                         .replace(/\b[0-9a-f]{8,}\b/g, 'ID');
        return `${errorInfo.source}:${message}`;
    },

    handleCriticalError(errorInfo, count) {
        if (count === this.config.criticalErrorThreshold) {
            console.warn(`CRITICAL ERROR PATTERN DETECTED: ${errorInfo.message} has occurred ${count} times`);
            const criticalInfo = {
                ...errorInfo,
                critical: true,
                occurrences: count
            };
            window.dispatchEvent(new CustomEvent('critical-error-analytics', {
                detail: criticalInfo
            }));
            this.notifyListeners(criticalInfo);
        }
    },

    cleanOldErrors() {
        const now = Date.now();
        const cutoff = now - this.config.errorRetentionTime;
        this.errors = this.errors.filter(error => error.timestamp >= cutoff);

        for (const [signature, count] of this.errorCounts.entries()) {
            const hasRecentErrors = this.errors.some(error =>
                this.getErrorSignature(error) === signature
            );
            if (!hasRecentErrors) {
                this.errorCounts.delete(signature);
            }
        }
    },

    addListener(listener) {
        if (typeof listener === 'function' && !this.listeners.includes(listener)) {
            this.listeners.push(listener);
            return true;
        }
        return false;
    },

    removeListener(listener) {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
            this.listeners.splice(index, 1);
            return true;
        }
        return false;
    },

    notifyListeners(errorInfo) {
        this.listeners.forEach(listener => {
            try {
                listener(errorInfo);
            } catch (e) {
                console.error('Error in error analytics listener:', e);
            }
        });
    },

    getRecentErrors(limit = 10, filterFn = null) {
        let result = this.errors;
        if (filterFn && typeof filterFn === 'function') {
            result = result.filter(filterFn);
        }
        return result.slice(0, limit);
    },

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

    getErrorCountBySource() {
        const counts = {};
        this.errors.forEach(error => {
            counts[error.source] = (counts[error.source] || 0) + 1;
        });
        return counts;
    },

    getMostFrequentErrors(limit = 5) {
        const entries = Array.from(this.errorCounts.entries());
        entries.sort((a, b) => b[1] - a[1]);
        return entries.slice(0, limit).map(([signature, count]) => ({
            signature,
            count,
            sample: this.errors.find(error => this.getErrorSignature(error) === signature)
        }));
    }
};

export default ErrorAnalytics;
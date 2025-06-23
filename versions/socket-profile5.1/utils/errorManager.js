// errorManager.js - Centralized error handling system

import ErrorAnalytics from './shared/errorAnalytics.js';

const ErrorManager = {
    // Initialize
    init() {
        // Set up global error handler
        window.addEventListener('error', this.handleGlobalError.bind(this));
        window.addEventListener('unhandledrejection', this.handleUnhandledRejection.bind(this));

        // Clean errors periodically
        setInterval(() => ErrorAnalytics.cleanOldErrors(), 5 * 60 * 1000);

        // DOMOptimizer has been removed
        // No need to connect to it anymore

        return this;
    },

    // Handle global errors
    handleGlobalError(event) {
        ErrorAnalytics.reportError('window', event.error || new Error(event.message), {
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

        ErrorAnalytics.reportError('promise', error, {
            unhandledRejection: true
        });
    },

    // This method is kept for backward compatibility
    // but is no longer used since DOMOptimizer has been removed
    handleDOMOptimizerError(errorInfo) {
        // Already processed by our system, just add a tag
        errorInfo.data = errorInfo.data || {};
        errorInfo.data.source = 'DOMOptimizer';

        // Add to our tracking without duplicating
        ErrorAnalytics.trackError(errorInfo);
    },

    // Proxy to ErrorAnalytics for reporting
    reportError(source, error, options = {}) {
        return ErrorAnalytics.reportError(source, error, options);
    },

    // Proxy to ErrorAnalytics for listeners
    addListener(listener) {
        return ErrorAnalytics.addListener(listener);
    },

    removeListener(listener) {
        return ErrorAnalytics.removeListener(listener);
    },

    notifyListeners(errorInfo) {
        return ErrorAnalytics.notifyListeners(errorInfo);
    },

    // Proxy to ErrorAnalytics for error queries
    getRecentErrors(limit = 10, filterFn = null) {
        return ErrorAnalytics.getRecentErrors(limit, filterFn);
    },

    getErrorStats() {
        return ErrorAnalytics.getErrorStats();
    }
};

// Initialize and expose globally
window.ErrorManager = ErrorManager.init();

export default ErrorManager;

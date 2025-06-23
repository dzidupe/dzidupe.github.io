// fallbackManager.js - Centralized fallback management

import CircuitBreakerManager from './shared/circuitBreakerManager.js';
import ErrorAnalytics from './shared/errorAnalytics.js';

const FallbackManager = {
    // Configuration
    config: {
        maxFallbackAttempts: 3,
        fallbackTimeout: 5000, // milliseconds
        retryDelay: 1000,
        backoffFactor: 1.5,
        jitterFactor: 0.25, // 25% jitter
        defaultTimeout: 10000,
        errorSamplingRate: 1.0, // Percentage of errors to log (1.0 = 100%)
    },

    // Fallback state tracking
    fallbackState: new Map(),

    // Use shared circuit breaker manager
    circuitBreaker: new CircuitBreakerManager(),

    // Use shared error analytics
    errorAnalytics: ErrorAnalytics,

    // Initialize with enhanced error handling
    init() {
        // Clean fallback state periodically
        setInterval(() => this.cleanFallbackState(), 60000);

        // Clean error analytics periodically
        setInterval(() => this.errorAnalytics.cleanOldErrors(), 24 * 60 * 60 * 1000); // Daily

        // Handle unhandled promise rejections
        window.addEventListener('unhandledrejection', this.handleUnhandledRejection.bind(this));

        return this;
    },

    // Handle unhandled promise rejections
    handleUnhandledRejection(event) {
        if (event.reason && event.reason._handledByFallbackManager) return;

        const error = event.reason instanceof Error ?
            event.reason : new Error(String(event.reason));

        this.errorAnalytics.reportError('FallbackManager:unhandledRejection', error, {
            unhandledRejection: true
        });

        // Mark as handled
        if (event.reason) event.reason._handledByFallbackManager = true;
    },

    // This method is kept for backward compatibility
    // but is no longer used since DOMOptimizer has been removed
    handleDOMOptimizerError(errorInfo) {
        if (errorInfo.source && errorInfo.source.includes('FallbackManager')) {
            this.errorAnalytics.reportError('FallbackManager:domOptimizer', errorInfo.error, errorInfo.data || {});
        }
    },

    // Use shared error analytics for reporting and stats
    getErrorAnalytics() {
        return this.errorAnalytics.getErrorStats();
    },

    // Use shared circuit breaker manager
    isCircuitOpen(name) {
        return this.circuitBreaker.isCircuitOpen(name);
    },

    recordSuccess(name) {
        this.circuitBreaker.recordSuccess(name);
    },

    recordFailure(name) {
        this.circuitBreaker.recordFailure(name);
    },

    // Enhanced withFallback with circuit breaker
    async withFallback(primaryOperation, fallbackOperations, options = {}) {
        const config = {
            name: options.name || 'anonymous',
            maxAttempts: options.maxAttempts || this.config.maxFallbackAttempts,
            timeout: options.timeout || this.config.defaultTimeout,
            retryDelay: options.retryDelay || this.config.retryDelay,
            backoffFactor: options.backoffFactor || this.config.backoffFactor,
            onFallback: options.onFallback || (() => {}),
            onSuccess: options.onSuccess || (() => {}),
            onFailure: options.onFailure || (() => {}),
            context: options.context || {},
            useCircuitBreaker: options.useCircuitBreaker !== false
        };

        // Check circuit breaker
        if (config.useCircuitBreaker && this.isCircuitOpen(config.name)) {
            const circuitError = new Error(`Circuit breaker open for ${config.name}`);
            circuitError.code = 'CIRCUIT_OPEN';

            this.errorAnalytics.reportError('FallbackManager:circuitBreaker', circuitError, {
                operationName: config.name,
                context: config.context
            });

            if (typeof config.onFailure === 'function') {
                config.onFailure(circuitError, {
                    circuitOpen: true,
                    context: config.context
                });
            }

            throw circuitError;
        }

        // Ensure fallbackOperations is an array
        const fallbacks = Array.isArray(fallbackOperations) ?
            fallbackOperations : [fallbackOperations];

        // Try primary operation first
        try {
            // Create timeout promise
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    const timeoutError = new Error(`Operation timed out after ${config.timeout}ms`);
                    timeoutError.code = 'TIMEOUT';
                    reject(timeoutError);
                }, config.timeout);
            });

            // Execute primary operation with timeout
            const result = await Promise.race([
                typeof primaryOperation === 'function' ?
                    primaryOperation(config.context) : primaryOperation,
                timeoutPromise
            ]);

            // Record success for circuit breaker
            if (config.useCircuitBreaker) {
                this.recordSuccess(config.name);
            }

            // Call success callback
            if (typeof config.onSuccess === 'function') {
                config.onSuccess(result, {
                    source: 'primary',
                    context: config.context
                });
            }

            return result;
        } catch (error) {
            // Record failure for circuit breaker
            if (config.useCircuitBreaker) {
                this.recordFailure(config.name);
            }

            // Log the primary operation failure
            this.errorAnalytics.reportError('FallbackManager:primaryFailed', error, {
                operationName: config.name,
                context: config.context
            });

            // Primary operation failed, try fallbacks
            return this.tryFallbacks(fallbacks, error, config);
        }
    },

    // Try fallback operations in sequence
    async tryFallbacks(fallbacks, originalError, config) {
        let lastError = originalError;

        // Track fallback attempt for this operation
        const stateKey = config.name;
        if (!this.fallbackState.has(stateKey)) {
            this.fallbackState.set(stateKey, {
                attempts: 0,
                lastAttempt: Date.now(),
                errors: []
            });
        }

        const state = this.fallbackState.get(stateKey);
        state.attempts++;
        state.lastAttempt = Date.now();
        state.errors.push(originalError.message);

        // Limit error history
        if (state.errors.length > 10) {
            state.errors = state.errors.slice(-10);
        }

        // Try each fallback in sequence
        for (let i = 0; i < fallbacks.length; i++) {
            const fallback = fallbacks[i];

            try {
                // Calculate delay with exponential backoff and jitter
                const attemptNumber = i + 1;
                const baseDelay = config.retryDelay * Math.pow(config.backoffFactor, attemptNumber - 1);
                const jitter = baseDelay * this.config.jitterFactor * (Math.random() * 2 - 1);
                const delay = Math.max(0, Math.floor(baseDelay + jitter));

                // Wait before trying fallback
                await new Promise(resolve => setTimeout(resolve, delay));

                // Call fallback callback
                if (typeof config.onFallback === 'function') {
                    config.onFallback(lastError, {
                        fallbackIndex: i,
                        delay,
                        context: config.context
                    });
                }

                // Create timeout promise
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        const timeoutError = new Error(`Fallback operation timed out after ${config.timeout}ms`);
                        timeoutError.code = 'TIMEOUT';
                        reject(timeoutError);
                    }, config.timeout);
                });

                // Execute fallback operation with timeout
                const result = await Promise.race([
                    typeof fallback === 'function' ?
                        fallback(lastError, config.context) : fallback,
                    timeoutPromise
                ]);

                // Call success callback
                if (typeof config.onSuccess === 'function') {
                    config.onSuccess(result, {
                        source: 'fallback',
                        fallbackIndex: i,
                        context: config.context
                    });
                }

                return result;
            } catch (error) {
                lastError = error;
                // Continue to next fallback
            }
        }

        // All fallbacks failed
        if (typeof config.onFailure === 'function') {
            config.onFailure(lastError, {
                primaryFailed: true,
                fallbacksFailed: fallbacks.length,
                context: config.context
            });
        }

        // Report comprehensive failure to error system
        this.errorAnalytics.reportError('FallbackManager:allFallbacksFailed', lastError, {
            operationName: config.name,
            attemptsCount: fallbacks.length + 1, // primary + fallbacks
            originalError: originalError.message,
            context: config.context
        });

        throw lastError;
    },

    // Clean up old fallback state entries
    cleanFallbackState() {
        const now = Date.now();
        const maxAge = 30 * 60 * 1000; // 30 minutes

        for (const [key, state] of this.fallbackState.entries()) {
            if (now - state.lastAttempt > maxAge) {
                this.fallbackState.delete(key);
            }
        }
    },

    // Get fallback statistics
    getStats() {
        const stats = {
            totalOperations: this.fallbackState.size,
            totalAttempts: 0,
            operationsWithFallbacks: 0
        };

        for (const [key, state] of this.fallbackState.entries()) {
            stats.totalAttempts += state.attempts;
            if (state.attempts > 1) {
                stats.operationsWithFallbacks++;
            }
        }

        return stats;
    }
};

// Initialize and expose globally
window.FallbackManager = FallbackManager.init();

export default FallbackManager;

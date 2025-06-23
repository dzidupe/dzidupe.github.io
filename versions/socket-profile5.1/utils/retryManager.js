// retryManager.js - Advanced retry mechanism with circuit breaker pattern

import CircuitBreakerManager from './shared/circuitBreakerManager.js';
import ErrorAnalytics from './shared/errorAnalytics.js';

const circuitBreaker = new CircuitBreakerManager();
const errorAnalytics = ErrorAnalytics;

const RetryManager = {
    // Configuration
    config: {
        defaultMaxRetries: 3,
        defaultRetryDelay: 1000,
        defaultBackoffFactor: 1.5,
        defaultTimeout: 10000,
        maxJitter: 0.25 // Maximum jitter factor (25%)
    },

    // Initialize
    init() {
        // No need to clean circuit state here; handled by CircuitBreakerManager
        return this;
    },
    
    // Main retry function
    async retry(operation, options = {}) {
        const config = {
            name: options.name || 'anonymous',
            maxRetries: options.maxRetries || this.config.defaultMaxRetries,
            retryDelay: options.retryDelay || this.config.defaultRetryDelay,
            backoffFactor: options.backoffFactor || this.config.defaultBackoffFactor,
            timeout: options.timeout || this.config.defaultTimeout,
            retryIf: options.retryIf || (error => true), // Default: retry all errors
            onRetry: options.onRetry || (() => {}),
            onSuccess: options.onSuccess || (() => {}),
            onFailure: options.onFailure || (() => {}),
            useCircuitBreaker: options.useCircuitBreaker !== false, // Default: true
            context: options.context || {}
        };

        // Check circuit breaker
        if (config.useCircuitBreaker && circuitBreaker.isCircuitOpen(config.name)) {
            const circuitError = new Error(`Circuit breaker open for ${config.name}`);
            circuitError.code = 'CIRCUIT_OPEN';
            circuitError.retriable = false;

            errorAnalytics.reportError('RetryManager:circuitBreaker', circuitError, { operationName: config.name, context: config.context });

            if (typeof config.onFailure === 'function') {
                config.onFailure(circuitError, {
                    attempt: 0,
                    circuitOpen: true,
                    context: config.context
                });
            }

            throw circuitError;
        }

        let lastError = null;
        let attempt = 0;

        while (attempt <= config.maxRetries) {
            try {
                // Create timeout promise
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        const timeoutError = new Error(`Operation timed out after ${config.timeout}ms`);
                        timeoutError.code = 'TIMEOUT';
                        timeoutError.retriable = true;
                        reject(timeoutError);
                    }, config.timeout);
                });

                // Execute operation with timeout
                const result = await Promise.race([
                    typeof operation === 'function' ? operation(attempt, config.context) : operation,
                    timeoutPromise
                ]);

                // Success - reset circuit breaker
                if (config.useCircuitBreaker) {
                    circuitBreaker.recordSuccess(config.name);
                }

                // Call success callback
                if (typeof config.onSuccess === 'function') {
                    config.onSuccess(result, {
                        attempt,
                        retries: attempt,
                        context: config.context
                    });
                }

                return result;
            } catch (error) {
                lastError = error;
                attempt++;

                // Record failure for circuit breaker
                if (config.useCircuitBreaker) {
                    circuitBreaker.recordFailure(config.name);
                }

                // Report error
                errorAnalytics.reportError('RetryManager:retry', error, { operationName: config.name, attempt, context: config.context });

                // Check if we should retry
                const shouldRetry = attempt <= config.maxRetries &&
                                   (error.retriable !== false) &&
                                   (typeof config.retryIf === 'function' ?
                                    config.retryIf(error, attempt, config.context) : true);

                if (!shouldRetry) {
                    break;
                }

                // Calculate delay with exponential backoff and jitter
                const baseDelay = config.retryDelay * Math.pow(config.backoffFactor, attempt - 1);
                const jitter = baseDelay * this.config.maxJitter * (Math.random() * 2 - 1);
                const delay = Math.max(0, Math.floor(baseDelay + jitter));

                // Call retry callback
                if (typeof config.onRetry === 'function') {
                    config.onRetry(error, {
                        attempt,
                        delay,
                        nextAttempt: attempt + 1,
                        context: config.context
                    });
                }

                // Wait before next attempt
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // All retries failed
        errorAnalytics.reportError('RetryManager:allRetriesFailed', lastError, { operationName: config.name, attempts: attempt, context: config.context });

        if (typeof config.onFailure === 'function') {
            config.onFailure(lastError, {
                attempt: attempt - 1,
                circuitOpen: false,
                context: config.context
            });
        }

        throw lastError;
    },
    
// Circuit breaker logic is now handled by CircuitBreakerManager
    
    // Fetch with retry
    async fetchWithRetry(url, options = {}, retryOptions = {}) {
        const fetchOptions = { ...options };
        
        // Default retry options for fetch
        const defaultRetryOptions = {
            name: `fetch:${url.substring(0, 50)}`,
            maxRetries: 3,
            retryDelay: 1000,
            timeout: 15000,
            retryIf: (error) => {
                // Retry network errors and 5xx responses
                if (error.name === 'TypeError' || error.code === 'TIMEOUT') {
                    return true;
                }
                if (error.response && error.response.status >= 500) {
                    return true;
                }
                return false;
            },
            onRetry: (error, { attempt, delay }) => {
                console.warn(`Retrying fetch to ${url} after error (attempt ${attempt}): ${error.message}`);
            }
        };
        
        const finalRetryOptions = { ...defaultRetryOptions, ...retryOptions };
        
        return this.retry(async () => {
            const response = await fetch(url, fetchOptions);
            
            // Throw for error status codes
            if (!response.ok) {
                const error = new Error(`HTTP error ${response.status}: ${response.statusText}`);
                error.response = response;
                error.status = response.status;
                error.retriable = response.status >= 500; // Only retry server errors
                throw error;
            }
            
            return response;
        }, finalRetryOptions);
    }
};

// Initialize and expose globally
window.RetryManager = RetryManager.init();

export default RetryManager;
// retryManager.js - Advanced retry mechanism with circuit breaker pattern

const RetryManager = {
    // Configuration
    config: {
        defaultMaxRetries: 3,
        defaultRetryDelay: 1000,
        defaultBackoffFactor: 1.5,
        defaultTimeout: 10000,
        circuitBreakerThreshold: 5, // Failures before opening circuit
        circuitResetTimeout: 30000, // Time before trying again
        maxJitter: 0.25 // Maximum jitter factor (25%)
    },
    
    // Circuit breaker state
    circuits: new Map(),
    
    // Initialize
    init() {
        // Clean circuit state periodically
        setInterval(() => this.cleanCircuits(), 60000);
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
        if (config.useCircuitBreaker && this.isCircuitOpen(config.name)) {
            const circuitError = new Error(`Circuit breaker open for ${config.name}`);
            circuitError.code = 'CIRCUIT_OPEN';
            circuitError.retriable = false;
            
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
                    this.recordSuccess(config.name);
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
                    this.recordFailure(config.name);
                }
                
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
        if (typeof config.onFailure === 'function') {
            config.onFailure(lastError, { 
                attempt: attempt - 1, 
                circuitOpen: false,
                context: config.context
            });
        }
        
        throw lastError;
    },
    
    // Circuit breaker implementation
    getCircuit(name) {
        if (!this.circuits.has(name)) {
            this.circuits.set(name, {
                failures: 0,
                lastFailure: 0,
                state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
                lastStateChange: Date.now()
            });
        }
        return this.circuits.get(name);
    },
    
    recordSuccess(name) {
        const circuit = this.getCircuit(name);
        
        if (circuit.state === 'HALF_OPEN') {
            // Reset on success in half-open state
            circuit.failures = 0;
            circuit.state = 'CLOSED';
            circuit.lastStateChange = Date.now();
            console.log(`Circuit breaker for ${name} closed after successful test request`);
        } else if (circuit.state === 'CLOSED') {
            // Reset failures counter
            circuit.failures = 0;
        }
    },
    
    recordFailure(name) {
        const circuit = this.getCircuit(name);
        const now = Date.now();
        
        circuit.lastFailure = now;
        
        if (circuit.state === 'HALF_OPEN') {
            // Failed during test, open circuit again
            circuit.state = 'OPEN';
            circuit.lastStateChange = now;
            console.warn(`Circuit breaker for ${name} reopened after failed test request`);
        } else if (circuit.state === 'CLOSED') {
            // Increment failures counter
            circuit.failures++;
            
            // Check if threshold reached
            if (circuit.failures >= this.config.circuitBreakerThreshold) {
                circuit.state = 'OPEN';
                circuit.lastStateChange = now;
                console.warn(`Circuit breaker for ${name} opened after ${circuit.failures} consecutive failures`);
            }
        }
    },
    
    isCircuitOpen(name) {
        const circuit = this.getCircuit(name);
        const now = Date.now();
        
        if (circuit.state === 'OPEN') {
            // Check if it's time to try again
            if (now - circuit.lastStateChange > this.config.circuitResetTimeout) {
                circuit.state = 'HALF_OPEN';
                circuit.lastStateChange = now;
                console.log(`Circuit breaker for ${name} half-open, allowing test request`);
                return false;
            }
            return true;
        }
        
        return false;
    },
    
    // Clean up old circuit breaker entries
    cleanCircuits() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        for (const [name, circuit] of this.circuits.entries()) {
            // Remove circuits that haven't been used in a day and are closed
            if (circuit.state === 'CLOSED' && 
                now - circuit.lastFailure > maxAge && 
                now - circuit.lastStateChange > maxAge) {
                this.circuits.delete(name);
            }
        }
    },
    
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
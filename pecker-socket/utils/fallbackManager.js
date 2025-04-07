// fallbackManager.js - Centralized fallback management

const FallbackManager = {
    // Configuration
    config: {
        maxFallbackAttempts: 3,
        fallbackTimeout: 5000, // milliseconds
        retryDelay: 1000,
        backoffFactor: 1.5,
        jitterFactor: 0.25, // 25% jitter
        defaultTimeout: 10000,
        // Error handling enhancements
        errorSamplingRate: 1.0, // Percentage of errors to log (1.0 = 100%)
        errorRetentionTime: 30 * 60 * 1000, // 30 minutes
        circuitBreakerThreshold: 5, // Failures before opening circuit
        circuitResetTimeout: 30000, // Time before trying again
    },
    
    // Fallback state tracking
    fallbackState: new Map(),
    
    // Circuit breaker state
    circuits: new Map(),

    // Error analytics storage
    errorStats: {
        categories: new Map(),
        sources: new Map(),
        total: 0,
        lastReset: Date.now()
    },
    
    // Initialize with enhanced error handling
    init() {
        // Clean fallback state periodically
        setInterval(() => this.cleanFallbackState(), 60000);
        
        // Clean error stats periodically
        setInterval(() => this.resetErrorStats(), 24 * 60 * 60 * 1000); // Daily
        
        // Connect to ErrorManager if available
        if (window.ErrorManager) {
            this.errorManager = window.ErrorManager;
        }
        
        // Connect to DOMOptimizer if available
        if (window.DOMOptimizer && window.DOMOptimizer.errorNotifications) {
            window.DOMOptimizer.errorNotifications.listeners.push(
                this.handleDOMOptimizerError.bind(this)
            );
        }
        
        // Handle unhandled promise rejections
        window.addEventListener('unhandledrejection', this.handleUnhandledRejection.bind(this));
        
        return this;
    },
    
    // Handle unhandled promise rejections
    handleUnhandledRejection(event) {
        if (event.reason && event.reason._handledByFallbackManager) return;
        
        const error = event.reason instanceof Error ? 
            event.reason : new Error(String(event.reason));
            
        this.reportError('unhandledRejection', error, {
            unhandledRejection: true
        });
        
        // Mark as handled
        if (event.reason) event.reason._handledByFallbackManager = true;
    },

    // Handle errors from DOMOptimizer
    handleDOMOptimizerError(errorInfo) {
        if (errorInfo.source && errorInfo.source.includes('FallbackManager')) {
            this.reportError('domOptimizer', errorInfo.error, errorInfo.data || {});
        }
    },

    // Categorize errors for better analytics
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

    // Enhanced error reporting with categorization and sampling
    reportError(source, error, options = {}) {
        // Apply sampling if configured
        if (this.config.errorSamplingRate < 1.0 && Math.random() > this.config.errorSamplingRate) {
            return null;
        }
        
        const errorSource = `FallbackManager:${source}`;
        const category = this.categorizeError(error);
        
        // Update error analytics
        this.updateErrorStats(category, source);
        
        const errorInfo = {
            source: errorSource,
            error: error instanceof Error ? error : new Error(String(error)),
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : new Error().stack,
            timestamp: Date.now(),
            category: category,
            data: options || {},
            fatal: options.fatal || false
        };
        
        // Use ErrorManager if available
        if (this.errorManager) {
            return this.errorManager.reportError(errorSource, error, {
                ...options,
                category: category
            });
        }
        
        // Fallback to basic error reporting - only log fatal errors
        if (options.fatal) {
            console.error(`[${errorSource}:${category}] ${errorInfo.message}`, errorInfo);
        }
        
        return errorInfo;
    },

    // Update error statistics for analytics
    updateErrorStats(category, source) {
        this.errorStats.total++;
        
        // Update category stats
        const categoryCount = this.errorStats.categories.get(category) || 0;
        this.errorStats.categories.set(category, categoryCount + 1);
        
        // Update source stats
        const sourceCount = this.errorStats.sources.get(source) || 0;
        this.errorStats.sources.set(source, sourceCount + 1);
    },

    // Reset error statistics
    resetErrorStats() {
        this.errorStats.categories.clear();
        this.errorStats.sources.clear();
        this.errorStats.total = 0;
        this.errorStats.lastReset = Date.now();
    },

    // Get error analytics
    getErrorAnalytics() {
        const analytics = {
            total: this.errorStats.total,
            byCategory: Object.fromEntries(this.errorStats.categories),
            bySource: Object.fromEntries(this.errorStats.sources),
            since: new Date(this.errorStats.lastReset).toISOString()
        };
        
        // Calculate percentages
        analytics.categoryPercentages = {};
        for (const [category, count] of this.errorStats.categories.entries()) {
            analytics.categoryPercentages[category] = this.errorStats.total ? 
                (count / this.errorStats.total * 100).toFixed(1) + '%' : '0%';
        }
        
        return analytics;
    },

    // Circuit breaker implementation
    isCircuitOpen(name) {
        const circuit = this.circuits.get(name);
        if (!circuit) return false;
        
        const now = Date.now();
        
        if (circuit.state === 'OPEN') {
            // Check if it's time to try again
            if (now - circuit.lastStateChange > this.config.circuitResetTimeout) {
                circuit.state = 'HALF_OPEN';
                circuit.lastStateChange = now;
                console.log(`Circuit breaker for ${name} entering half-open state`);
                return false;
            }
            return true;
        }
        
        return false;
    },

    // Record success for circuit breaker
    recordSuccess(name) {
        const circuit = this.circuits.get(name);
        if (!circuit) return;
        
        if (circuit.state === 'HALF_OPEN') {
            // Successful test request, close circuit
            circuit.state = 'CLOSED';
            circuit.failures = 0;
            circuit.lastStateChange = Date.now();
            console.log(`Circuit breaker for ${name} closed after successful test request`);
        } else if (circuit.state === 'CLOSED') {
            // Reset failures counter
            circuit.failures = 0;
        }
    },

    // Record failure for circuit breaker
    recordFailure(name) {
        if (!this.circuits.has(name)) {
            this.circuits.set(name, {
                state: 'CLOSED',
                failures: 0,
                lastFailure: Date.now(),
                lastStateChange: Date.now()
            });
        }
        
        const circuit = this.circuits.get(name);
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
            
            this.reportError('circuitBreaker', circuitError, {
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
            this.reportError('primaryFailed', error, {
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
        this.reportError('allFallbacksFailed', lastError, {
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

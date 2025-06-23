// memoryManager.js - Centralized memory management utilities

const MemoryManager = {
    // Configuration
    config: {
        cleanupInterval: 60000, // Default: 1 minute between cleanups
        maxCacheAge: 10 * 60 * 1000, // Default: 10 minutes
        maxCacheSize: 1000, // Default maximum entries per cache
    },
    
    lastCleanupTime: Date.now(),
    
    // Check if memory pressure is high
    isHighMemoryPressure: function() {
        if (typeof performance.memory === 'undefined') return false;
        return performance.memory.usedJSHeapSize > 0.7 * performance.memory.jsHeapSizeLimit;
    },
    
    // Check if memory pressure is critical
    isCriticalMemoryPressure: function() {
        if (typeof performance.memory === 'undefined') return false;
        return performance.memory.usedJSHeapSize > 0.8 * performance.memory.jsHeapSizeLimit;
    },
    
    // Get effective cache size based on memory pressure
    getEffectiveCacheSize: function(baseSize = this.config.maxCacheSize) {
        if (this.isCriticalMemoryPressure()) {
            return Math.floor(baseSize * 0.4);
        } else if (this.isHighMemoryPressure()) {
            return Math.floor(baseSize * 0.6);
        }
        return baseSize;
    },
    
    // Get effective cache age based on memory pressure
    getEffectiveCacheAge: function(baseAge = this.config.maxCacheAge) {
        if (this.isCriticalMemoryPressure()) {
            return baseAge * 0.3;
        } else if (this.isHighMemoryPressure()) {
            return baseAge * 0.5;
        }
        return baseAge;
    },
    
    // Clean a Map cache based on age and size
    cleanMapCache: function(cache, keySelector = k => k, valueSelector = v => v.lastUsed || v) {
        if (!cache || !(cache instanceof Map)) return cache;
        
        const now = Date.now();
        const effectiveCacheAge = this.getEffectiveCacheAge();
        
        // Age-based cleanup
        for (const [key, value] of cache.entries()) {
            const timestamp = typeof valueSelector === 'function' ? valueSelector(value) : value;
            if (now - timestamp > effectiveCacheAge) {
                cache.delete(keySelector(key));
            }
        }
        
        // Size-based cleanup
        const effectiveCacheSize = this.getEffectiveCacheSize();
        if (cache.size > effectiveCacheSize) {
            const entries = Array.from(cache.entries());
            entries.sort((a, b) => {
                const valueA = typeof valueSelector === 'function' ? valueSelector(a[1]) : a[1];
                const valueB = typeof valueSelector === 'function' ? valueSelector(b[1]) : b[1];
                return valueB - valueA; // Sort by most recently used
            });
            return new Map(entries.slice(0, effectiveCacheSize));
        }
        
        return cache;
    },
    
    // Clean an array cache based on size
    cleanArrayCache: function(array, maxSize = this.config.maxCacheSize, sortFn = null) {
        if (!array || !Array.isArray(array)) return array;
        
        const effectiveMaxSize = this.getEffectiveCacheSize(maxSize);
        
        if (array.length <= effectiveMaxSize) return array;
        
        // If a sort function is provided, sort and trim
        if (typeof sortFn === 'function') {
            const sorted = [...array].sort(sortFn);
            return sorted.slice(0, effectiveMaxSize);
        }
        
        // Default to keeping most recent items (assuming newer items are at the end)
        return array.slice(-effectiveMaxSize);
    },
    
    // Clean an array cache based on timestamp property
    cleanTimeBasedArrayCache: function(array, timeProperty, maxAgeMs = this.config.maxCacheAge, maxSize = this.config.maxCacheSize) {
        if (!array || !Array.isArray(array)) return array;

        const now = Date.now();
        const effectiveMaxAge = this.getEffectiveCacheAge(maxAgeMs);
        const effectiveMaxSize = this.getEffectiveCacheSize(maxSize);

        // Early exit if the array is already within size limits and no time-based filtering is needed
        if (!timeProperty && array.length <= effectiveMaxSize) {
            return array;
        }

        // Filter by age if timeProperty is provided
        let filtered = array;
        if (timeProperty) {
            const cutoffTime = now - effectiveMaxAge;
            filtered = array.filter(item => {
                try {
                    const time = typeof timeProperty === 'function' 
                        ? timeProperty(item) 
                        : (item[timeProperty] || 0);
                    return time >= cutoffTime;
                } catch (e) {
                    console.debug('Error accessing timeProperty:', e);
                    return false; // Exclude items with invalid timeProperty
                }
            });
        }

        // Limit by size if necessary
        if (filtered.length > effectiveMaxSize) {
            filtered = filtered.slice(-effectiveMaxSize);
        }

        // Suggest garbage collection if memory pressure is high
        if (filtered.length < array.length / 2) {
            this.suggestGC();
        }

        return filtered;
    },
    
    // Suggest garbage collection if available
    suggestGC: function() {
        if (this.isHighMemoryPressure() && window.gc) {
            setTimeout(() => { try { window.gc(); } catch(e) {} }, 0);
        }
    },
    
    // Main cleanup function that components can call periodically
    performCleanup: function(caches, customCleanupFn) {
        const now = Date.now();
        if (now - this.lastCleanupTime < this.config.cleanupInterval) return false;
        
        this.lastCleanupTime = now;
        
        try {
            // Clean provided caches if any
            if (caches) {
                if (Array.isArray(caches)) {
                    caches.forEach(cache => {
                        if (cache.type === 'map' && cache.map) {
                            this.cleanMapCache(cache.map, cache.keySelector, cache.valueSelector);
                        } else if (cache.type === 'array' && cache.array) {
                            if (cache.timeProperty) {
                                this.cleanTimeBasedArrayCache(cache.array, cache.timeProperty, cache.maxAge, cache.maxSize);
                            } else {
                                this.cleanArrayCache(cache.array, cache.maxSize, cache.sortFn);
                            }
                        }
                    });
                } else if (typeof caches === 'object') {
                    // Handle single cache object
                    if (caches.type === 'map' && caches.map) {
                        this.cleanMapCache(caches.map, caches.keySelector, caches.valueSelector);
                    } else if (caches.type === 'array' && caches.array) {
                        if (caches.timeProperty) {
                            this.cleanTimeBasedArrayCache(caches.array, caches.timeProperty, caches.maxAge, caches.maxSize);
                        } else {
                            this.cleanArrayCache(caches.array, caches.maxSize, caches.sortFn);
                        }
                    }
                }
            }
            
            // Run custom cleanup if provided
            if (typeof customCleanupFn === 'function') {
                customCleanupFn();
            }
            
            // Suggest garbage collection
            this.suggestGC();
            
            return true;
        } catch (error) {
            console.error('Error during memory cleanup:', error);
            return false;
        }
    }
};

// Make it available globally
window.MemoryManager = MemoryManager;

export default MemoryManager;

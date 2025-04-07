/**
 * Enhanced DOM Optimizer - Improved version to reduce forced reflows
 */
const DOMOptimizer = {
    // Batch DOM operations
    readBatch: [],
    writeBatch: [],
    chartUpdateQueue: [],

    // Scheduling flags
    frameScheduled: false,
    chartUpdateScheduled: false,

    // Performance monitoring
    lastFrameTime: 0,
    frameTimes: [],
    maxFrameTimes: 5,

    // Adaptive throttling configuration
    adaptiveThrottling: {
        enabled: true,
        frameTimeThreshold: 16, // 16ms = ~60fps
        lastAdjustment: 0
    },

    // Error notification system
    errorNotifications: {
        enabled: true,
        maxErrors: 5,
        recentErrors: [],
        listeners: []
    },

    // Memory management
    memoryManagement: {
        enabled: true,
        maxFrameTimes: 100,
        gcInterval: 60000,
        lastGCTime: 0,
        maxQueueSize: 1000,
        priorityThreshold: 0.2,
        memoryUsageThreshold: 0.9,
        lastMemoryCheck: 0,
        memoryCheckInterval: 10000,
        memoryState: 'normal',
        highMemoryThreshold: 0.7,
        criticalMemoryThreshold: 0.85,

        checkMemoryUsage: function() {
            if (!window.performance || !window.performance.memory) return false;

            const now = Date.now();
            if (now - this.lastMemoryCheck < this.memoryCheckInterval) return false;

            this.lastMemoryCheck = now;

            const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;
            const previousState = this.memoryState;

            if (memoryRatio > this.criticalMemoryThreshold) {
                this.memoryState = 'critical';
            } else if (memoryRatio > this.highMemoryThreshold) {
                this.memoryState = 'high';
            } else {
                this.memoryState = 'normal';
            }

            if (previousState !== this.memoryState) {
                console.warn(`Memory state changed: ${previousState} -> ${this.memoryState} (${Math.round(memoryRatio * 100)}%)`);
                if (this.memoryState === 'critical') {
                    this.emergencyCleanup();
                } else if (this.memoryState === 'high') {
                    this.aggressiveCleanup();
                }
            }

            return this.memoryState !== 'normal';
        },

        aggressiveCleanup: function() {
            DOMOptimizer.readBatch = DOMOptimizer.readBatch.slice(-Math.floor(this.maxQueueSize * 0.5));
            DOMOptimizer.writeBatch = DOMOptimizer.writeBatch.slice(-Math.floor(this.maxQueueSize * 0.5));
            DOMOptimizer.chartUpdateQueue = DOMOptimizer.chartUpdateQueue.slice(-Math.floor(this.maxQueueSize * 0.3));

            if (window.gc) {
                try {
                    window.gc();
                } catch (e) {
                    console.warn('Failed to trigger garbage collection:', e);
                }
            }

            window.dispatchEvent(new CustomEvent('memory-pressure', { detail: { level: 'high' } }));
        },

        emergencyCleanup: function() {
            DOMOptimizer.readBatch = [];
            DOMOptimizer.writeBatch = [];
            DOMOptimizer.chartUpdateQueue = [];
            DOMOptimizer.frameTimes = [];
            DOMOptimizer.performanceMetrics.frameTimeHistory = [];
            DOMOptimizer.performanceMetrics.readTimes = [];
            DOMOptimizer.performanceMetrics.writeTimes = [];

            if (window.gc) {
                try {
                    window.gc();
                } catch (e) {
                    console.warn('Failed to trigger garbage collection:', e);
                }
            }

            window.dispatchEvent(new CustomEvent('memory-pressure', { detail: { level: 'critical' } }));
            console.warn('Emergency memory cleanup performed');
        },

        trimQueue: function(queue, maxSize) {
            if (queue.length <= maxSize) return queue;

            if (queue[0] && queue[0].priority !== undefined) {
                const sorted = [...queue].sort((a, b) => b.priority - a.priority);
                const highPriorityCount = Math.floor(maxSize * this.priorityThreshold);
                return sorted.slice(0, highPriorityCount).concat(queue.slice(-(maxSize - highPriorityCount)));
            }

            return queue.slice(-maxSize);
        },

        offloadHeavyOperation: function(operation, data) {
            if (DOMOptimizer.workerSupport && DOMOptimizer.workerSupport.enabled) {
                DOMOptimizer.workerSupport.processInWorker(
                    operation,
                    data,
                    (error, result) => {
                        if (error) {
                            console.error('Worker operation failed:', error);
                            try {
                                operation(data);
                            } catch (e) {
                                console.error('Fallback operation failed:', e);
                            }
                        }
                    }
                );
                return true;
            }
            return false;
        },

        detectMemoryLeaks: function() {
            if (!window.performance || !window.performance.memory) return;

            const memoryUsage = performance.memory.usedJSHeapSize;
            this.memorySamples.push({
                time: Date.now(),
                usage: memoryUsage
            });

            if (this.memorySamples.length > this.maxMemorySamples) {
                this.memorySamples.shift();
            }

            if (this.memorySamples.length < 3) return;

            let consistentGrowth = true;
            let growthRate = 0;

            for (let i = 1; i < this.memorySamples.length; i++) {
                const prev = this.memorySamples[i - 1];
                const curr = this.memorySamples[i];
                const growth = (curr.usage - prev.usage) / prev.usage;
                growthRate += growth;

                if (growth <= 0) {
                    consistentGrowth = false;
                    break;
                }
            }

            growthRate = growthRate / (this.memorySamples.length - 1);

            if (consistentGrowth && growthRate > this.growthThreshold) {
                console.warn(`Possible memory leak detected! Average growth rate: ${(growthRate * 100).toFixed(2)}%`);
                window.dispatchEvent(new CustomEvent('memory-leak-warning', {
                    detail: { growthRate, samples: this.memorySamples }
                }));
            }
        }
    },

    // WebWorker support
    workerSupport: {
        enabled: true,
        workers: [],
        maxWorkers: navigator.hardwareConcurrency || 4,

        initWorkers: function() {
            if (!this.enabled) return;

            for (let i = 0; i < this.maxWorkers; i++) {
                try {
                    const worker = new Worker('js/optimizer-worker.js');
                    this.workers.push(worker);
                } catch (e) {
                    console.warn('Failed to create worker:', e);
                }
            }
        },

        processInWorker: function(task, data, callback) {
            if (!this.enabled || this.workers.length === 0) {
                try {
                    const result = task(data);
                    callback(null, result);
                } catch (e) {
                    callback(e);
                }
                return;
            }

            const worker = this.workers[0];

            worker.postMessage({
                task: task.toString(),
                data: data
            });

            worker.onmessage = function(e) {
                callback(null, e.data);
            };

            worker.onerror = function(e) {
                callback(e);
            };
        }
    },

    // Performance metrics
    performanceMetrics: {
        frameTimeHistory: [],
        readTimes: [],
        writeTimes: [],
        maxMetricsHistory: 100,
        lastReportTime: 0,
        reportInterval: 30000
    },

    /**
     * Schedule a DOM read operation
     * @param {Function} readFn Function that reads from DOM
     * @param {Function} callback Optional callback with read result
     */
    scheduleRead: function(readFn, callback) {
        if (typeof readFn !== 'function') {
            console.error('scheduleRead requires a function');
            return;
        }

        this.readBatch.push({ fn: readFn, callback });
        this.scheduleFrame();
    },

    /**
     * Schedule a DOM write operation
     * @param {Function} writeFn Function that writes to DOM
     */
    scheduleWrite: function(writeFn) {
        if (typeof writeFn !== 'function') {
            console.error('scheduleWrite requires a function');
            return;
        }

        this.writeBatch.push(writeFn);
        this.scheduleFrame();
    },

    /**
     * Schedule a frame to process batched operations
     */
    scheduleFrame: function() {
        if (this.memoryManagement.enabled) {
            if (this.readBatch.length > this.memoryManagement.maxQueueSize) {
                console.warn(`Read batch queue overflow (${this.readBatch.length}), trimming oldest items`);
                this.readBatch = this.readBatch.slice(-this.memoryManagement.maxQueueSize);
            }
            if (this.writeBatch.length > this.memoryManagement.maxQueueSize) {
                console.warn(`Write batch queue overflow (${this.writeBatch.length}), trimming oldest items`);
                this.writeBatch = this.writeBatch.slice(-this.memoryManagement.maxQueueSize);
            }
        }

        if (this.frameScheduled) return;

        this.frameScheduled = true;
        requestAnimationFrame(() => this.processFrame());
    },

    /**
     * Process a frame of batched DOM operations
     */
    processFrame: function() {
        const startTime = performance.now();

        try {
            const readResults = this.readBatch.map(({ fn }) => {
                try {
                    return { result: fn(), error: null };
                } catch (error) {
                    this.errorNotifications.reportError('DOM Read', error);
                    return { result: null, error };
                }
            });

            this.readBatch.forEach(({ callback }, index) => {
                if (callback && readResults[index]) {
                    try {
                        callback(readResults[index].result, readResults[index].error);
                    } catch (error) {
                        this.errorNotifications.reportError('DOM Read Callback', error);
                    }
                }
            });

            this.writeBatch.forEach(writeFn => {
                try {
                    writeFn();
                } catch (error) {
                    this.errorNotifications.reportError('DOM Write', error);
                }
            });

            this.readBatch = [];
            this.writeBatch = [];
            this.frameScheduled = false;

            const frameTime = performance.now() - startTime;
            this.frameTimes.push(frameTime);
            if (this.frameTimes.length > this.maxFrameTimes) {
                this.frameTimes.shift();
            }

            this.adjustThrottling(frameTime);

            if (this.readBatch.length > 0 || this.writeBatch.length > 0) {
                this.scheduleFrame();
            }

            if (this.chartUpdateQueue.length > 0 && frameTime < 8) {
                this.processChartUpdates();
            }
        } catch (error) {
            console.error('Error in processFrame:', error);
            this.frameScheduled = false;
            this.errorNotifications.reportError('Frame Processing', error);
        }
    },

    /**
     * Schedule a low-priority update for charts
     * @param {Function} updateFn Function that updates charts
     */
    scheduleChartUpdate: function(updateFn) {
        this.chartUpdateQueue.push(updateFn);

        if (this.chartUpdateQueue.length > 10) {
            this.chartUpdateQueue = this.chartUpdateQueue.slice(-5);
        }

        if (!this.chartUpdateScheduled) {
            this.chartUpdateScheduled = true;
            if (window.requestIdleCallback) {
                window.requestIdleCallback(() => this.processChartUpdates(), { timeout: 300 });
            } else {
                setTimeout(() => this.processChartUpdates(), 200);
            }
        }
    },

    /**
     * Process chart updates with higher priority
     */
    processChartUpdates: function() {
        const startTime = performance.now();
        const maxTime = 8;
        const maxUpdates = 5;

        let processed = 0;

        while (this.chartUpdateQueue.length > 0 &&
               performance.now() - startTime < maxTime &&
               processed < maxUpdates) {
            const updateFn = this.chartUpdateQueue.shift();
            processed++;

            try {
                this.scheduleWrite(updateFn);
            } catch (error) {
                console.error('Error in chart update:', error);
            }
        }

        if (this.chartUpdateQueue.length > 0) {
            this.scheduleChartUpdate();
        } else {
            this.chartUpdateScheduled = false;
        }
    },

    /**
     * Measure element dimensions without causing layout thrashing
     * @param {HTMLElement} element Element to measure
     * @param {Function} callback Callback with measurements
     */
    measureElement: function(element, callback) {
        if (!element || !callback) return;

        this.scheduleRead(() => {
            const rect = element.getBoundingClientRect();
            return {
                width: rect.width,
                height: rect.height,
                top: rect.top,
                left: rect.left,
                right: rect.right,
                bottom: rect.bottom
            };
        }, callback);
    },

    /**
     * Optimize form input handling
     * @param {HTMLElement} form Form element
     * @param {Function} onChange Change handler
     * @return {Function} Cleanup function
     */
    optimizeForm: function(form, onChange) {
        if (!form) return () => {};

        const debouncedChange = this.debounceWithRAF((event) => {
            const formData = new FormData(form);
            const data = {};

            for (const [key, value] of formData.entries()) {
                data[key] = value;
            }

            onChange(data, event);
        });

        form.addEventListener('input', debouncedChange);
        form.addEventListener('change', debouncedChange);

        return () => {
            form.removeEventListener('input', debouncedChange);
            form.removeEventListener('change', debouncedChange);
        };
    },

    /**
     * Debounce a function using requestAnimationFrame
     * @param {Function} fn Function to debounce
     * @return {Function} Debounced function
     */
    debounceWithRAF: function(fn) {
        let rafId = null;
        return function(...args) {
            if (rafId) {
                cancelAnimationFrame(rafId);
            }
            rafId = requestAnimationFrame(() => {
                fn.apply(this, args);
                rafId = null;
            });
        };
    },

    /**
     * Perform garbage collection check
     */
    performGC: function() {
        const now = Date.now();
        if (!this.memoryManagement.enabled ||
            (now - this.memoryManagement.lastGCTime < this.memoryManagement.gcInterval &&
             !this.memoryManagement.checkMemoryUsage())) {
            return;
        }

        this.memoryManagement.lastGCTime = now;
        const memoryPressure = this.memoryManagement.checkMemoryUsage();

        if (memoryPressure === 'critical') {
            this.memoryManagement.emergencyCleanup();
        } else if (memoryPressure === 'high') {
            this.memoryManagement.aggressiveCleanup();
        }
    },

    /**
     * Initialize the DOM Optimizer
     */
    init: function() {
        if (this.workerSupport.enabled) {
            this.workerSupport.initWorkers();
        }

        setInterval(() => this.performGC(), this.memoryManagement.gcInterval);

        if (this.memoryManagement.enabled && window.performance && window.performance.memory) {
            setInterval(() => this.memoryManagement.detectMemoryLeaks(), 30000);
        }

        console.log('DOM Optimizer initialized');
        return this;
    }
};

// Global assignment
window.DOMOptimizer = DOMOptimizer;

// Initialize memory monitoring (assuming startMonitoring was intended)
DOMOptimizer.memoryManagement.startMonitoring = function() {
    if (this.enabled && window.performance && window.performance.memory) {
        this.memorySamples = [];
        this.maxMemorySamples = 10;
        this.growthThreshold = 0.05; // 5% growth threshold
        console.log('Memory monitoring started');
    }
};
DOMOptimizer.memoryManagement.startMonitoring();
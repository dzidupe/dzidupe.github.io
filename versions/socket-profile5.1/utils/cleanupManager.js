/**
 * cleanupManager.js - Centralized registry for resource cleanup actions
 * Allows all modules to register cleanup callbacks for event listeners, intervals, observers, chart objects, etc.
 * Ensures reliable teardown on view switch, app exit, or manual invocation.
 */

const cleanupRegistry = [];

/**
 * Register a cleanup function to be called on teardown.
 * @param {Function} fn - The cleanup callback.
 * @returns {Function} - Unregister function to remove this cleanup.
 */
export function registerCleanup(fn) {
    if (typeof fn === 'function') {
        cleanupRegistry.push(fn);
        // Return unregister function
        return () => {
            const idx = cleanupRegistry.indexOf(fn);
            if (idx !== -1) cleanupRegistry.splice(idx, 1);
        };
    }
    return () => {};
}

/**
 * Run all registered cleanup functions and clear the registry.
 * Call this on view switch, app shutdown, or when you need to forcibly cleanup all resources.
 */
export function runAllCleanups() {
    // Run in reverse order (LIFO) for best teardown
    for (let i = cleanupRegistry.length - 1; i >= 0; i--) {
        try {
            cleanupRegistry[i]();
        } catch (e) {
            // Swallow errors to ensure all cleanups run
            if (window?.console) console.warn('CleanupManager: error during cleanup', e);
        }
    }
    cleanupRegistry.length = 0;
}

/**
 * Get the current number of registered cleanup actions.
 * @returns {number}
 */
export function getCleanupCount() {
    return cleanupRegistry.length;
}

// Optionally expose globally for convenience
if (typeof window !== 'undefined') {
    window.CleanupManager = {
        registerCleanup,
        runAllCleanups,
        getCleanupCount
    };
}

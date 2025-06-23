// ProfileManager.js - Common base functionality for all profile types
// This ensures consistent behavior across volume, open interest, and funding profiles

window.profileManager = (() => {
    // Track active profile type
    let activeProfileType = 'volume'; // Default to volume profile

    // Store references to all profile managers
    const profileManagers = {
        volume: window.volumeProfileManager,
        openInterest: window.openInterestProfileManager,
        funding: window.fundingProfileManager
    };

    // Common initialization function that ensures consistent behavior
    const initializeProfiles = (state) => {
        console.log('Initializing all profiles with consistent settings...');

        // Get saved profile lines from localStorage
        const savedVPLines = localStorage.getItem('volumeProfileLines');
        const defaultVPLines = savedVPLines ? parseInt(savedVPLines) : 150;

        // Common configuration for all profiles
        const commonConfig = {
            priceRange: defaultVPLines,
            position: 0.1,
            alignLeft: true,
            liquidationConsoleWidth: 85,
            profileWidth: 80, // Consistent width for all profiles
            colors: {
                bullish: "rgba(192, 192, 192, 0.7)",
                bearish: "rgba(64, 64, 64, 0.7)",
                median: "rgba(255, 255, 255, 0.8)"
            },
            visible: true,
            liveUpdate: true,
            maxBars: 6000 // Doubled from 3000 to 6000
        };

        // Initialize volume profile with specific settings
        if (window.volumeProfileManager && window.volumeProfileManager.initialize) {
            try {
                // Commented out debug log for volume profile initialization
                // console.log('Initializing volume profile...');
                state.volumeProfile = window.volumeProfileManager.initialize(state, {
                    ...commonConfig,
                    barWidth: 0.8,
                    showMedian: true
                });
            } catch (error) {
                console.warn("Failed to initialize volume profile:", error);
            }
        }

        // Initialize funding profile with specific settings
        if (window.fundingProfileManager && window.fundingProfileManager.initialize) {
            try {
                // No logging to keep console clean
                state.fundingProfile = window.fundingProfileManager.initialize(state, {
                    ...commonConfig,
                    barWidth: 0.8,
                    showMedian: false, // Disable max funding level indicator
                    colors: {
                        positive: "rgba(0, 255, 255, 0.7)", // Aqua for positive funding
                        negative: "rgba(255, 0, 0, 0.7)",   // Red for negative funding
                        neutral: "rgba(150, 150, 150, 0.7)"  // Gray for neutral funding
                    }
                });
            } catch (error) {
                console.warn("Failed to initialize funding profile:", error);
            }
        }

        // Initialize open interest profile with specific settings
        if (window.openInterestProfileManager && window.openInterestProfileManager.initialize) {
            try {
                console.log('Initializing open interest profile...');
                state.openInterestProfile = window.openInterestProfileManager.initialize(state, {
                    ...commonConfig,
                    barWidth: 1.0,
                    showMedian: false // Disable POC for open interest profile
                });
            } catch (error) {
                console.warn("Failed to initialize open interest profile:", error);
            }
        }

        return state;
    };

    // Throttle function to limit update frequency
    const throttle = (fn, delay = 100) => {
        let lastCall = 0;
        let timeout = null;

        return function(...args) {
            const now = Date.now();

            if (now - lastCall < delay) {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    lastCall = now;
                    fn.apply(this, args);
                }, delay);
            } else {
                lastCall = now;
                fn.apply(this, args);
            }
        };
    };

    // Create throttled update functions
    const throttledUpdates = new Map();

    // Get a throttled version of an update function
    const getThrottledUpdate = (profile) => {
        if (!profile || typeof profile.update !== 'function') return null;

        // Create a unique key for this profile
        const key = profile.id || Math.random().toString(36).substring(2);

        if (!throttledUpdates.has(key)) {
            throttledUpdates.set(key, throttle(profile.update.bind(profile), 100));
        }

        return throttledUpdates.get(key);
    };

    // Update all profiles with throttling
    const updateAllProfiles = (state) => {
        if (!state) return;

        // Use requestAnimationFrame to batch visual updates
        requestAnimationFrame(() => {
            // Update volume profile
            if (state.volumeProfile) {
                const update = getThrottledUpdate(state.volumeProfile) || state.volumeProfile.update;
                update();
            }

            // Update funding profile
            if (state.fundingProfile) {
                const update = getThrottledUpdate(state.fundingProfile) || state.fundingProfile.update;
                update();
            }

            // Update open interest profile
            if (state.openInterestProfile) {
                const update = getThrottledUpdate(state.openInterestProfile) || state.openInterestProfile.update;
                update();
            }
        });
    };

    // Clean up all profiles
    const cleanupAllProfiles = (state) => {
        if (!state) return;

        // Clean up volume profile
        if (state.volumeProfile && typeof state.volumeProfile.cleanup === 'function') {
            state.volumeProfile.cleanup();
        }

        // Clean up funding profile
        if (state.fundingProfile && typeof state.fundingProfile.cleanup === 'function') {
            state.fundingProfile.cleanup();
        }

        // Clean up open interest profile
        if (state.openInterestProfile && typeof state.openInterestProfile.cleanup === 'function') {
            state.openInterestProfile.cleanup();
        }
    };

    // Handle chart switching
    const handleChartSwitch = (state) => {
        // First clean up existing profiles
        cleanupAllProfiles(state);

        // Then initialize new profiles
        initializeProfiles(state);
    };

    // Apply profile lines to all profiles
    const applyProfileLines = (lines) => {
        if (!lines || isNaN(parseInt(lines))) return;

        const lineCount = parseInt(lines);
        // No logging to keep console clean

        // Save to localStorage for persistence
        localStorage.setItem('volumeProfileLines', lineCount.toString());

        // Get all chart states
        const states = window.chartStates;
        if (!states) return;

        // Update all profiles for all chart states
        states.forEach((state) => {
            if (!state) return;

            // Update volume profile
            if (state.volumeProfile && state.volumeProfile.config) {
                state.volumeProfile.config.priceRange = lineCount;
                if (typeof state.volumeProfile.update === 'function') {
                    state.volumeProfile.update();
                }
            }

            // Update funding profile
            if (window.fundingProfileManager && window.fundingProfileManager.updatePriceRange) {
                // Use the updatePriceRange method if available
                window.fundingProfileManager.updatePriceRange(lineCount);
            } else if (state.fundingProfile && state.fundingProfile.config) {
                // Use direct update if updatePriceRange is not available
                state.fundingProfile.config.priceRange = lineCount;
                if (typeof state.fundingProfile.update === 'function') {
                    state.fundingProfile.update();
                }
            }

            // Update open interest profile
            if (state.openInterestProfile && state.openInterestProfile.config) {
                state.openInterestProfile.config.priceRange = lineCount;
                if (typeof state.openInterestProfile.update === 'function') {
                    state.openInterestProfile.update();
                }
            }
        });
    };

    return {
        initializeProfiles,
        updateAllProfiles,
        cleanupAllProfiles,
        handleChartSwitch,
        applyProfileLines
    };
})();

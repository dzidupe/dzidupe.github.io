// baseProfile.js - Shared base logic for profile modules (funding, volume, open interest, etc.)

class BaseProfile {
    constructor(chartState, config = {}) {
        this.defaultConfig = {
            maxBars: 6000,
            priceRange: 150,
            barWidth: 0.8,
            colors: {
                bullish: "rgba(192, 192, 192, 0.7)",
                bearish: "rgba(64, 64, 64, 0.7)",
                median: "rgba(255, 255, 255, 0.8)"
            },
            visible: true,
            liveUpdate: true
        };
        this.config = { ...this.defaultConfig, ...config };
        this.chartState = chartState;
        this.data = null;
        this.visible = true;
        this.lastCandleTime = Math.floor(Date.now() / 1000 / (chartState?.config?.barInterval || 300)) * (chartState?.config?.barInterval || 300);
        this.dataLoaded = false;
        this.initTime = Date.now();
    }

    // Merge config with defaults and localStorage if needed
    mergeConfig(customConfig = {}) {
        this.config = { ...this.defaultConfig, ...this.config, ...customConfig };
    }

    // Slice data to maxBars and return recent data
    getRecentData(dataArray) {
        if (!Array.isArray(dataArray)) return [];
        return dataArray.slice(-this.config.maxBars);
    }

    // Utility: Find min/max for a property in an array
    getMinMax(dataArray, prop) {
        if (!Array.isArray(dataArray) || !prop) return { min: 0, max: 1 };
        let min = Infinity, max = -Infinity;
        for (const item of dataArray) {
            if (item[prop] !== undefined && item[prop] !== null) {
                min = Math.min(min, item[prop]);
                max = Math.max(max, item[prop]);
            }
        }
        if (min === Infinity || max === -Infinity || min >= max) return { min: 0, max: 1 };
        return { min, max };
    }

    // Initialize profile (to be called by child)
    initialize(chartState, config = {}) {
        this.chartState = chartState;
        this.mergeConfig(config);
        this.dataLoaded = false;
        this.initTime = Date.now();
    }

    // Update profile (to be called by child)
    updateProfile() {
        // To be implemented by child class
        throw new Error("updateProfile() must be implemented by the profile subclass.");
    }

    // Utility: Pad min/max for visualization
    padRange(min, max, percent = 0.05) {
        const padding = (max - min) * percent;
        return { min: min - padding, max: max + padding };
    }

    // Utility: Set profile as visible/invisible
    setVisible(visible) {
        this.visible = !!visible;
    }

    // Utility: Mark data as loaded
    setDataLoaded(loaded = true) {
        this.dataLoaded = !!loaded;
    }
}

// Attach to window for browser use
window.BaseProfile = BaseProfile;

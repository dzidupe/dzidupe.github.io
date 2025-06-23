// mathUtils.js - Centralized math and statistical utilities

(function() {
    const mathUtils = {
        normalize: function(value, min, max, opts = { range: [-1, 1] }) {
            if (!isFinite(value) || !isFinite(min) || !isFinite(max)) return opts.range[0];
            if (min === max) {
                if (opts.range[0] === -1 && opts.range[1] === 1) return value > 0 ? 1 : (value < 0 ? -1 : 0);
                if (opts.range[0] === 0 && opts.range[1] === 1) return 0.5;
                return opts.range[0];
            }
            let normalized = (value - min) / (max - min);
            if (opts.range[0] === -1 && opts.range[1] === 1) {
                normalized = 2 * normalized - 1;
                return Math.max(Math.min(normalized, 1), -1);
            }
            return Math.max(Math.min(normalized, 1), 0);
        },

        computeRollingMinMax: function(data, windowSize, valueSelector = v => (typeof v === 'object' && v !== null && 'value' in v ? v.value : v)) {
            const minValues = [];
            const maxValues = [];
            for (let i = 0; i < data.length; i++) {
                const start = Math.max(0, i - windowSize + 1);
                const window = data.slice(start, i + 1).map(valueSelector);
                minValues[i] = Math.min(...window);
                maxValues[i] = Math.max(...window);
            }
            return { minValues, maxValues };
        },

        ema: function(data, period) {
            if (!Array.isArray(data) || data.length === 0 || period <= 1) return [];
            const k = 2 / (period + 1);
            let emaArr = [];
            let prev = data[0];
            emaArr[0] = prev;
            for (let i = 1; i < data.length; i++) {
                prev = data[i] * k + prev * (1 - k);
                emaArr[i] = prev;
            }
            return emaArr;
        },

        sma: function(data, period) {
            if (!Array.isArray(data) || data.length === 0 || period <= 1) return [];
            let smaArr = [];
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                sum += data[i];
                if (i >= period) sum -= data[i - period];
                smaArr[i] = i >= period - 1 ? sum / period : sum / (i + 1);
            }
            return smaArr;
        },

        stdev: function(data, period) {
            if (!Array.isArray(data) || data.length === 0 || period <= 1) return [];
            let stdevArr = [];
            for (let i = 0; i < data.length; i++) {
                const start = Math.max(0, i - period + 1);
                const window = data.slice(start, i + 1);
                const mean = window.reduce((a, b) => a + b, 0) / window.length;
                const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
                stdevArr[i] = Math.sqrt(variance);
            }
            return stdevArr;
        },

        clamp: function(value, min, max) {
            return Math.max(min, Math.min(max, value));
        },

        lerp: function(a, b, t) {
            return a + (b - a) * t;
        },

        arrayMinMax: function(arr, selector = v => v) {
            if (!Array.isArray(arr) || arr.length === 0) return { min: undefined, max: undefined };
            let min = selector(arr[0]);
            let max = selector(arr[0]);
            for (let i = 1; i < arr.length; i++) {
                const val = selector(arr[i]);
                if (val < min) min = val;
                if (val > max) max = val;
            }
            return { min, max };
        },

        weightedAverage: function(arr, valueSelector = v => v.value, weightSelector = v => 1) {
            let sum = 0, weightSum = 0;
            for (const item of arr) {
                const value = valueSelector(item);
                const weight = weightSelector(item);
                sum += value * weight;
                weightSum += weight;
            }
            return weightSum === 0 ? 0 : sum / weightSum;
        }
    };

    if (typeof window !== 'undefined') {
        window.mathUtils = mathUtils;
    }
})();

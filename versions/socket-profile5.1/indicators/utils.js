// utils.js
window.utils = {
    normalizeValue: function(value, min, max) {
        if (!isFinite(value) || !isFinite(min) || !isFinite(max)) return 0;
        if (min === max) return value > 0 ? 0.5 : (value < 0 ? -0.5 : 0);
        const normalized = 2 * (value - min) / (max - min) - 1;
        return Math.max(Math.min(normalized, 1), -1);
    },
    getIndicatorColor: function(normalizedValue) {
        if (normalizedValue > 0.5) return 'rgba(255, 0, 0, 0.4)';
        if (normalizedValue < -0.5) return 'rgba(0, 255, 255, 0.4)';
        return 'rgba(170, 170, 170, 0.8)';
    },
    formatLargeNumber: function(price) {
        if (Math.abs(price) >= 1000000) {
            return (price / 1000000).toFixed(1) + 'M';
        } else if (Math.abs(price) >= 1000) {
            return (price / 1000).toFixed(1) + 'K';
        }
        return price.toFixed(1);
    },
    ema: function(data, period) {
        if (!data.length) return [];
        const k = 2 / (period + 1);
        const result = [data[0]];
        for (let i = 1; i < data.length; i++) result.push(data[i] * k + result[i - 1] * (1 - k));
        return result;
    },
    stdev: function(data, period) {
        if (!data.length) return [];
        const r = new Array(data.length).fill(0);
        for (let i = period - 1; i < data.length; i++) {
            const s = data.slice(i - period + 1, i + 1);
            const m = s.reduce((a, b) => a + b) / period;
            r[i] = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / period);
        }
        return r;
    },
    initStdDevCache: function() {
        return { count: 0, mean: 0, m2: 0 };
    },
    updateStdDev: function(c, v) {
        c.count++;
        const d = v - c.mean;
        c.mean += d / c.count;
        const d2 = v - c.mean;
        c.m2 += d * d2;
        return c.count > 1 ? Math.sqrt(c.m2 / (c.count - 1)) : 0;
    },
    normalizeImbalance: function(value, min, max) {
        if (!isFinite(value) || !isFinite(min) || !isFinite(max)) return 0;
        if (Math.abs(max - min) < 0.001) return value > 0 ? 0.5 : (value < 0 ? -0.5 : 0);
        let normalizedValue = 2 * (value - min) / (max - min) - 1;
        normalizedValue = Math.max(Math.min(normalizedValue, 1), -1);
        if (Math.abs(normalizedValue) < 0.05 && normalizedValue !== 0) {
            normalizedValue = normalizedValue > 0 ? 0.05 : -0.05;
        }
        return normalizedValue;
    },
    calculateWanger: function(liqsVal, oiVal) {
        liqsVal = Math.max(Math.min(liqsVal, 1), -1);
        oiVal = Math.max(Math.min(oiVal, 1), -1);
        const liqsFactor = Math.abs(liqsVal) ** 2 * 0.3;
        const oiFactor = liqsVal >= 0 ? Math.max(oiVal, 0) : Math.max(-oiVal, 0);
        const adjustedOiFactor = oiFactor * 2;
        const intensity = liqsFactor * (1 + adjustedOiFactor);
        const result = Math.max(Math.min(intensity, 1), 0) * Math.sign(liqsVal);
        if (Math.abs(result) < 0.1 && result !== 0) return result * 1.5;
        return result;
    }
};
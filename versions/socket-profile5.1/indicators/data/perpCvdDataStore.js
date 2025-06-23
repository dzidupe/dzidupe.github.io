// socket-profile5.0/indicators/data/perpCvdDataStore.js
// Global PerpCVD data store with background updating and subscription API (classic script compatible)

const perpCvdListeners = [];
let perpCvdData = null;
let isPerpCVDUpdating = false;
let perpCvdUpdateInterval = 1000; // ms

// Unique config object to avoid redeclaration
const PERP_CVD_CONFIG = {
    volumeMAPeriod: 90,
    volumeAdjustment: {
        enabled: true,
        buyMultiplier: 1.0,
        sellMultiplier: 1.0,
        useWicks: true,
        useBodySize: true,
        useCloseRelative: true
    },
    renderOnCandleCloseOnly: true,
    normalizationBuffer: 0,
    minSmoothingPeriod: 5,
    maxSmoothingPeriod: 20,
    adaptiveSmoothingFactor: 0.5,
    volumeWeighting: {
        enabled: true,
        weightFactor: 0.5
    },
    lookbackPeriod: 1440
};

let perpCvdHistoricalData = [];
let perpCvdPendingUpdates = {
    lastBarTime: 0,
    lastCvdValue: 0,
    pendingValue: 0,
    pendingEmaValue: 0,
    hasUpdate: false,
    avgVolume: 0
};

// You must provide priceData from your app's data source
let perpCvdPriceData = []; // <-- You must update this externally for real data

window.setPerpCVDPriceData = function(newPriceData) {
    perpCvdPriceData = newPriceData || [];
};

function perpCvdCalculateAdjustedVolume(bar, prevBar) {
    if (!bar) return 0;
    const volume = (bar.volume !== undefined && !isNaN(bar.volume)) ? bar.volume : 0;
    if (volume === 0) return 0;
    let isBuyBar = true;
    if (PERP_CVD_CONFIG.volumeAdjustment.useCloseRelative && prevBar && prevBar.close !== undefined && !isNaN(prevBar.close)) {
        isBuyBar = bar.close >= prevBar.close;
    } else {
        isBuyBar = bar.close >= bar.open;
    }
    let adjustmentFactor = 1.0;
    if (PERP_CVD_CONFIG.volumeAdjustment.useBodySize) {
        const bodySize = Math.abs(bar.close - bar.open);
        const range = bar.high - bar.low;
        if (range > 0 && isFinite(bodySize) && isFinite(range)) {
            const bodySizePercent = bodySize / range;
            adjustmentFactor *= (0.7 + bodySizePercent * 0.6);
        }
    }
    if (PERP_CVD_CONFIG.volumeAdjustment.useWicks) {
        const totalRange = bar.high - bar.low;
        if (totalRange > 0 && isFinite(totalRange)) {
            const upperWick = bar.high - Math.max(bar.open, bar.close);
            const lowerWick = Math.min(bar.open, bar.close) - bar.low;
            if (isFinite(upperWick) && isFinite(lowerWick)) {
                if (isBuyBar) {
                    const lowerWickPercent = lowerWick / totalRange;
                    adjustmentFactor *= (1 + lowerWickPercent * 0.8);
                } else {
                    const upperWickPercent = upperWick / totalRange;
                    adjustmentFactor *= (1 + upperWickPercent * 0.8);
                }
            }
        }
    }
    adjustmentFactor = Math.max(0.5, Math.min(2.0, adjustmentFactor));
    return isBuyBar ? volume * adjustmentFactor * PERP_CVD_CONFIG.volumeAdjustment.buyMultiplier : -volume * adjustmentFactor * PERP_CVD_CONFIG.volumeAdjustment.sellMultiplier;
}

function perpCvdCalculateCVDData(priceData) {
    const cvdData = [];
    let cumulativeDelta = 0;
    for (let i = 0; i < priceData.length; i++) {
        const bar = priceData[i];
        const prevBar = i > 0 ? priceData[i-1] : null;
        if (!bar || !bar.time || (bar.volume === undefined)) continue;
        const barDelta = perpCvdCalculateAdjustedVolume(bar, prevBar);
        cumulativeDelta += barDelta;
        cvdData.push({ time: bar.time, value: cumulativeDelta });
    }
    return cvdData;
}

function perpCvdNormalize(value, min, max, opts) {
    opts = opts || { range: [-1, 1] };
    if (max === min) return 0;
    var a = opts.range[0], b = opts.range[1];
    return a + ((value - min) * (b - a)) / (max - min);
}

function perpCvdComputeRollingMinMax(data, window, accessor) {
    accessor = accessor || function(d) { return d.value; };
    const minValues = [];
    const maxValues = [];
    for (let i = 0; i < data.length; i++) {
        const start = Math.max(0, i - window + 1);
        const windowSlice = data.slice(start, i + 1).map(accessor);
        minValues.push(Math.min.apply(null, windowSlice));
        maxValues.push(Math.max.apply(null, windowSlice));
    }
    return { minValues: minValues, maxValues: maxValues };
}

function perpCvdGetLatestNormalized() {
    if (!perpCvdPriceData.length) return null;
    const cvdDataArr = perpCvdCalculateCVDData(perpCvdPriceData);
    perpCvdHistoricalData = cvdDataArr.slice();
    const minMax = perpCvdComputeRollingMinMax(cvdDataArr, PERP_CVD_CONFIG.lookbackPeriod, function(p) { return p.value; });
    const lastIdx = cvdDataArr.length - 1;
    if (lastIdx < 0) return null;
    const last = cvdDataArr[lastIdx];
    const min = minMax.minValues[lastIdx];
    const max = minMax.maxValues[lastIdx];
    const normalizedValue = perpCvdNormalize(last.value, min, max);
    return {
        time: last.time,
        value: normalizedValue
    };
}

function perpCvdFetchOrCalculate() {
    return perpCvdGetLatestNormalized();
}

function perpCvdUpdateData() {
    if (isPerpCVDUpdating) return;
    isPerpCVDUpdating = true;
    try {
        const newData = perpCvdFetchOrCalculate();
        perpCvdData = newData;
        perpCvdListeners.forEach(function(cb) {
            try { cb(perpCvdData); } catch (e) {}
        });
    } finally {
        isPerpCVDUpdating = false;
    }
}

setInterval(perpCvdUpdateData, perpCvdUpdateInterval);

window.subscribePerpCVD = function(cb) {
    if (typeof cb !== 'function') return function() {};
    perpCvdListeners.push(cb);
    if (perpCvdData !== null) cb(perpCvdData);
    return function() {
        const idx = perpCvdListeners.indexOf(cb);
        if (idx !== -1) perpCvdListeners.splice(idx, 1);
    };
};

window.getCurrentPerpCVD = function() {
    return perpCvdData;
};
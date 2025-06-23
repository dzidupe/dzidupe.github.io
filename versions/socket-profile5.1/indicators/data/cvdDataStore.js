// socket-profile5.0/indicators/data/cvdDataStore.js
// Global CVD data store with background updating and subscription API (classic script compatible)

const cvdListeners = [];
let cvdData = null;
let isCVDUpdating = false;
let cvdUpdateInterval = 1000; // ms

// Configuration (copy from cvd.js)
const CVD_CONFIG = {
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

// State
let historicalCVDData = [];
let pendingCVDUpdates = {
  lastBarTime: 0,
  lastCvdValue: 0,
  pendingValue: 0,
  pendingEmaValue: 0,
  hasUpdate: false,
  avgVolume: 0
};

// You must provide priceData from your app's data source
let cvdPriceData = []; // <-- You must update this externally for real data

window.setCVDPriceData = function(newPriceData) {
  cvdPriceData = newPriceData || [];
};

function calculateAdjustedVolume(bar, prevBar) {
  if (!bar) return 0;
  const volume = (bar.volume !== undefined && !isNaN(bar.volume)) ? bar.volume : 0;
  if (volume === 0) return 0;
  let isBuyBar = true;
  if (CVD_CONFIG.volumeAdjustment.useCloseRelative && prevBar && prevBar.close !== undefined && !isNaN(prevBar.close)) {
    isBuyBar = bar.close >= prevBar.close;
  } else {
    isBuyBar = bar.close >= bar.open;
  }
  let adjustmentFactor = 1.0;
  if (CVD_CONFIG.volumeAdjustment.useBodySize) {
    const bodySize = Math.abs(bar.close - bar.open);
    const range = bar.high - bar.low;
    if (range > 0 && isFinite(bodySize) && isFinite(range)) {
      const bodySizePercent = bodySize / range;
      adjustmentFactor *= (0.7 + bodySizePercent * 0.6);
    }
  }
  if (CVD_CONFIG.volumeAdjustment.useWicks) {
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
  return isBuyBar ? volume * adjustmentFactor * CVD_CONFIG.volumeAdjustment.buyMultiplier : -volume * adjustmentFactor * CVD_CONFIG.volumeAdjustment.sellMultiplier;
}

function calculateCVDData(priceData) {
  const cvdData = [];
  let cumulativeDelta = 0;
  for (let i = 0; i < priceData.length; i++) {
    const bar = priceData[i];
    const prevBar = i > 0 ? priceData[i-1] : null;
    if (!bar || !bar.time || (bar.volume === undefined)) continue;
    const barDelta = calculateAdjustedVolume(bar, prevBar);
    cumulativeDelta += barDelta;
    cvdData.push({ time: bar.time, value: cumulativeDelta });
  }
  return cvdData;
}

function normalizeCVD(value, min, max) {
  if (max === min) return 0;
  return ((value - min) / (max - min)) * 2 - 1;
}

function computeRollingMinMax(data, window, valueAccessor) {
  valueAccessor = valueAccessor || function(d) { return d.value; };
  const minValues = [];
  const maxValues = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - window + 1);
    let min = Infinity, max = -Infinity;
    for (let j = start; j <= i; j++) {
      const v = valueAccessor(data[j]);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    minValues.push(min);
    maxValues.push(max);
  }
  return { minValues, maxValues };
}

function getCVDColor(value) {
  return value >= 0 ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 255, 255, 0.8)';
}

function getLatestNormalizedCVD() {
  if (!cvdPriceData.length) return null;
  const cvdDataArr = calculateCVDData(cvdPriceData);
  historicalCVDData = cvdDataArr.slice();
  const { minValues, maxValues } = computeRollingMinMax(cvdDataArr, CVD_CONFIG.lookbackPeriod, function(p) { return p.value; });
  const lastIdx = cvdDataArr.length - 1;
  if (lastIdx < 0) return null;
  const last = cvdDataArr[lastIdx];
  const min = minValues[lastIdx];
  const max = maxValues[lastIdx];
  const normalizedValue = normalizeCVD(last.value, min, max);
  return {
    time: last.time,
    value: normalizedValue,
    color: getCVDColor(normalizedValue)
  };
}

function fetchOrCalculateCVD() {
  // You must update cvdPriceData externally for this to reflect new data!
  return getLatestNormalizedCVD();
}

function updateCVDData() {
  if (isCVDUpdating) return;
  isCVDUpdating = true;
  try {
    const newData = fetchOrCalculateCVD();
    cvdData = newData;
    cvdListeners.forEach(function(cb) {
      try { cb(cvdData); } catch (e) {}
    });
  } finally {
    isCVDUpdating = false;
  }
}

// Start background updater
setInterval(updateCVDData, cvdUpdateInterval);

// Subscription API
window.subscribeCVD = function(cb) {
  if (typeof cb !== 'function') return function() {};
  cvdListeners.push(cb);
  // Immediately send current data if available
  if (cvdData !== null) cb(cvdData);
  // Return unsubscribe function
  return function() {
    const idx = cvdListeners.indexOf(cb);
    if (idx !== -1) cvdListeners.splice(idx, 1);
  };
};

window.getCurrentCVD = function() {
  return cvdData;
};
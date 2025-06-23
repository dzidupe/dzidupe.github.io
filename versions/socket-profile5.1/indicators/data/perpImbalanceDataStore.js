// socket-profile5.0/indicators/data/perpImbalanceDataStore.js
// Global PerpImbalance data store with background updating and subscription API

const listeners = [];
let perpImbalanceData = null;
let isUpdating = false;
let updateInterval = 1000; // ms, adjust as needed

// --- Real PerpImbalance calculation logic ---
// You must provide spotData, futuresData, oiData from your data source
// Access normalizeImbalance and calculateWanger via window
let spotData = [];
let futuresData = [];
let oiData = [];

window.setPerpImbalanceSourceData = function({ spot, futures, oi }) {
  if (spot) spotData = spot;
  if (futures) futuresData = futures;
  if (oi) oiData = oi;
};

async function fetchOrCalculatePerpImbalance() {
  // Use the latest bar from each data source
  if (!spotData.length || !futuresData.length || !oiData.length) {
    return null;
  }
  const spotBar = spotData[spotData.length - 1];
  const futuresBar = futuresData[futuresData.length - 1];
  const oiBar = oiData[oiData.length - 1];

  // Calculate cumulative deltas
  const spotDelta = spotBar.volume * (spotBar.close - spotBar.open);
  const futuresDelta = futuresBar.volume * (futuresBar.close - futuresBar.open);

  // Maintain running CVDs
  if (!fetchOrCalculatePerpImbalance.spotCVD) fetchOrCalculatePerpImbalance.spotCVD = 0;
  if (!fetchOrCalculatePerpImbalance.futuresCVD) fetchOrCalculatePerpImbalance.futuresCVD = 0;
  fetchOrCalculatePerpImbalance.spotCVD += spotDelta;
  fetchOrCalculatePerpImbalance.futuresCVD += futuresDelta;

  const imbalanceValue = fetchOrCalculatePerpImbalance.futuresCVD - fetchOrCalculatePerpImbalance.spotCVD;
  const oiValue = oiBar.close;

  // Maintain history for normalization
  if (!fetchOrCalculatePerpImbalance.historicalImbalanceData) fetchOrCalculatePerpImbalance.historicalImbalanceData = [];
  if (!fetchOrCalculatePerpImbalance.historicalOIData) fetchOrCalculatePerpImbalance.historicalOIData = [];
  fetchOrCalculatePerpImbalance.historicalImbalanceData.push({ time: spotBar.time, value: imbalanceValue });
  fetchOrCalculatePerpImbalance.historicalOIData.push({ time: spotBar.time, value: oiValue });

  // Keep only the last N bars for normalization
  const lookbackPeriod = 1440;
  if (fetchOrCalculatePerpImbalance.historicalImbalanceData.length > lookbackPeriod)
    fetchOrCalculatePerpImbalance.historicalImbalanceData = fetchOrCalculatePerpImbalance.historicalImbalanceData.slice(-lookbackPeriod);
  if (fetchOrCalculatePerpImbalance.historicalOIData.length > lookbackPeriod)
    fetchOrCalculatePerpImbalance.historicalOIData = fetchOrCalculatePerpImbalance.historicalOIData.slice(-lookbackPeriod);

  // Normalize
  const lookbackData = fetchOrCalculatePerpImbalance.historicalImbalanceData;
  const oiLookbackData = fetchOrCalculatePerpImbalance.historicalOIData;
  const imbalanceMin = Math.min(...lookbackData.map(d => d.value));
  const imbalanceMax = Math.max(...lookbackData.map(d => d.value));
  const oiMin = Math.min(...oiLookbackData.map(d => d.value));
  const oiMax = Math.max(...oiLookbackData.map(d => d.value));
  const prevLiqs = window.normalizeImbalance(imbalanceValue, imbalanceMin, imbalanceMax);
  const prevOI = window.normalizeImbalance(oiValue, oiMin, oiMax);
  const wangerValue = window.calculateWanger(prevLiqs, prevOI);

  return {
    time: spotBar.time,
    value: wangerValue
  };
}

async function updatePerpImbalanceData() {
  if (isUpdating) return;
  isUpdating = true;
  try {
    const newData = await fetchOrCalculatePerpImbalance();
    perpImbalanceData = newData;
    listeners.forEach(cb => {
      try { cb(perpImbalanceData); } catch (e) { /* ignore listener errors */ }
    });
  } finally {
    isUpdating = false;
  }
}

// Start background updater
setInterval(updatePerpImbalanceData, updateInterval);

// Subscription API
window.subscribePerpImbalance = function(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.push(cb);
  // Immediately send current data if available
  if (perpImbalanceData !== null) cb(perpImbalanceData);
  // Return unsubscribe function
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
};

window.getCurrentPerpImbalance = function() {
  return perpImbalanceData;
};
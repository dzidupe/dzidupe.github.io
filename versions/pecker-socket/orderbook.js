// Utility Functions
const debounce = (func, wait, immediate = false) => {
  let timeout;
  return (...args) => {
    const context = this;
    const later = () => {
      timeout = null;
      if (!immediate) func.apply(context, args);
    };
    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func.apply(context, args);
  };
};

const throttle = (func, limit) => {
  let inThrottle;
  let lastFunc;
  let lastRan;

  const wrapper = function () {
    const context = this;
    const args = arguments;

    if (!inThrottle) {
      func.apply(context, args);
      lastRan = Date.now();
      inThrottle = true;
    } else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(function () {
        if (Date.now() - lastRan >= limit) {
          func.apply(context, args);
          lastRan = Date.now();
        }
      }, limit - (Date.now() - lastRan));
    }
  };

  wrapper.cancel = function () {
    clearTimeout(lastFunc);
    inThrottle = false;
  };

  return wrapper;
};

const getLargestBlock = (orders) =>
  orders.length === 0
    ? null
    : orders.reduce((max, [price, volume]) => {
        const dollarValue = price * volume;
        return dollarValue > (max?.dollarValue || -Infinity)
          ? { price, volume, dollarValue }
          : max;
      }, null);

const hashOrderBook = (orderBookData, lastPrice) =>
  `${orderBookData.bids.slice(0, 5).join("|")}-${orderBookData.asks
    .slice(0, 5)
    .join("|")}-${lastPrice || "unloaded"}`;

const animateBar = (
  ctx,
  currentWidth,
  targetWidth,
  value,
  min,
  max,
  width,
  height,
  callback
) => {
  if (Math.abs(targetWidth - currentWidth) < 0.5) {
    if (targetWidth !== currentWidth) {
      drawMeter(ctx, targetWidth, value, min, max, width, height);
      callback(targetWidth);
    }
    return;
  }
  const startTime = performance.now();
  const startWidth = currentWidth;
  const duration = 15;
  const step = (timestamp) => {
    const progress = Math.min((timestamp - startTime) / duration, 1);
    const newWidth = startWidth + (targetWidth - startWidth) * progress;
    drawMeter(ctx, newWidth, value, min, max, width, height);
    if (progress < 1) requestAnimationFrame(step);
    else callback(newWidth);
  };
  requestAnimationFrame(step);
};

const drawMeter = (ctx, barWidth, value, min, max, width, height) => {
  const dpr = window.devicePixelRatio || 1;
  const scaledWidth = width / dpr,
    scaledHeight = height / dpr;
  ctx.clearRect(0, 0, scaledWidth, scaledHeight);

  ctx.fillStyle = "rgba(40, 40, 40, 0.5)";
  ctx.fillRect(0, 0, scaledWidth, scaledHeight);

  const barHeight = scaledHeight;
  const y = 0;
  const centerX = scaledWidth / 2;

  ctx.fillStyle = "rgba(150, 150, 150, 0.5)";
  ctx.fillRect(centerX - 1, y, 2, barHeight);

  // Reduce color intensity by 25%
  ctx.fillStyle = value >= 0 ? "rgba(0, 255, 255, 0.525)" : "rgba(255, 85, 85, 0.525)";
  const totalBarWidth = Math.abs(barWidth);
  const minVisibleWidth = 2;
  const displayWidth =
    value !== 0 && totalBarWidth < minVisibleWidth ? minVisibleWidth : totalBarWidth;

  ctx.fillRect(
    Math.floor(value >= 0 ? centerX : centerX - displayWidth),
    y,
    Math.ceil(displayWidth),
    barHeight
  );
};

const setTextIfChanged = (element, text) => {
  if (!element) return;
  if (element.textContent !== text) {
    element.textContent = text;
  }
};

const orderBookEventBus = {
  events: {},
  subscribe: (event, callback) => {
    orderBookEventBus.events[event] = orderBookEventBus.events[event] || [];
    orderBookEventBus.events[event].push(callback);
    return () =>
      (orderBookEventBus.events[event] = orderBookEventBus.events[event].filter(
        (cb) => cb !== callback
      ));
  },
  publish: (event, data) =>
    orderBookEventBus.events[event]?.forEach((callback) => callback(data)),
};

const eventBus = orderBookEventBus;

const isElementInViewport = (el) => {
  if (!el) return false;
  const { top, left, height, width } = el.getBoundingClientRect();
  const viewportHeight = window.innerHeight,
    viewportWidth = window.innerWidth;
  return (
    top <= viewportHeight &&
    top + height >= 0 &&
    left <= viewportWidth &&
    left + width >= 0
  );
};

const formatNumber = (num) => {
  if (!isFinite(num) || isNaN(num)) return "0";
  if (Math.abs(num) < 0.01) return num.toFixed(4);
  if (Math.abs(num) < 1) return num.toFixed(2);
  if (Math.abs(num) < 1000) return num.toFixed(1);
  return Math.round(num).toLocaleString();
};

const createCryptoModule = (symbol, config, elements) => {
  const lowerSymbol = symbol.toLowerCase();

  if (!elements.container || !elements.orderbookCanvas) {
    console.error(`Cannot create crypto module for ${symbol}: missing required elements`);
    return null;
  }

  const safeElements = {
    ...elements,
    spotPressureCanvas: elements.spotPressureCanvas || null,
    spotPressureValue: elements.spotPressureValue || null,
    perpPressureCvdCanvas: elements.perpPressureCvdCanvas || null,
    perpPressureValue: elements.perpPressureValue || null,
    oiCanvas: elements.oiCanvas || null,
    oiValue: elements.oiValue || null,
    liqCanvas: elements.liqCanvas || null,
    liqValue: elements.liqValue || null,
  };

  const { bitstampOrderBook, bitstampTrades, bybitTrade, bybitLiq, binanceOi } =
    config.ticker;
  const state = {
    orderBookData: { bids: [], asks: [] },
    lastPrice: null,
    lastPriceUpdateTime: Date.now(),
    cumulatives: { spotPressure: 0, perpPressure: 0, oi: 0, liq: 0 },
    ranges: {
      spotPressure: { min: -1, max: 1 },
      perpPressure: { min: -1, max: 1 },
      oi: { min: -1, max: 1 },
      liq: { min: -1, max: 1 },
    },
    persistentBlocks: { lowestBid: null, highestAsk: null },
    barWidths: { spotPressure: 0, perpPressure: 0, oi: 0, liq: 0 },
    prevTargets: { spotPressure: 0, perpPressure: 0, oi: 0, liq: 0 },
    lastOrderBookHash: 0,
    cachedDisplay: { bids: null, asks: null },
    lastFilterPrice: null,
    lastOiValue: null,
    isBitstampReady: false,
    isBybitReady: false,
    needsUpdate: false,
    lastFullDrawTime: 0,
    consecutiveHighLoadFrames: 0,
    alternateUpdates: true,
  };

  const contexts = {
    orderbook: safeElements.orderbookCanvas.getContext("2d"),
    spotPressure: safeElements.spotPressureCanvas
      ? safeElements.spotPressureCanvas.getContext("2d")
      : null,
    perpPressure: safeElements.perpPressureCvdCanvas
      ? safeElements.perpPressureCvdCanvas.getContext("2d")
      : null,
    oi: safeElements.oiCanvas ? safeElements.oiCanvas.getContext("2d") : null,
    liq: safeElements.liqCanvas ? safeElements.liqCanvas.getContext("2d") : null,
  };

  const updateTickerName = () =>
    (safeElements.tickerName.textContent = `${symbol} Δ: `);
  updateTickerName();

  const updateOrderBookExtremes = () => {
    if (!state.lastPrice) return;
    
    // Filter bids below or equal to last price and asks above or equal to last price
    const bidsBelow = state.orderBookData.bids.filter(
      ([price]) => price <= state.lastPrice
    );
    const asksAbove = state.orderBookData.asks.filter(
      ([price]) => price >= state.lastPrice
    );
    
    // Find the largest blocks by dollar value
    const largestBid = getLargestBlock(bidsBelow);
    const largestAsk = getLargestBlock(asksAbove);
    
    // Reset persistent blocks if we have no valid bids/asks
    if (!bidsBelow.length) {
      state.persistentBlocks.lowestBid = null;
    } else if (largestBid) {
      // Update the lowest bid if:
      // 1. We don't have a lowest bid yet, OR
      // 2. This bid is lower than our current lowest
      if (
        state.persistentBlocks.lowestBid === null ||
        largestBid.price < state.persistentBlocks.lowestBid
      ) {
        state.persistentBlocks.lowestBid = largestBid.price;
      }
    }
    
    // Reset persistent blocks if we have no valid asks
    if (!asksAbove.length) {
      state.persistentBlocks.highestAsk = null;
    } else if (largestAsk) {
      // Update the highest ask if:
      // 1. We don't have a highest ask yet, OR
      // 2. This ask is higher than our current highest
      if (
        state.persistentBlocks.highestAsk === null ||
        largestAsk.price > state.persistentBlocks.highestAsk
      ) {
        state.persistentBlocks.highestAsk = largestAsk.price;
      }
    }
    
    // Optional: Add a reset mechanism if needed
    // This would reset the extremes after a certain time period
    // or when the price moves significantly
    
    // Example: Reset if price moves more than 1%
    if (state.persistentBlocks.lastResetPrice) {
      const priceChange = Math.abs(state.lastPrice - state.persistentBlocks.lastResetPrice) / state.persistentBlocks.lastResetPrice;
      if (priceChange > 0.01) {
        state.persistentBlocks.lowestBid = largestBid ? largestBid.price : null;
        state.persistentBlocks.highestAsk = largestAsk ? largestAsk.price : null;
        state.persistentBlocks.lastResetPrice = state.lastPrice;
      }
    } else {
      state.persistentBlocks.lastResetPrice = state.lastPrice;
    }
  };

  const drawOrderBookBars = () => {
    const currentHash = hashOrderBook(state.orderBookData, state.lastPrice);
    if (currentHash === state.lastOrderBookHash && !window._isResizing) return;
    state.lastOrderBookHash = currentHash;
    if (!isElementInViewport(safeElements.orderbookCanvas)) return;

    const ctx = contexts.orderbook,
      dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, safeElements.orderbookCanvas.width / dpr, safeElements.orderbookCanvas.height / dpr);
    if (!state.lastPrice) {
      const safeElementsList = ["minPrice", "maxPrice", "midPrice"];
      safeElementsList.forEach((id) => {
        if (safeElements[id]) setTextIfChanged(safeElements[id], "Loading...");
      });

      const emptyElements = ["lowestPrice", "highestPrice", "balancePercent"];
      emptyElements.forEach((id) => {
        if (safeElements[id]) setTextIfChanged(safeElements[id], "");
      });
      return;
    }

    const rangeSize = state.lastPrice * 0.01,
      minPrice = state.lastPrice - rangeSize,
      maxPrice = state.lastPrice + rangeSize;
    const biasBids = state.orderBookData.bids.filter(
      ([price]) => price >= state.lastPrice * 0.95 && price <= state.lastPrice
    );
    const biasAsks = state.orderBookData.asks.filter(
      ([price]) => price >= state.lastPrice && price <= state.lastPrice * 1.05
    );
    const totalValue =
      biasBids.reduce((sum, [p, v]) => sum + p * v, 0) +
      biasAsks.reduce((sum, [p, v]) => sum + p * v, 0);
    const balancePercent = totalValue
      ? ((biasBids.reduce((sum, [p, v]) => sum + p * v, 0) -
          biasAsks.reduce((sum, [p, v]) => sum + p * v, 0)) /
          totalValue) *
        100
      : 0;
    const largestBid = getLargestBlock(state.orderBookData.bids),
      largestAsk = getLargestBlock(state.orderBookData.asks);

    ctx.strokeStyle = "#1c2526";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(safeElements.orderbookCanvas.width / 2, 0);
    ctx.lineTo(safeElements.orderbookCanvas.width / 2, safeElements.orderbookCanvas.height);
    ctx.stroke();

    const dynamicColor = balancePercent >= 0 ? "rgba(0, 255, 255, 0.75)" : "rgba(255, 85, 85, 0.75)";
    safeElements.tickerName.style.color = dynamicColor;
    setTextIfChanged(safeElements.balancePercent, `${Math.round(balancePercent)}%`);
    safeElements.balancePercent.style.color = dynamicColor;
    safeElements.midPrice.parentElement.style.color = "#BBBBBB";

    if (state.lastFilterPrice !== state.lastPrice) {
      state.cachedDisplay.bids = state.orderBookData.bids
        .filter(([price]) => price >= minPrice && price <= state.lastPrice)
        .sort((a, b) => b[0] - a[0]);
      state.cachedDisplay.asks = state.orderBookData.asks
        .filter(([price]) => price >= state.lastPrice && price <= maxPrice)
        .sort((a, b) => a[0] - b[0]);
      state.lastFilterPrice = state.lastPrice;
    }

    const baseline = safeElements.orderbookCanvas.height / dpr;
    const viewFieldDollarSum =
      [...state.cachedDisplay.bids, ...state.cachedDisplay.asks].reduce(
        (sum, [p, v]) => sum + p * v,
        0
      ) || 1;
    let cumulativeBidHeight = 0,
      cumulativeAskHeight = 0;

    state.cachedDisplay.bids.forEach(([price, volume]) => {
      const x =
        ((price - minPrice) / (maxPrice - minPrice)) * (safeElements.orderbookCanvas.width / dpr);
      const normalizedHeight =
        (price * volume / viewFieldDollarSum) * (safeElements.orderbookCanvas.height / dpr);
      cumulativeBidHeight += normalizedHeight;
      ctx.fillStyle = "rgba(170, 170, 170, 0.6)"; // Reduced intensity
      ctx.fillRect(
        x - config.orderbook.barWidth / 2,
        baseline - cumulativeBidHeight,
        config.orderbook.barWidth,
        cumulativeBidHeight
      );
    });

    state.cachedDisplay.asks.forEach(([price, volume]) => {
      const x =
        ((price - minPrice) / (maxPrice - minPrice)) * (safeElements.orderbookCanvas.width / dpr);
      const normalizedHeight =
        (price * volume / viewFieldDollarSum) * (safeElements.orderbookCanvas.height / dpr);
      cumulativeAskHeight += normalizedHeight;
      ctx.fillStyle = "rgba(170, 170, 170, 0.6)"; // Reduced intensity
      ctx.fillRect(
        x - config.orderbook.barWidth / 2,
        baseline - cumulativeAskHeight,
        config.orderbook.barWidth,
        cumulativeAskHeight
      );
    });

    setTextIfChanged(
      safeElements.minPrice,
      `$${largestBid ? largestBid.price.toFixed(2) : state.lastPrice.toFixed(2)}`
    );
    setTextIfChanged(
      safeElements.lowestPrice,
      state.persistentBlocks.lowestBid
        ? `($${state.persistentBlocks.lowestBid.toFixed(2)})`
        : ""
    );
    setTextIfChanged(safeElements.midPrice, `$${state.lastPrice.toFixed(2)}`);
    setTextIfChanged(
      safeElements.maxPrice,
      `$${largestAsk ? largestAsk.price.toFixed(2) : state.lastPrice.toFixed(2)}`
    );
    setTextIfChanged(
      safeElements.highestPrice,
      state.persistentBlocks.highestAsk
        ? `($${state.persistentBlocks.highestAsk.toFixed(2)})`
        : ""
    );
  };

  const updateMeters = () => {
    const dpr = window.devicePixelRatio || 1;
    const values = state.cumulatives,
      ranges = state.ranges;

    setTextIfChanged(safeElements.spotPressureValue, formatNumber(values.spotPressure));
    setTextIfChanged(safeElements.perpPressureValue, formatNumber(values.perpPressure));
    setTextIfChanged(safeElements.oiValue, formatNumber(values.oi));
    setTextIfChanged(safeElements.liqValue, formatNumber(values.liq));

    const calculateTarget = (value, min, max, canvasWidth) => {
      if (min === -1 && max === 1 && value === 0) return 0;
      const range = max - min;
      const normalized = (value - min) / range;
      const halfWidth = canvasWidth / dpr / 2;
      return Math.min(Math.max(normalized * canvasWidth - halfWidth, -halfWidth), halfWidth);
    };

    const targets = {};
    const updateTarget = (key, canvas) => {
      const newTarget = calculateTarget(values[key], ranges[key].min, ranges[key].max, canvas.width);
      if (Math.abs(newTarget - state.prevTargets[key]) > 0.5) {
        targets[key] = newTarget;
        state.prevTargets[key] = newTarget;
      } else {
        targets[key] = state.prevTargets[key];
      }
    };

    updateTarget("spotPressure", safeElements.spotPressureCanvas);
    updateTarget("perpPressure", safeElements.perpPressureCvdCanvas);
    updateTarget("oi", safeElements.oiCanvas);
    updateTarget("liq", safeElements.liqCanvas);

    const drawOrAnimate = (ctx, key, canvas) => {
      if (window._isResizing) {
        if (ctx)
          drawMeter(ctx, targets[key], values[key], ranges[key].min, ranges[key].max, canvas.width, canvas.height);
        state.barWidths[key] = targets[key];
      } else if (ctx) {
        animateBar(
          ctx,
          state.barWidths[key] || 0,
          targets[key],
          values[key],
          ranges[key].min,
          ranges[key].max,
          canvas.width,
          canvas.height,
          (w) => (state.barWidths[key] = w)
        );
      }
    };

    drawOrAnimate(contexts.spotPressure, "spotPressure", safeElements.spotPressureCanvas);
    drawOrAnimate(contexts.perpPressure, "perpPressure", safeElements.perpPressureCvdCanvas);
    drawOrAnimate(contexts.oi, "oi", safeElements.oiCanvas);
    drawOrAnimate(contexts.liq, "liq", safeElements.liqCanvas);
  };

  const updateAllVisuals = () => {
    if (!state.needsUpdate) return;
    state.needsUpdate = false;

    // Use separate animation frames for heavy operations
    requestAnimationFrame(() => {
      try {
        // Check if element is visible before doing any work
        if (!isElementInViewport(safeElements.orderbookCanvas)) return;
        
        // Track performance
        const startTime = performance.now();
        
        // Only draw orderbook if it's been more than 100ms since last full draw
        // or if we're not in a high-load situation
        const now = Date.now();
        const timeSinceLastFullDraw = now - (state.lastFullDrawTime || 0);
        const isHighLoad = state.consecutiveHighLoadFrames > 3;
        
        // Throttle updates based on visibility and performance
        if (document.hidden || !document.hasFocus()) {
          // Reduce updates when tab is not visible or focused
          if (timeSinceLastFullDraw < 500) return;
        }
        
        // Use a more aggressive throttling strategy during high load
        if (isHighLoad) {
          // During high load, only update every 150ms
          if (timeSinceLastFullDraw < 150) return;
          
          // Split work between frames - only do one major operation per frame
          if (state.alternateUpdates) {
            drawOrderBookBars();
          } else if (isElementInViewport(safeElements.spotPressureCanvas)) {
            updateMeters();
          }
          state.alternateUpdates = !state.alternateUpdates;
        } else {
          // Normal load - do full updates but still stagger them
          drawOrderBookBars();
          state.lastFullDrawTime = now;
          
          // Schedule meter updates in next frame to distribute load
          if (isElementInViewport(safeElements.spotPressureCanvas)) {
            // Use setTimeout with 0ms to yield to browser between heavy operations
            setTimeout(() => {
              requestAnimationFrame(() => {
                updateMeters();
              });
            }, 0);
          }
        }
        
        // Track frame execution time to detect high load
        const frameTime = performance.now() - startTime;
        if (frameTime > 16) { // 16ms = 60fps threshold
          state.consecutiveHighLoadFrames = (state.consecutiveHighLoadFrames || 0) + 1;
          // Exponential backoff for very high load situations
          if (state.consecutiveHighLoadFrames > 10) {
            state.highLoadBackoffTime = Math.min(500, (state.highLoadBackoffTime || 100) * 1.2);
          }
        } else {
          state.consecutiveHighLoadFrames = Math.max(0, (state.consecutiveHighLoadFrames || 0) - 1);
          // Gradually reduce backoff time when performance improves
          if (state.highLoadBackoffTime && state.consecutiveHighLoadFrames < 5) {
            state.highLoadBackoffTime = Math.max(0, (state.highLoadBackoffTime * 0.9) - 10);
          }
        }
      } catch (error) {
        console.error(`Error updating visuals for ${symbol}:`, error);
      }
    });
  };
  const throttledUpdateAllVisuals = throttle(updateAllVisuals, 100);

  const updatePressure = (type, price, volume, key) => {
    if (state.orderBookData.bids.length && state.orderBookData.asks.length) {
      const bestBid = state.orderBookData.bids[0][0];
      const bestAsk = state.orderBookData.asks[0][0];
      const midPrice = (bestBid + bestAsk) / 2;
      const volumeMultiplier = 2; // Changed from conditional 5 or 3 to fixed 2
      const adjustedVolume = volume * volumeMultiplier;
      const signedVolume = type === 0 ? adjustedVolume : -adjustedVolume;
      const deviation = Math.abs(price - midPrice) / midPrice;
      const deviationWeight = config.deviationWeight || 2.0;
      const impact = signedVolume * (1 + deviationWeight * deviation);

      if (isFinite(impact)) {
        state.cumulatives[key] += impact;
        const absValue = Math.abs(state.cumulatives[key]);
        const currentMax = Math.max(absValue, state.ranges[key].max);
        state.ranges[key].min = Math.min(state.ranges[key].min, -currentMax);
        state.ranges[key].max = Math.max(state.ranges[key].max, currentMax);
        state.needsUpdate = true;
        throttledUpdateAllVisuals();
      }

      if (!isFinite(state.cumulatives[key])) state.cumulatives[key] = 0;
      if (!isFinite(state.ranges[key].min)) state.ranges[key].min = -1;
      if (!isFinite(state.ranges[key].max)) state.ranges[key].max = 1;
    }
  };

  const updateOi = (value) => {
    if (state.lastOiValue !== null) {
      state.cumulatives.oi += value - state.lastOiValue;
      const absValue = Math.abs(state.cumulatives.oi);
      const currentMax = Math.max(absValue, state.ranges.oi.max);
      state.ranges.oi.min = Math.min(state.ranges.oi.min, -currentMax);
      state.ranges.oi.max = Math.max(state.ranges.oi.max, currentMax);
    }
    state.lastOiValue = value;
    state.needsUpdate = true;
    throttledUpdateAllVisuals();
  };

  const updateLiq = (value, side) => {
    const liqMultiplier = 10;
    const adjustedValue = value * liqMultiplier;
    state.cumulatives.liq += side === "Buy" ? adjustedValue : -adjustedValue;
    const absValue = Math.abs(state.cumulatives.liq);
    const currentMax = Math.max(absValue, state.ranges.liq.max);
    state.ranges.liq.min = Math.min(state.ranges.liq.min, -currentMax);
    state.ranges.liq.max = Math.max(state.ranges.liq.max, currentMax);
    state.needsUpdate = true;
    throttledUpdateAllVisuals();
  };

  const fetchBinanceOpenInterest = async () => {
    try {
      const response = await fetch(`${config.urls.binanceOiBase}${binanceOi}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { openInterest } = await response.json();
      if (Number.isFinite(+openInterest)) updateOi(+openInterest);
    } catch (error) {
      console.error(`Binance OI fetch error (${symbol}):`, error);
    }
  };

  const applyDecay = () => {
    const DECAY_FACTOR = 0.999;
    state.cumulatives.spotPressure *= DECAY_FACTOR;
    state.cumulatives.perpPressure *= DECAY_FACTOR;
    state.cumulatives.oi *= DECAY_FACTOR;
    state.cumulatives.liq *= DECAY_FACTOR;

    ["spotPressure", "perpPressure", "oi", "liq"].forEach((key) => {
      const absValue = Math.abs(state.cumulatives[key]);
      state.ranges[key].min = Math.max(state.ranges[key].min * DECAY_FACTOR, -absValue - 1);
      state.ranges[key].max = Math.min(state.ranges[key].max * DECAY_FACTOR, absValue + 1);
    });
    state.needsUpdate = true;
    throttledUpdateAllVisuals();
  };

  const updateCanvasSize = () => {
    if (!safeElements.container.offsetParent) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(safeElements.container.clientWidth * 0.98);
    const height = safeElements.container.clientHeight;

    const canvases = [
      { el: safeElements.orderbookCanvas, h: height * 0.35, prevWidth: 0, prevHeight: 0 },
      { el: safeElements.spotPressureCanvas, h: height * 0.28, prevWidth: 0, prevHeight: 0 },
      {
        el: safeElements.perpPressureCvdCanvas,
        h: height * 0.28,
        prevWidth: 0,
        prevHeight: 0,
      },
      { el: safeElements.oiCanvas, h: height * 0.28, prevWidth: 0, prevHeight: 0 },
      { el: safeElements.liqCanvas, h: height * 0.28, prevWidth: 0, prevHeight: 0 },
    ];

    const needsRedraw = canvases.some((canvas) => {
      const newWidth = width * dpr;
      const newHeight = canvas.h * dpr;
      return (
        Math.abs(newWidth - canvas.prevWidth) > 1 ||
        Math.abs(newHeight - canvas.prevHeight) > 1
      );
    });

    if (!needsRedraw) return;

    const cachedWidths = { ...state.barWidths };
    requestAnimationFrame(() => {
      canvases.forEach((canvas) => {
        if (!canvas.el) return;
        const newWidth = width * dpr;
        const newHeight = canvas.h * dpr;
        canvas.el.width = newWidth;
        canvas.el.height = newHeight;
        canvas.el.style.width = `${width}px`;
        canvas.el.style.height = `${canvas.h}px`;
        canvas.prevWidth = newWidth;
        canvas.prevHeight = newHeight;
        const ctx = canvas.el.getContext("2d");
        if (dpr !== 1) ctx.scale(dpr, dpr);
      });

      state.barWidths = cachedWidths;
      window._isResizing = true;
      updateMeters();
      window._isResizing = false;
      updateAllVisuals();
    });
  };

  const checkReadyState = () => {
    if (state.isBitstampReady) {
      safeElements.loadingOverlay.style.opacity = "0";
      safeElements.loadingOverlay.style.pointerEvents = "none";
      updateCanvasSize();
      updateOrderBookExtremes();
      updateAllVisuals();
    } else {
      safeElements.loadingOverlay.style.opacity = "1";
      safeElements.loadingOverlay.style.pointerEvents = "auto";
      setTimeout(() => {
        if (!state.isBitstampReady && !state.isBybitReady)
          window.orderBooksBitstampWsManager.connect();
      }, 10000);
    }
  };

  const ensureBybitConnection = () => {
    if (!window.orderBooksBybitWsManager) {
      window.orderBooksBybitWsManager = new WebSocketManager(
        "wss://stream.bybit.com/v5/public/linear",
        "bybit",
        { 
          reconnectDelay: 3000, 
          maxReconnectAttempts: 30, 
          pingInterval: 5000,
          name: "orderbook-bybit"
        }
      );
    }
    
    if (
      !window.orderBooksBybitWsManager.connected ||
      window.orderBooksBybitWsManager.ws?.readyState !== WebSocket.OPEN
    ) {
      window.orderBooksBybitWsManager.connect();
      
      // Add a periodic check for Bybit connection
      if (!window.bybitConnectionCheckInterval) {
        window.bybitConnectionCheckInterval = setInterval(() => {
          if (
            !window.orderBooksBybitWsManager.connected ||
            window.orderBooksBybitWsManager.ws?.readyState !== WebSocket.OPEN
          ) {
            window.orderBooksBybitWsManager.reconnect(true);
          }
        }, 30000); // Check every 30 seconds
      }
    }
  };

  window.orderBooksBitstampWsManager.subscribe(bitstampOrderBook, (data) => {
    try {
      if (data.event === "data" && data.channel === bitstampOrderBook) {
        state.orderBookData = {
          bids: data.data.bids.map(([p, v]) => [parseFloat(p), parseFloat(v)]),
          asks: data.data.asks.map(([p, v]) => [parseFloat(p), parseFloat(v)]),
        };
        if (
          state.orderBookData.bids.length &&
          state.orderBookData.asks.length &&
          Date.now() - state.lastPriceUpdateTime > 2000
        ) {
          state.lastPrice = (state.orderBookData.bids[0][0] + state.orderBookData.asks[0][0]) / 2;
          state.lastPriceUpdateTime = Date.now();
          setTextIfChanged(safeElements.midPrice, state.lastPrice.toFixed(2));
        }
        state.needsUpdate = true;
        throttledUpdateAllVisuals();
      }
    } catch (error) {
      console.error(`Bitstamp orderbook WS error (${symbol}):`, error);
      setTimeout(() => window.orderBooksBitstampWsManager.connect(), 5000);
    }
  });

  window.orderBooksBitstampWsManager.subscribe(bitstampTrades, (data) => {
    try {
      if (data.event === "trade" && data.channel === bitstampTrades) {
        const price = parseFloat(data.data.price),
          volume = parseFloat(data.data.amount),
          type = data.data.type;

        if (Number.isFinite(price) && Number.isFinite(volume) && type !== undefined) {
          state.lastPrice = price;
          state.lastPriceUpdateTime = Date.now();
          setTextIfChanged(safeElements.midPrice, price.toFixed(2));
          updatePressure(type, price, volume, "spotPressure");
          updateOrderBookExtremes();
        }
      }
    } catch (error) {
      console.error(`Bitstamp trades WS error (${symbol}):`, error);
      setTimeout(() => window.orderBooksBitstampWsManager.connect(), 5000);
    }
  });

  ensureBybitConnection();
  window.orderBooksBybitWsManager.subscribe(bybitTrade, (data) => {
    try {
      if (data.topic === bybitTrade && data.data?.length) {
        const { p: price, v: volume, S: side } = data.data[0];
        if (Number.isFinite(+price) && Number.isFinite(+volume)) {
          updatePressure(side === "Buy" ? 0 : 1, +price, +volume, "perpPressure");
        }
      }
    } catch (error) {
      console.error(`Bybit trade WS error (${symbol}):`, error);
      setTimeout(() => window.orderBooksBybitWsManager.connect(), 5000);
    }
  });

  window.orderBooksBybitWsManager.subscribe(bybitLiq, (data) => {
    try {
      if (data.topic === bybitLiq && data.data) {
        const value = parseFloat(data.data.size || data.data.qty || 0),
          side = data.data.side;
        if (Number.isFinite(value) && side) {
          updateLiq(value, side);
        }
      }
    } catch (error) {
      console.error(`Bybit liq WS error (${symbol}):`, error);
      setTimeout(() => window.orderBooksBybitWsManager.connect(), 5000);
    }
  });

  updateCanvasSize();
  const initializeMeters = () => {
    if (contexts.liq) {
      drawMeter(
        contexts.liq,
        state.barWidths.liq,
        state.cumulatives.liq,
        state.ranges.liq.min,
        state.ranges.liq.max,
        safeElements.liqCanvas.width,
        safeElements.liqCanvas.height
      );
    }
    if (contexts.spotPressure) {
      drawMeter(
        contexts.spotPressure,
        state.barWidths.spotPressure,
        state.cumulatives.spotPressure,
        state.ranges.spotPressure.min,
        state.ranges.spotPressure.max,
        safeElements.spotPressureCanvas.width,
        safeElements.spotPressureCanvas.height
      );
    }
    if (contexts.perpPressure) {
      drawMeter(
        contexts.perpPressure,
        state.barWidths.perpPressure,
        state.cumulatives.perpPressure,
        state.ranges.perpPressure.min,
        state.ranges.perpPressure.max,
        safeElements.perpPressureCvdCanvas.width,
        safeElements.perpPressureCvdCanvas.height
      );
    }
    if (contexts.oi) {
      drawMeter(
        contexts.oi,
        state.barWidths.oi,
        state.cumulatives.oi,
        state.ranges.oi.min,
        state.ranges.oi.max,
        safeElements.oiCanvas.width,
        safeElements.oiCanvas.height
      );
    }
  };
  initializeMeters();

  const intervals = [
    setInterval(fetchBinanceOpenInterest, 5000),
    setInterval(ensureBybitConnection, 60000),
    setInterval(applyDecay, 1000),
  ];

  safeElements.container.module = {
    updateCanvasSize,
    handleConnectionEvent: (exchange) => {
      if (exchange === "bitstamp") state.isBitstampReady = true;
      else if (exchange === "bybit") state.isBybitReady = true;
      checkReadyState();
    },
    cleanup: () => {
      intervals.forEach(clearInterval);
      throttledUpdateAllVisuals.cancel();
      window.orderBooksBitstampWsManager.unsubscribe(bitstampOrderBook);
      window.orderBooksBitstampWsManager.unsubscribe(bitstampTrades);
      window.orderBooksBybitWsManager.unsubscribe(bybitTrade);
      window.orderBooksBybitWsManager.unsubscribe(bybitLiq);
    },
    getOrderBookData: () => ({ ...state.orderBookData }),
    getLastPrice: () => state.lastPrice,
  };

  return safeElements.container.module;
};

if (
  !window.orderBookResizeHandlerInitialized &&
  typeof ResizeObserver !== "undefined"
) {
  const resizeObserver = new ResizeObserver(
    debounce((entries) => {
      if (window._isResizing) return;
      window._isResizing = true;
      entries.forEach((entry) => entry.target.module?.updateCanvasSize());
      requestAnimationFrame(() => (window._isResizing = false));
    }, 100)
  );
  document
    .querySelectorAll(".crypto-container")
    .forEach((container) => resizeObserver.observe(container));
  window.orderBookResizeHandlerInitialized = true;
}

window.handleWebSocketConnection = (exchange) =>
  document
    .querySelectorAll(".crypto-container")
    .forEach((container) => container.module?.handleConnectionEvent(exchange));
window.addEventListener("websocket-connected-bitstamp", () =>
  window.handleWebSocketConnection("bitstamp")
);
window.addEventListener("websocket-connected-bybit", () =>
  window.handleWebSocketConnection("bybit")
);

const ensureWebSocketConnections = () => {
  if (!window.orderBooksBitstampWsManager) {
    window.orderBooksBitstampWsManager = new WebSocketManager(
      "wss://ws.bitstamp.net",
      "bitstamp",
      {
        name: "orderbook-bitstamp",
        reconnectDelay: 5000,
        maxReconnectAttempts: 20,
        pingInterval: 10000,
      }
    );
  }

  if (!window.orderBooksBybitWsManager) {
    window.orderBooksBybitWsManager = new WebSocketManager(
      "wss://stream.bybit.com/v5/public/linear",
      "bybit",
      {
        name: "orderbook-bybit",
        reconnectDelay: 5000,
        maxReconnectAttempts: 20,
        pingInterval: 10000,
      }
    );
  }

  if (!window.orderBooksBitstampWsManager.isConnected())
    window.orderBooksBitstampWsManager.connect();
  if (!window.orderBooksBybitWsManager.isConnected())
    window.orderBooksBybitWsManager.connect();
};

ensureWebSocketConnections();

const cryptos = ["BTC", "ETH", "LTC", "SOL"];
cryptos.forEach((symbol) =>
  createCryptoModule(
    symbol,
    {
      ticker: {
        symbol,
        bitstampOrderBook: `order_book_${symbol.toLowerCase()}usd`,
        bitstampTrades: `live_trades_${symbol.toLowerCase()}usd`,
        bybitTrade: `publicTrade.${symbol}USDT`,
        bybitLiq: `liquidation.${symbol}USDT`,
        binanceOi: `${symbol}USDT`,
      },
      urls: { binanceOiBase: "https://fapi.binance.com/fapi/v1/openInterest?symbol=" },
      orderbook: { barWidth: 1 },
    },
    {
      container: document.getElementById(`${symbol.toLowerCase()}-container`),
      orderbookCanvas: document.getElementById(`${symbol.toLowerCase()}-orderbook-canvas`),
      balancePercent: document.getElementById(`${symbol.toLowerCase()}-balance-percent`),
      tickerName: document.getElementById(`${symbol.toLowerCase()}-ticker-name`),
      minPrice: document.getElementById(`${symbol.toLowerCase()}-min-price`),
      midPrice: document.getElementById(`${symbol.toLowerCase()}-mid-price`),
      maxPrice: document.getElementById(`${symbol.toLowerCase()}-max-price`),
      lowestPrice: document.getElementById(`${symbol.toLowerCase()}-lowest-price`),
      highestPrice: document.getElementById(`${symbol.toLowerCase()}-highest-price`),
      spotPressureCanvas: document.getElementById(
        `${symbol.toLowerCase()}-spot-pressure-canvas`
      ),
      perpPressureCvdCanvas: document.getElementById(
        `${symbol.toLowerCase()}-perp-pressure-cvd-canvas`
      ),
      oiCanvas: document.getElementById(`${symbol.toLowerCase()}-oi-canvas`),
      liqCanvas: document.getElementById(`${symbol.toLowerCase()}-liq-canvas`),
      spotPressureValue: document.getElementById(
        `${symbol.toLowerCase()}-spot-pressure-value`
      ),
      perpPressureValue: document.getElementById(
        `${symbol.toLowerCase()}-perp-pressure-value`
      ),
      oiValue: document.getElementById(`${symbol.toLowerCase()}-oi-value`),
      liqValue: document.getElementById(`${symbol.toLowerCase()}-liq-value`),
      loadingOverlay: document.getElementById(`${symbol.toLowerCase()}-loading-overlay`),
    }
  )
);

// Utility functions
const utils = {
  // Debounce function to limit how often a function can be called
  debounce: (func, wait, immediate = false) => {
    let timeout;
    const debounced = (...args) => {
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
    // Register cleanup for this timeout
    if (window.CleanupManager && window.CleanupManager.registerCleanup) {
      window.CleanupManager.registerCleanup(() => { if (timeout) clearTimeout(timeout); });
    }
    return debounced;
  },
  
  // Throttle function to ensure function is called at most once per specified period
  throttle: (func, limit) => {
    let inThrottle, lastFunc, lastRan;
    const wrapper = function () {
      const context = this, args = arguments;
      if (!inThrottle) {
        func.apply(context, args);
        lastRan = Date.now();
        inThrottle = true;
      } else {
        clearTimeout(lastFunc);
        lastFunc = setTimeout(() => {
          if (Date.now() - lastRan >= limit) { 
            func.apply(context, args); 
            lastRan = Date.now(); 
          }
        }, limit - (Date.now() - lastRan));
      }
    };
    wrapper.cancel = () => { 
      clearTimeout(lastFunc); 
      inThrottle = false; 
    };
    // Register cleanup for this timeout
    if (window.CleanupManager && window.CleanupManager.registerCleanup) {
      window.CleanupManager.registerCleanup(() => { if (lastFunc) clearTimeout(lastFunc); });
    }
    return wrapper;
  },
  
  // Check if element is in viewport for performance optimization
  isElementInViewport: (el) => {
    if (!el) return false;
    const { top, left, height, width } = el.getBoundingClientRect();
    return top <= window.innerHeight && top + height >= 0 && 
           left <= window.innerWidth && left + width >= 0;
  },
  
  // Set text content only if it has changed to avoid unnecessary DOM updates
  setTextIfChanged: (element, text) => {
    if (element && element.textContent !== text) element.textContent = text;
  }
};

// Register cleanup for any global references if set in this module
if (window.CleanupManager && window.CleanupManager.registerCleanup) {
  window.CleanupManager.registerCleanup(() => {
    // Example: if you attach anything to window, clean it here
    // window.orderbookModule = null;
  });
}

// Order book utility functions
const getLargestBlock = (orders) => 
  orders.length ? orders.reduce((max, [price, volume]) => {
    const dollarValue = price * volume;
    return dollarValue > (max?.dollarValue || -Infinity) ? { price, volume, dollarValue } : max;
  }, null) : null;

// Generate a hash of the order book for efficient change detection
const hashOrderBook = (orderBookData, lastPrice) =>
  `${orderBookData.bids.slice(0, 5).join("|")}-${orderBookData.asks.slice(0, 5).join("|")}-${lastPrice || "unloaded"}`;

/**
 * Creates a lightweight chart using the Lightweight Charts library.
 * Defined locally to avoid global scope conflicts.
 * @param {HTMLElement} container - The DOM element to contain the chart.
 * @param {Object} options - Configuration options for the chart.
 * @returns {Object|null} - An object with chart and series, or null if creation fails.
 */
const createLightweightChart = (container, options = {}) => {
  if (!window.LightweightCharts) {
    console.error("LightweightCharts library not loaded");
    return null;
  }

  const defaultOptions = {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: '#131722' },
      textColor: '#D9D9D9',
      fontSize: 10,
      fontFamily: 'Trebuchet MS, Roboto, Ubuntu, sans-serif',
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: 'rgba(42, 46, 57, 0.5)' },
      horzLines: { color: 'rgba(42, 46, 57, 0.5)' }
    },
    timeScale: { visible: false },
    rightPriceScale: {
      visible: true,
      borderColor: 'rgba(42, 46, 57, 0.5)',
      scaleMargins: { top: 0.1, bottom: 0.1 },
      entireTextOnly: false,
      ticksVisible: true,
      formatPrice: price => Math.floor(price).toString(),
      minMove: 1,
      precision: 0
    },
    crosshair: {
      mode: 1,
      vertLine: {
        visible: true,
        color: '#758696',
        width: 1,
        style: 3,
        labelBackgroundColor: '#13172299'
      },
      horzLine: {
        visible: true,
        color: '#758696',
        width: 1,
        style: 3,
        labelBackgroundColor: '#13172299'
      }
    },
    handleScroll: { vertTouchDrag: false }
  };

  const chartOptions = { ...defaultOptions, ...options };

  try {
    const chart = window.LightweightCharts.createChart(container, chartOptions);
    const series = chart.addSeries(window.LightweightCharts.CandlestickSeries, {
      upColor: "#AAAAAA",
      downColor: "#AAAAAA",
      borderColor: "#AAAAAA",
      wickUpColor: "#AAAAAA",
      wickDownColor: "#AAAAAA",
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineSource: window.LightweightCharts.PriceLineSource.LastBar,
      priceFormat: {
        type: 'price',
        precision: 0,
        minMove: 1,
        formatter: price => window.utils && window.utils.formatLargeNumber ? window.utils.formatLargeNumber(price) : Math.floor(price).toString()
      }
    });
    return { chart, series };
  } catch (error) {
    console.error("Error creating lightweight chart:", error);
    return null;
  }
};

const createCryptoModule = (symbol, config, elements) => {
  if (!elements.container || !elements.orderbookCanvas) {
    console.error(`Missing elements for ${symbol}`);
    return null;
  }

  const safeElements = {
    container: elements.container,
    orderbookCanvas: elements.orderbookCanvas,
    balancePercent: elements.balancePercent,
    tickerName: elements.tickerName,
    minPrice: elements.minPrice,
    midPrice: elements.midPrice,
    maxPrice: elements.maxPrice,
    lowestPrice: elements.lowestPrice,
    highestPrice: elements.highestPrice,
    loadingOverlay: elements.loadingOverlay,
  };

  const state = {
    orderBookData: { bids: [], asks: [] },
    lastPrice: null,
    lastPriceUpdateTime: Date.now(),
    persistentBlocks: { lowestBid: null, highestAsk: null },
    lastOrderBookHash: 0,
    cachedDisplay: { bids: null, asks: null },
    lastFilterPrice: null,
    isBitstampReady: false,
    needsUpdate: false,
    lastFullDrawTime: 0,
    consecutiveHighLoadFrames: 0,
    alternateUpdates: true,
    enabled: true,
    chartData: { candles: [] },
    charts: {},
  };

  const contexts = {
    orderbook: safeElements.orderbookCanvas.getContext("2d"),
  };

  const updateTickerName = () => safeElements.tickerName.textContent = `${symbol} Δ: `;
  updateTickerName();

  const updateOrderBookExtremes = () => {
    if (!state.orderBookData?.bids?.length || !state.orderBookData?.asks?.length) return;
    const lowestBidPrice = state.orderBookData.bids.at(-1)[0], highestAskPrice = state.orderBookData.asks.at(-1)[0];
    state.persistentBlocks.lowestBid = Math.min(state.persistentBlocks.lowestBid ?? Infinity, lowestBidPrice);
    state.persistentBlocks.highestAsk = Math.max(state.persistentBlocks.highestAsk ?? -Infinity, highestAskPrice);

    const resetThreshold = 0.05;
    if (state.persistentBlocks.lastResetPrice) {
      const priceChange = Math.abs(state.lastPrice - state.persistentBlocks.lastResetPrice) / state.persistentBlocks.lastResetPrice;
      if (priceChange > resetThreshold) {
        state.persistentBlocks.lowestBid = lowestBidPrice;
        state.persistentBlocks.highestAsk = highestAskPrice;
        state.persistentBlocks.lastResetPrice = state.lastPrice;
      }
    } else state.persistentBlocks.lastResetPrice = state.lastPrice;
  };

  const drawOrderBookBars = () => {
    const currentHash = hashOrderBook(state.orderBookData, state.lastPrice);
    if (currentHash === state.lastOrderBookHash && !window._isResizing) return;
    state.lastOrderBookHash = currentHash;
    if (!utils.isElementInViewport(safeElements.orderbookCanvas)) return;

    const ctx = contexts.orderbook, dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, safeElements.orderbookCanvas.width / dpr, safeElements.orderbookCanvas.height / dpr);
    if (!state.lastPrice) {
      ["minPrice", "maxPrice", "midPrice"].forEach(id => safeElements[id] && utils.setTextIfChanged(safeElements[id], "Loading..."));
      ["lowestPrice", "highestPrice", "balancePercent"].forEach(id => safeElements[id] && utils.setTextIfChanged(safeElements[id], ""));
      return;
    }

    const rangeSize = state.lastPrice * 0.01, minPrice = state.lastPrice - rangeSize, maxPrice = state.lastPrice + rangeSize;
    const biasBids = state.orderBookData.bids.filter(([price]) => price >= state.lastPrice * 0.95 && price <= state.lastPrice);
    const biasAsks = state.orderBookData.asks.filter(([price]) => price >= state.lastPrice && price <= state.lastPrice * 1.05);
    const bidValue = biasBids.reduce((sum, [p, v]) => sum + p * v, 0), askValue = biasAsks.reduce((sum, [p, v]) => sum + p * v, 0);
    const totalValue = bidValue + askValue, balancePercent = totalValue ? ((bidValue - askValue) / totalValue) * 100 : 0;
    const largestBid = getLargestBlock(state.orderBookData.bids), largestAsk = getLargestBlock(state.orderBookData.asks);

    ctx.strokeStyle = "#1c2526";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(safeElements.orderbookCanvas.width / 2, 0);
    ctx.lineTo(safeElements.orderbookCanvas.width / 2, safeElements.orderbookCanvas.height);
    ctx.stroke();

    const dynamicColor = balancePercent >= 0 ? "rgba(0, 255, 255, 0.75)" : "rgba(255, 85, 85, 0.75)";
    safeElements.tickerName.style.color = dynamicColor;
    utils.setTextIfChanged(safeElements.balancePercent, `${Math.round(balancePercent)}%`);
    safeElements.balancePercent.style.color = dynamicColor;
    safeElements.balancePercent.style.fontSize = "24px";
    safeElements.midPrice.parentElement.style.color = "#BBBBBB";

    if (state.lastFilterPrice !== state.lastPrice) {
      state.cachedDisplay.bids = state.orderBookData.bids.filter(([price]) => price >= minPrice && price <= state.lastPrice).sort((a, b) => b[0] - a[0]);
      state.cachedDisplay.asks = state.orderBookData.asks.filter(([price]) => price >= state.lastPrice && price <= maxPrice).sort((a, b) => a[0] - b[0]);
      state.lastFilterPrice = state.lastPrice;
    }

    const baseline = safeElements.orderbookCanvas.height / dpr;
    const viewFieldDollarSum = [...state.cachedDisplay.bids, ...state.cachedDisplay.asks].reduce((sum, [p, v]) => sum + p * v, 0) || 1;
    let cumulativeBidHeight = 0, cumulativeAskHeight = 0;

    state.cachedDisplay.bids.forEach(([price, volume]) => {
      const x = ((price - minPrice) / (maxPrice - minPrice)) * (safeElements.orderbookCanvas.width / dpr);
      const normalizedHeight = (price * volume / viewFieldDollarSum) * (safeElements.orderbookCanvas.height / dpr);
      cumulativeBidHeight += normalizedHeight;
      ctx.fillStyle = "rgba(170, 170, 170, 0.6)";
      ctx.fillRect(x - config.orderbook.barWidth / 2, baseline - cumulativeBidHeight, config.orderbook.barWidth, cumulativeBidHeight);
    });

    state.cachedDisplay.asks.forEach(([price, volume]) => {
      const x = ((price - minPrice) / (maxPrice - minPrice)) * (safeElements.orderbookCanvas.width / dpr);
      const normalizedHeight = (price * volume / viewFieldDollarSum) * (safeElements.orderbookCanvas.height / dpr);
      cumulativeAskHeight += normalizedHeight;
      ctx.fillStyle = "rgba(170, 170, 170, 0.6)";
      ctx.fillRect(x - config.orderbook.barWidth / 2, baseline - cumulativeAskHeight, config.orderbook.barWidth, cumulativeAskHeight);
    });

    utils.setTextIfChanged(safeElements.minPrice, `$${largestBid ? Math.floor(largestBid.price) : Math.floor(state.lastPrice)}`);
    utils.setTextIfChanged(safeElements.lowestPrice, state.persistentBlocks.lowestBid ? `($${Math.floor(state.persistentBlocks.lowestBid)})` : "");
    utils.setTextIfChanged(safeElements.midPrice, `$${Math.floor(state.lastPrice)}`);
    utils.setTextIfChanged(safeElements.maxPrice, `$${largestAsk ? Math.floor(largestAsk.price) : Math.floor(state.lastPrice)}`);
    utils.setTextIfChanged(safeElements.highestPrice, state.persistentBlocks.highestAsk ? `($${Math.floor(state.persistentBlocks.highestAsk)})` : "");
  };

  const fetchHistoricalData = async () => {
    const pair = symbol.toLowerCase();
    const interval = 300; // 5-minute interval
    const totalLimit = 288; // 24 hours of 5-minute candles

    try {
      if (safeElements.loadingOverlay) {
        safeElements.loadingOverlay.style.display = 'block';
        safeElements.loadingOverlay.textContent = `Loading ${symbol} historical data...`;
      }

      const bitstampPair = `${pair}usd`;
      const url = `https://www.bitstamp.net/api/v2/ohlc/${bitstampPair}/?step=${interval}&limit=1000`;

      let response, data;
      try {
        response = await fetch(url);
        if (response.ok) data = await response.json();
      } catch (directError) {
        console.log(`Direct fetch failed: ${directError.message}, trying CORS proxy...`);
      }

      if (!data) {
        try {
          const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
          response = await fetch(proxyUrl);
          if (response.ok) data = await response.json();
        } catch (proxyError) {
          console.error(`Proxy fetch failed: ${proxyError.message}`);
        }
      }

      if (!data) {
        try {
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
          response = await fetch(proxyUrl);
          if (response.ok) data = await response.json();
        } catch (proxyError2) {
          console.error(`Second proxy fetch failed: ${proxyError2.message}`);
        }
      }

      if (!data?.data?.ohlc) {
        console.error("Invalid or missing Bitstamp data");
        return [];
      }

      const allBars = data.data.ohlc.map(bar => ({
        time: parseInt(bar.timestamp, 10),
        open: parseFloat(bar.open),
        high: parseFloat(bar.high),
        low: parseFloat(bar.low),
        close: parseFloat(bar.close),
        volume: parseFloat(bar.volume)
      })).sort((a, b) => a.time - b.time);

      return allBars.slice(-totalLimit);
    } catch (error) {
      console.error(`Error fetching historical data: ${error.message}`);
      return [];
    } finally {
      if (safeElements.loadingOverlay) safeElements.loadingOverlay.style.display = 'none';
    }
  };

  /**
   * Initializes the chart for the crypto module.
   * Uses the local createLightweightChart function to avoid global scope issues.
   */
  const initializeCharts = async () => {
    if (!window.LightweightCharts) {
      console.error("LightweightCharts library not loaded");
      return;
    }

    const meterWrappers = safeElements.container.querySelectorAll('.meter-wrapper');
    meterWrappers.forEach(wrapper => wrapper.remove());

    const chartContainer = document.createElement('div');
    chartContainer.className = 'combined-chart-container';
    chartContainer.style.width = '100%';
    chartContainer.style.flex = '1';
    chartContainer.style.marginTop = '10px';
    chartContainer.style.backgroundColor = '#0f141a';
    chartContainer.style.borderRadius = '4px';
    chartContainer.style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';
    chartContainer.style.overflow = 'hidden';
    chartContainer.style.position = 'relative';

    safeElements.container.style.display = 'flex';
    safeElements.container.style.flexDirection = 'column';
    safeElements.container.appendChild(chartContainer);

    // Use the local createLightweightChart function instead of window.createLightweightChart
    const chart = createLightweightChart(chartContainer, {
      layout: {
        background: { color: "#0f141a", type: 'solid' },
        textColor: "#D3D3D3",
        fontSize: 10,
        attributionLogo: false
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      timeScale: { visible: false },
      rightPriceScale: {
        visible: true,
        borderColor: "#2A2A2A",
        scaleMargins: { top: 0.1, bottom: 0.1 }
      },
      crosshair: {
        mode: 1,
        vertLine: { visible: true, labelBackgroundColor: '#2A2A2A' },
        horzLine: { visible: true, labelBackgroundColor: '#2A2A2A' }
      }
    });

    if (chart) {
      state.charts.combined = chart;

      const get5MinTimestamp = (timestamp) => {
        const date = new Date(timestamp * 1000);
        date.setMinutes(Math.floor(date.getMinutes() / 5) * 5, 0, 0);
        return Math.floor(date.getTime() / 1000);
      };

      const historicalData = await fetchHistoricalData();
      if (historicalData && historicalData.length > 0) {
        state.chartData.candles = historicalData;
        chart.series.setData(historicalData);
        chart.chart.timeScale().fitContent();
        const lastCandle = historicalData[historicalData.length - 1];
        state.currentCandleTime = lastCandle.time;
      } else {
        state.chartData.candles = [];
        if (state.lastPrice) {
          const currentTime = get5MinTimestamp(Math.floor(Date.now() / 1000));
          const initialCandle = {
            time: currentTime,
            open: state.lastPrice,
            high: state.lastPrice,
            low: state.lastPrice,
            close: state.lastPrice
          };
          state.chartData.candles = [initialCandle];
          chart.series.setData([initialCandle]);
          chart.chart.timeScale().fitContent();
          state.currentCandleTime = currentTime;
        }
      }

      const candleInterval = setInterval(() => {
        if (!state.enabled || !state.lastPrice) return;
        const newCandleTime = get5MinTimestamp(Math.floor(Date.now() / 1000));
        if (!state.chartData.candles || state.chartData.candles.length === 0) {
          const newCandle = {
            time: newCandleTime,
            open: state.lastPrice,
            high: state.lastPrice,
            low: state.lastPrice,
            close: state.lastPrice
          };
          state.chartData.candles = [newCandle];
          chart.series.update(newCandle);
          state.currentCandleTime = newCandleTime;
          return;
        }
        const lastCandle = state.chartData.candles[state.chartData.candles.length - 1];
        if (newCandleTime > state.currentCandleTime) {
          const newCandle = {
            time: newCandleTime,
            open: state.lastPrice,
            high: state.lastPrice,
            low: state.lastPrice,
            close: state.lastPrice
          };
          state.chartData.candles.push(newCandle);
          state.currentCandleTime = newCandleTime;
          if (state.chartData.candles.length > 288) state.chartData.candles = state.chartData.candles.slice(-288);
          chart.series.update(newCandle);
        } else if (lastCandle) {
          lastCandle.close = state.lastPrice;
          lastCandle.high = Math.max(lastCandle.high, state.lastPrice);
          lastCandle.low = Math.min(lastCandle.low, state.lastPrice);
          chart.series.update(lastCandle);
        }
      }, 1000);

      state.chartIntervals = [candleInterval];
    }
  };

  let updateScheduled = false;
  const updateAllVisuals = () => {
    if (!state.needsUpdate || !state.enabled || updateScheduled) return;
    state.needsUpdate = false;
    updateScheduled = true;

    setTimeout(() => {
      requestAnimationFrame(() => {
        try {
          updateScheduled = false;
          if (!state.enabled || !utils.isElementInViewport(safeElements.orderbookCanvas)) return;
          const startTime = performance.now();
          const now = Date.now();
          const timeSinceLastFullDraw = now - (state.lastFullDrawTime || 0);
          const isHighLoad = state.consecutiveHighLoadFrames > 3;
          const isTabActive = !document.hidden && document.hasFocus();

          if (!isTabActive && timeSinceLastFullDraw < 1000) return;
          if (isHighLoad && timeSinceLastFullDraw < 200) return;

          if (isHighLoad) {
            if (state.alternateUpdates) drawOrderBookBars();
            state.alternateUpdates = !state.alternateUpdates;
          } else {
            drawOrderBookBars();
            state.lastFullDrawTime = now;
          }

          const frameTime = performance.now() - startTime;
          state.consecutiveHighLoadFrames = frameTime > 16 ? state.consecutiveHighLoadFrames + 1 : Math.max(0, state.consecutiveHighLoadFrames - 1);
        } catch (error) {
          console.error(`Error updating visuals for ${symbol}:`, error);
          updateScheduled = false;
        }
      });
    }, 0);
  };
  const throttledUpdateAllVisuals = utils.throttle(updateAllVisuals, 100);

  const updateCanvasSize = () => {
    if (!safeElements.container.offsetParent) return;
    const dpr = window.devicePixelRatio || 1, width = safeElements.container.clientWidth, height = safeElements.container.clientHeight;

    const textElementsHeight = 60;
    const availableHeight = height - textElementsHeight;
    const bottomMargin = 5;
    const adjustedAvailableHeight = availableHeight - bottomMargin;
    const orderbookHeight = Math.floor(adjustedAvailableHeight * 0.6);

    if (safeElements.orderbookCanvas) {
      const newWidth = Math.floor(width * dpr), newHeight = Math.floor(orderbookHeight * dpr);
      const prevWidth = safeElements.orderbookCanvas.width || 0, prevHeight = safeElements.orderbookCanvas.height || 0;

      if (Math.abs(newWidth - prevWidth) > 1 || Math.abs(newHeight - prevHeight) > 1) {
        requestAnimationFrame(() => {
          safeElements.container.style.paddingBottom = `${bottomMargin}px`;
          safeElements.orderbookCanvas.width = newWidth;
          safeElements.orderbookCanvas.height = newHeight;
          safeElements.orderbookCanvas.style.width = `${width}px`;
          safeElements.orderbookCanvas.style.height = `${orderbookHeight}px`;
          safeElements.orderbookCanvas.style.margin = `0 0 0 0`;

          const ctx = safeElements.orderbookCanvas.getContext("2d");
          if (dpr !== 1) ctx.scale(dpr, dpr);

          if (safeElements.tickerName?.parentElement) safeElements.tickerName.parentElement.style.cssText = `width: ${width}px; padding: 2px 0;`;
          if (safeElements.midPrice?.parentElement) safeElements.midPrice.parentElement.style.cssText = `width: ${width}px; padding: 2px 0;`;

          const combinedChartContainer = safeElements.container.querySelector('.combined-chart-container');
          if (combinedChartContainer) {
            combinedChartContainer.style.width = `${width}px`;
            combinedChartContainer.style.marginTop = '10px';
            const containerHeight = safeElements.container.clientHeight;
            const orderbookCanvasHeight = safeElements.orderbookCanvas.clientHeight;
            const topElementsHeight = textElementsHeight;
            const chartContainerHeight = containerHeight - orderbookCanvasHeight - topElementsHeight - 15;
            if (state.charts.combined && state.charts.combined.chart) state.charts.combined.chart.resize(width, chartContainerHeight);
          }

          window._isResizing = true;
          window._isResizing = false;
          updateAllVisuals();
        });
      }
    }
  };

  const checkReadyState = () => {
    if (state.isBitstampReady) {
      safeElements.loadingOverlay.style.cssText = "opacity: 0; pointer-events: none;";
      updateCanvasSize();
      updateOrderBookExtremes();
      updateAllVisuals();
    } else {
      safeElements.loadingOverlay.style.cssText = "opacity: 1; pointer-events: auto;";
      setTimeout(() => { if (!state.isBitstampReady) window.orderBooksBitstampWsManager.connect(); }, 10000);
    }
  };

  window.orderBooksBitstampWsManager.subscribe(config.ticker.bitstampOrderBook, data => {
    try {
      if (data.event === "data" && data.channel === config.ticker.bitstampOrderBook) {
        if (!data.data || !Array.isArray(data.data.bids) || !Array.isArray(data.data.asks)) return;
        const processedBids = data.data.bids.filter(bid => Array.isArray(bid) && bid.length >= 2).map(([p, v]) => [parseFloat(p), parseFloat(v)]).filter(([p, v]) => isFinite(p) && isFinite(v));
        const processedAsks = data.data.asks.filter(ask => Array.isArray(ask) && ask.length >= 2).map(([p, v]) => [parseFloat(p), parseFloat(v)]).filter(([p, v]) => isFinite(p) && isFinite(v));
        if (processedBids.length && processedAsks.length) {
          state.orderBookData = { bids: processedBids, asks: processedAsks };
          if (Date.now() - state.lastPriceUpdateTime > 2000) {
            state.lastPrice = (state.orderBookData.bids[0][0] + state.orderBookData.asks[0][0]) / 2;
            state.lastPriceUpdateTime = Date.now();
            utils.setTextIfChanged(safeElements.midPrice, `$${Math.floor(state.lastPrice)}`);
          }
          state.needsUpdate = true;
          throttledUpdateAllVisuals();
        }
      }
    } catch (error) {
      console.error(`Bitstamp orderbook WS error (${symbol}):`, error);
      setTimeout(() => window.orderBooksBitstampWsManager?.connect(), 5000);
    }
  });

  window.orderBooksBitstampWsManager.subscribe(config.ticker.bitstampTrades, data => {
    try {
      if (data.event === "trade" && data.channel === config.ticker.bitstampTrades && data.data) {
        const price = parseFloat(data.data.price), volume = parseFloat(data.data.amount), type = data.data.type;
        if (Number.isFinite(price) && Number.isFinite(volume) && type !== undefined) {
          state.lastPrice = price;
          state.lastPriceUpdateTime = Date.now();
          updateOrderBookExtremes();
        }
      }
    } catch (error) {
      console.error(`Bitstamp trades WS error (${symbol}):`, error);
      setTimeout(() => window.orderBooksBitstampWsManager?.connect(), 5000);
    }
  });

  updateCanvasSize();
  initializeCharts();

  safeElements.container.module = {
    updateCanvasSize,
    handleConnectionEvent: exchange => {
      if (exchange === "bitstamp") {
        state.isBitstampReady = true;
        checkReadyState();
      }
    },
    cleanup: () => {
      if (state.chartIntervals) state.chartIntervals.forEach(clearInterval);
      throttledUpdateAllVisuals.cancel();
      window.orderBooksBitstampWsManager.unsubscribe(config.ticker.bitstampOrderBook);
      window.orderBooksBitstampWsManager.unsubscribe(config.ticker.bitstampTrades);
    },
    getOrderBookData: () => ({ ...state.orderBookData }),
    getLastPrice: () => state.lastPrice,
    setEnabled: () => { state.enabled = true; },
    isEnabled: () => state.enabled
  };

  return safeElements.container.module;
};

if (!window.orderBookResizeHandlerInitialized && typeof ResizeObserver !== "undefined") {
  const resizeObserver = new ResizeObserver(utils.debounce(entries => {
    if (window._isResizing) return;
    window._isResizing = true;
    entries.forEach(entry => entry.target.module?.updateCanvasSize());
    requestAnimationFrame(() => window._isResizing = false);
  }, 100));
  document.querySelectorAll(".crypto-container").forEach(container => resizeObserver.observe(container));
  window.orderBookResizeHandlerInitialized = true;
}

window.handleWebSocketConnection = exchange =>
  document.querySelectorAll(".crypto-container").forEach(container => container.module?.handleConnectionEvent(exchange));
window.addEventListener("websocket-connected-bitstamp", () => window.handleWebSocketConnection("bitstamp"));

const ensureWebSocketConnections = () => {
  if (!window.WebSocketManager) {
    console.log("Using local WebSocketManager implementation");
    window.WebSocketManager = class {
      constructor(url, exchange, options = {}) {
        this.url = url;
        this.exchange = exchange;
        this.options = { name: 'websocket-manager', reconnectDelay: 5000, maxReconnectAttempts: 10, pingInterval: 15000, ...options };
        this.ws = null;
        this.reconnectAttempts = 0;
        this.pingTimer = null;
        this.subscriptions = new Map();
        this.connected = false;
        this.connecting = false;
        this.connectionHandlers = [];

        window.addEventListener('online', () => {
          if (!this.connected && !this.connecting) {
            console.log(`Network back online, reconnecting to ${this.exchange}`);
            this.connect();
          }
        });
      }

      connect() {
        if (this.connected || this.connecting) return;
        if (!navigator.onLine) {
          console.log(`Network offline, delaying ${this.exchange} connection`);
          return;
        }
        this.connecting = true;
        console.log(`Connecting to ${this.exchange} WebSocket...`);

        try {
          this.ws = new WebSocket(this.url);
          const connectionTimeout = setTimeout(() => {
            if (!this.connected) {
              console.log(`${this.exchange} connection timeout`);
              if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
              this.connecting = false;
              this.reconnect();
            }
          }, 10000);

          this.ws.onopen = () => {
            clearTimeout(connectionTimeout);
            console.log(`${this.exchange} WebSocket connected`);
            this.connected = true;
            this.connecting = false;
            this.reconnectAttempts = 0;
            this.subscriptions.forEach((callback, channel) => this.subscribe(channel, callback));
            this.startPingTimer();
            this.connectionHandlers.forEach(handler => { try { handler(this.exchange); } catch (e) { console.error(`Connection handler error: ${e.message}`); } });
            window.dispatchEvent(new CustomEvent(`websocket-connected-${this.exchange.toLowerCase()}`));
          };

          this.ws.onclose = (event) => {
            this.connected = false;
            this.connecting = false;
            clearTimeout(this.pingTimer);
            const code = event && typeof event.code !== "undefined" ? event.code : "unknown";
            const reason = event && typeof event.reason !== "undefined" ? event.reason : "unknown";
            console.warn(`${this.exchange} WebSocket closed: code=${code}, reason=${reason}`);
            // If abnormal closure (1006), log specifically
            if (code === 1006) {
              console.error(`${this.exchange} WebSocket closed abnormally (1006). This often means the connection was lost without a close frame. Check for network issues, server disconnects, or protocol errors.`);
            }
            this.reconnect();
          };

          this.ws.onerror = error => console.error(`${this.exchange} WebSocket error:`, error);

          this.ws.onmessage = event => {
            try {
              const data = JSON.parse(event.data);
              if (this.exchange === 'bitstamp' && data.event === 'bts:heartbeat') return this.send({ event: 'bts:heartbeat' });
              if (this.exchange === 'bybit' && data.op === 'ping') return this.send({ op: 'pong' });
              const channel = this.exchange === 'bitstamp' ? data.channel : this.exchange === 'bybit' ? data.topic : '';
              if (channel && this.subscriptions.has(channel)) this.subscriptions.get(channel)(data);
            } catch (e) {
              console.error(`Error processing ${this.exchange} WebSocket message:`, e);
            }
          };
        } catch (error) {
          console.error(`Error creating ${this.exchange} WebSocket:`, error);
          this.connecting = false;
          this.reconnect();
        }
      }

      reconnect() {
        if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
          this.reconnectAttempts++;
          // Exponential backoff: baseDelay * 2^(attempts-1), capped at 60s
          const baseDelay = this.options.reconnectDelay;
          const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), 60000);
          console.log(`${this.exchange} WebSocket disconnected. Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts})`);
          setTimeout(() => this.connect(), delay);
        } else {
          console.error(`${this.exchange} WebSocket failed after ${this.options.maxReconnectAttempts} attempts`);
          setTimeout(() => { this.reconnectAttempts = 0; this.connect(); }, this.options.reconnectDelay * 5);
        }
      }

      startPingTimer() {
        clearTimeout(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.connected) this.send(this.exchange === 'bitstamp' ? { event: 'bts:heartbeat' } : { op: 'ping' });
        }, this.options.pingInterval);
      }

      send(data) {
        if (!this.connected || !this.ws) return false;
        try {
          this.ws.send(JSON.stringify(data));
          return true;
        } catch (e) {
          console.error(`Error sending to ${this.exchange} WebSocket:`, e);
          return false;
        }
      }

      subscribe(channel, callback) {
        this.subscriptions.set(channel, callback);
        if (this.connected) this.send(this.exchange === 'bitstamp' ? { event: 'bts:subscribe', data: { channel } } : { op: 'subscribe', args: [channel] });
      }

      unsubscribe(channel) {
        if (this.subscriptions.has(channel)) {
          this.subscriptions.delete(channel);
          if (this.connected) this.send(this.exchange === 'bitstamp' ? { event: 'bts:unsubscribe', data: { channel } } : { op: 'unsubscribe', args: [channel] });
        }
      }

      onConnection(handler) { this.connectionHandlers.push(handler); }
      isConnected() { return this.connected; }
    };
  }

  if (!window.orderBooksBitstampWsManager) {
    window.orderBooksBitstampWsManager = new window.WebSocketManager("wss://ws.bitstamp.net", "bitstamp", { name: "orderbook-bitstamp" });
  }

  if (!window.orderBooksBitstampWsManager.isConnected()) window.orderBooksBitstampWsManager.connect();
};

ensureWebSocketConnections();

const cryptos = ["BTC", "ETH", "LTC", "SOL"];
cryptos.forEach(symbol => createCryptoModule(symbol, {
  ticker: {
    symbol,
    bitstampOrderBook: `order_book_${symbol.toLowerCase()}usd`,
    bitstampTrades: `live_trades_${symbol.toLowerCase()}usd`,
  },
  orderbook: { barWidth: 1 },
}, {
  container: document.getElementById(`${symbol.toLowerCase()}-container`),
  orderbookCanvas: document.getElementById(`${symbol.toLowerCase()}-orderbook-canvas`),
  balancePercent: document.getElementById(`${symbol.toLowerCase()}-balance-percent`),
  tickerName: document.getElementById(`${symbol.toLowerCase()}-ticker-name`),
  minPrice: document.getElementById(`${symbol.toLowerCase()}-min-price`),
  midPrice: document.getElementById(`${symbol.toLowerCase()}-mid-price`),
  maxPrice: document.getElementById(`${symbol.toLowerCase()}-max-price`),
  lowestPrice: document.getElementById(`${symbol.toLowerCase()}-lowest-price`),
  highestPrice: document.getElementById(`${symbol.toLowerCase()}-highest-price`),
  loadingOverlay: document.getElementById(`${symbol.toLowerCase()}-loading-overlay`),
}));
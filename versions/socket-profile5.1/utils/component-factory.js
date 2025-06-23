/**
 * Component Factory for creating UI elements
 * Reduces HTML duplication by generating components programmatically
 */
class ComponentFactory {
    /**
     * Creates a complete crypto container with all child elements
     * @param {string} symbol - Cryptocurrency symbol (e.g., 'BTC')
     * @returns {HTMLElement} - The constructed container element
     */
    static createCryptoContainer(symbol) {
        const symbolLower = symbol.toLowerCase();
        const container = document.createElement('div');
        container.id = `${symbolLower}-container`;
        container.className = 'crypto-container';
        
        // Add loading overlay
        const loadingOverlay = document.createElement('div');
        loadingOverlay.id = `${symbolLower}-loading-overlay`;
        loadingOverlay.className = 'loading-overlay';
        loadingOverlay.textContent = 'Loading...';
        container.appendChild(loadingOverlay);
        
        // Add orderbook canvas
        const canvas = document.createElement('canvas');
        canvas.id = `${symbolLower}-orderbook-canvas`;
        canvas.className = 'orderbook-canvas';
        container.appendChild(canvas);
        
        // Add bias text
        const biasText = document.createElement('div');
        biasText.id = `${symbolLower}-bias-text`;
        biasText.className = 'bias-text';
        
        const tickerName = document.createElement('span');
        tickerName.id = `${symbolLower}-ticker-name`;
        tickerName.className = 'metric-title';
        
        const balancePercent = document.createElement('span');
        balancePercent.id = `${symbolLower}-balance-percent`;
        balancePercent.className = 'metric-value';
        
        biasText.appendChild(tickerName);
        biasText.appendChild(balancePercent);
        container.appendChild(biasText);
        
        // Add mid price text
        const midPriceText = document.createElement('div');
        midPriceText.id = `${symbolLower}-mid-price-text`;
        midPriceText.className = 'mid-price-text';
        
        const midPrice = document.createElement('span');
        midPrice.id = `${symbolLower}-mid-price`;
        
        midPriceText.appendChild(midPrice);
        container.appendChild(midPriceText);
        
        // Add price scale
        const priceScale = document.createElement('div');
        priceScale.id = `${symbolLower}-price-scale`;
        priceScale.className = 'price-scale';
        
        const priceBlockMin = document.createElement('div');
        priceBlockMin.className = 'price-block';
        
        const minPrice = document.createElement('span');
        minPrice.id = `${symbolLower}-min-price`;
        
        const lowestPrice = document.createElement('span');
        lowestPrice.id = `${symbolLower}-lowest-price`;
        
        priceBlockMin.appendChild(minPrice);
        priceBlockMin.appendChild(lowestPrice);
        
        const priceBlockMax = document.createElement('div');
        priceBlockMax.className = 'price-block';
        
        const maxPrice = document.createElement('span');
        maxPrice.id = `${symbolLower}-max-price`;
        
        const highestPrice = document.createElement('span');
        highestPrice.id = `${symbolLower}-highest-price`;
        
        priceBlockMax.appendChild(maxPrice);
        priceBlockMax.appendChild(highestPrice);
        
        priceScale.appendChild(priceBlockMin);
        priceScale.appendChild(priceBlockMax);
        container.appendChild(priceScale);
        
        // Add meters
        const meterTypes = [
            { id: 'spot-pressure', title: 'SPOT Δ:', isFirst: true },
            { id: 'perp-pressure', title: 'PERP Δ:', canvasId: `${symbolLower}-perp-pressure-cvd-canvas` },
            { id: 'oi', title: 'OI Δ:' },
            { id: 'liq', title: 'LIQ Δ:' }
        ];
        
        meterTypes.forEach(meter => {
            container.appendChild(this.createMeter(symbolLower, meter));
        });
        
        // Add USD Premium meter for BTC only

        
        return container;
    }
    
    /**
     * Creates a meter component
     * @param {string} symbol - Cryptocurrency symbol in lowercase
     * @param {Object} options - Meter options
     * @returns {HTMLElement} - The constructed meter element
     */
    static createMeter(symbol, options) {
        const wrapper = document.createElement('div');
        wrapper.className = `meter-wrapper${options.isFirst ? ' first-meter' : ''}`;
        
        const titleValue = document.createElement('div');
        titleValue.className = 'meter-title-value';
        
        const title = document.createElement('span');
        title.id = options.titleId || `${symbol}-${options.id}-title`;
        title.className = 'metric-title';
        title.textContent = options.title || '';
        if (options.titleColor) {
            title.style.color = options.titleColor;
        }
        
        const value = document.createElement('span');
        value.id = `${symbol}-${options.id}-value`;
        value.className = 'metric-value hidden-value';
        value.textContent = '0.000';
        if (options.valueColor) {
            value.style.color = options.valueColor;
        }
        
        titleValue.appendChild(title);
        titleValue.appendChild(value);
        
        const canvas = document.createElement('canvas');
        canvas.id = options.canvasId || `${symbol}-${options.id}-canvas`;
        canvas.className = 'meter-canvas';
        if (options.borderStyle) {
            canvas.style.cssText = options.borderStyle;
        }
        
        wrapper.appendChild(titleValue);
        wrapper.appendChild(canvas);
        
        return wrapper;
    }
    
    /**
     * Initializes all crypto containers in the DOM
     */
    static initializeContainers() {
        const container = document.querySelector('.order-books-container');
        if (!container) {
            console.error('Order books container not found');
            return;
        }
        
        // Clear existing content
        container.innerHTML = '';
        
        // Add containers for each cryptocurrency
        window.CONFIG.cryptocurrencies.forEach(crypto => {
            container.appendChild(this.createCryptoContainer(crypto.symbol));
        });
    }
}

// Export for use in other modules
window.ComponentFactory = ComponentFactory;

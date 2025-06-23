/**
 * Factory for creating chart drawing primitives
 * Centralizes creation and configuration of drawing elements
 */
class PrimitiveFactory {
    /**
     * Creates a drawing primitive based on type
     * @param {string} type - Type of primitive ('line', 'rectangle', etc.)
     * @param {Object} options - Configuration options for the primitive
     * @returns {Object} - The created primitive object
     */
    static createPrimitive(type, options = {}) {
        switch (type.toLowerCase()) {
            case 'line':
                return new LinePrimitive(options);
            case 'rectangle':
                return new RectanglePrimitive(options);
            default:
                throw new Error(`Unknown primitive type: ${type}`);
        }
    }
}

/**
 * Base class for all drawing primitives
 */
class BasePrimitive {
    constructor(options = {}) {
        this.id = options.id || `${this.constructor.name.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.points = options.points || { x1: 0, y1: 0, x2: 0, y2: 0 };
        this._paneViews = null;
    }
    
    setPoints(points) {
        this.points = points;
        this._paneViews = null;
    }
    
    updateAllViews() {
        this._paneViews = null;
    }
}

/**
 * Line primitive for drawing straight lines
 */
class LinePrimitive extends BasePrimitive {
    constructor(options = {}) {
        super(options);
        
        const config = window.CONFIG?.primitives?.line || {};
        
        this.options = {
            color: options.color || config.defaultColor || 'rgba(255, 255, 255, 0.8)',
            lineWidth: options.lineWidth || config.defaultWidth || 2,
            lineStyle: options.lineStyle || 0, // 0 = solid, 1 = dotted, 2 = dashed
        };
    }
    
    get paneViews() {
        if (!this._paneViews) {
            this._paneViews = [new LinePaneView(this)];
        }
        return this._paneViews;
    }
}

/**
 * Rectangle primitive for drawing rectangles
 */
class RectanglePrimitive extends BasePrimitive {
    constructor(options = {}) {
        super(options);
        
        const config = window.CONFIG?.primitives?.rectangle || {};
        
        this.options = {
            color: options.color || config.defaultColor || 'rgba(255, 255, 255, 0.8)',
            lineWidth: options.lineWidth || config.defaultWidth || 2,
            fillColor: options.fillColor || config.defaultFillColor || 'rgba(255, 255, 255, 0.1)',
            lineStyle: options.lineStyle || 0, // 0 = solid, 1 = dotted, 2 = dashed
        };
    }
    
    get paneViews() {
        if (!this._paneViews) {
            this._paneViews = [new RectanglePaneView(this)];
        }
        return this._paneViews;
    }
}

/**
 * View class for rendering lines
 */
class LinePaneView {
    constructor(primitive) {
        this.primitive = primitive;
    }
    
    renderer() {
        return {
            draw: (target) => {
                const ctx = target.context;
                const points = this.primitive.points;
                
                if (!points || !points.x1 || !points.y1 || !points.x2 || !points.y2) {
                    return;
                }
                
                ctx.save();
                
                ctx.strokeStyle = this.primitive.options.color;
                ctx.lineWidth = this.primitive.options.lineWidth;
                
                // Set line style
                if (this.primitive.options.lineStyle === 1) {
                    ctx.setLineDash([2, 2]); // Dotted
                } else if (this.primitive.options.lineStyle === 2) {
                    ctx.setLineDash([6, 3]); // Dashed
                }
                
                ctx.beginPath();
                ctx.moveTo(points.x1, points.y1);
                ctx.lineTo(points.x2, points.y2);
                ctx.stroke();
                
                ctx.restore();
            }
        };
    }
    
    get zOrder() {
        return 'top';
    }
}

/**
 * View class for rendering rectangles
 */
class RectanglePaneView {
    constructor(primitive) {
        this.primitive = primitive;
    }
    
    renderer() {
        return {
            draw: (target) => {
                const ctx = target.context;
                const points = this.primitive.points;
                
                if (!points || !points.x1 || !points.y1 || !points.x2 || !points.y2) {
                    return;
                }
                
                ctx.save();
                
                // Calculate rectangle coordinates
                const x = Math.min(points.x1, points.x2);
                const y = Math.min(points.y1, points.y2);
                const width = Math.abs(points.x2 - points.x1);
                const height = Math.abs(points.y2 - points.y1);
                
                // Fill rectangle
                ctx.fillStyle = this.primitive.options.fillColor;
                ctx.fillRect(x, y, width, height);
                
                // Draw border
                ctx.strokeStyle = this.primitive.options.color;
                ctx.lineWidth = this.primitive.options.lineWidth;
                
                // Set line style
                if (this.primitive.options.lineStyle === 1) {
                    ctx.setLineDash([2, 2]); // Dotted
                } else if (this.primitive.options.lineStyle === 2) {
                    ctx.setLineDash([6, 3]); // Dashed
                }
                
                ctx.strokeRect(x, y, width, height);
                
                ctx.restore();
            }
        };
    }
    
    get zOrder() {
        return 'top';
    }
}

// Export for use in other modules
window.PrimitiveFactory = PrimitiveFactory;
window.LinePrimitive = LinePrimitive;
window.RectanglePrimitive = RectanglePrimitive;

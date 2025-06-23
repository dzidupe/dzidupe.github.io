(function() {
    // Store the original console methods
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;

    // Configuration
    const MAX_MESSAGES = 50;

    // Get the console element
    function getConsoleElement() {
        return document.getElementById('console-capture');
    }

    // Threshold for displaying any message (in USD), dynamic and updatable
    (function() {
        let _consoleMessageThreshold = 10000;
        Object.defineProperty(window, 'consoleMessageThreshold', {
            get() {
                return _consoleMessageThreshold;
            },
            set(value) {
                const num = parseFloat(value);
                if (!isNaN(num)) {
                    _consoleMessageThreshold = num;
                }
            },
            configurable: true
        });
        window.setConsoleMessageThreshold = function(value) {
            window.consoleMessageThreshold = value;
        };
        // Register cleanup for global reference
        if (window.CleanupManager && window.CleanupManager.registerCleanup) {
            window.CleanupManager.registerCleanup(() => { 
                delete window.consoleMessageThreshold;
                window.setConsoleMessageThreshold = undefined;
            });
        }
    })();

    // Helper to extract the largest number from a string (handles K/M suffixes, e.g., "$2.3K", "$1.5M")
    function extractLargestNumber(str) {
        // Match numbers with optional commas/decimals, optional $ prefix, and optional K/M suffix
        const matches = str.match(/(?:\$)?([\d,.]+)([kKmM]?)/g);
        if (!matches) return null;
        let max = 0;
        for (const match of matches) {
            // Extract number and suffix
            const numMatch = match.match(/(?:\$)?([\d,.]+)([kKmM]?)/);
            if (!numMatch) continue;
            let num = parseFloat(numMatch[1].replace(/,/g, ''));
            let suffix = numMatch[2] ? numMatch[2].toUpperCase() : '';
            if (suffix === 'K') num *= 1000;
            if (suffix === 'M') num *= 1000000;
            if (!isNaN(num) && num > max) max = num;
        }
        return max || null;
    }

    // Add a message to the DOM immediately, with threshold filtering for all messages
    function addMessage(text, type) {
        // Threshold filtering for all messages: only filter if a number is present and below threshold
        const value = extractLargestNumber(text);
        const threshold = window.consoleMessageThreshold || 0;

        if (value !== null) {
            if (value < threshold) {
                return;
            }
        }

        const consoleElement = getConsoleElement();
        if (!consoleElement) {
            return;
        }
        const messageElement = document.createElement('div');
        let className = 'liquidation-message';
        if (type) className += ' ' + type;
        messageElement.className = className;
        messageElement.textContent = text;
        // Insert at the top, after title if present
        const titleElement = consoleElement.querySelector('.console-capture-title');
        if (titleElement && titleElement.nextSibling) {
            consoleElement.insertBefore(messageElement, titleElement.nextSibling);
        } else if (titleElement) {
            consoleElement.appendChild(messageElement);
        } else {
            consoleElement.insertBefore(messageElement, consoleElement.firstChild);
        }
        // Remove old messages if over limit
        const messages = consoleElement.getElementsByClassName('liquidation-message');
        while (messages.length > MAX_MESSAGES) {
            messages[messages.length - 1].remove();
        }
        originalConsoleLog('[consoleCapture] Message added to DOM:', text);
    }

    // Expose addMessage globally for websocket integration
    window.consoleCaptureAddMessage = addMessage;
    // Register cleanup for global reference
    if (window.CleanupManager && window.CleanupManager.registerCleanup) {
        window.CleanupManager.registerCleanup(() => { window.consoleCaptureAddMessage = null; });
    }

    // Clear the console
    function clearConsole() {
        const consoleElement = getConsoleElement();
        if (consoleElement) {
            const titleElement = consoleElement.querySelector('.console-capture-title');
            if (titleElement) {
                while (titleElement.nextSibling) {
                    consoleElement.removeChild(titleElement.nextSibling);
                }
            } else {
                consoleElement.innerHTML = '';
            }
        }
    }
    window.clearChartConsole = clearConsole;
    // Register cleanup for global reference
    if (window.CleanupManager && window.CleanupManager.registerCleanup) {
        window.CleanupManager.registerCleanup(() => { window.clearChartConsole = null; });
    }

    // Optionally, override console methods (no-op for log capture)
    console.log = function() {
        originalConsoleLog.apply(console, arguments);
    };
    console.warn = function() {
        originalConsoleWarn.apply(console, arguments);
    };
    console.error = function() {
        originalConsoleError.apply(console, arguments);
    };

    // Initialize console on DOM ready
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(() => getConsoleElement(), 0);
    } else {
        const domHandler = () => setTimeout(() => getConsoleElement(), 0);
        document.addEventListener('DOMContentLoaded', domHandler);
        // Register cleanup for this event listener
        if (window.CleanupManager && window.CleanupManager.registerCleanup) {
            window.CleanupManager.registerCleanup(() => document.removeEventListener('DOMContentLoaded', domHandler));
        }
    }
})();
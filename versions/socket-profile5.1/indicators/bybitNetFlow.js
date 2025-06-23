// Bybit Net Flow (5m) Floating Indicator for Charts
// Author: Expert Engineer

(function () {
    // --- CONFIG ---
    const NET_FLOW_WINDOWS = [
        { label: '1m', ms: 1 * 60 * 1000 },
        { label: '5m', ms: 5 * 60 * 1000 },
        { label: '15m', ms: 15 * 60 * 1000 }
    ];
    let netFlowWindowIdx = 1; // Default to 5m
    let NET_FLOW_WINDOW_MS = NET_FLOW_WINDOWS[netFlowWindowIdx].ms;

    // --- STATE ---
    let netFlowTrades = []; // { time, side, price, size, dollarValue }

    // --- UI CREATION ---
    function createNetFlowWindow() {
        if (document.getElementById('bybit-net-flow-window')) {
            return;
        }
        window.createNetFlowWindow = createNetFlowWindow;
        const div = document.createElement('div');
        div.id = 'bybit-net-flow-window';
        div.className = 'net-flow-btn';
        div.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: flex-end;
            height: 32px;
            min-width: 90px;
            padding: 0 12px;
            font-size: 15px;
            font-family: inherit;
            /* background removed */
            color: #fff;
            border: none;
            border-radius: 4px;
            margin-left: 12px;
            margin-right: 0;
            box-shadow: none;
            position: absolute;
            right: 0;
            top: 0;
            pointer-events: auto;
            cursor: default;
            vertical-align: middle;
            z-index: 10;
            background: none;
        `;
        div.innerHTML = `
            <span style="font-size:13px;opacity:0.7;margin-right:6px;">NetFlow</span>
            <span id="bybit-net-flow" style="font-size:12px;font-family:'Arial',sans-serif;color:#BBBBBB;line-height:1.2;">$0</span>
            <button id="bybit-net-flow-window-btn" class="net-flow-window-btn" style="margin-left:8px;">1m</button>
        `;
        // Wait for pair selector if not present yet
        function tryAppend() {
            const pairSelector = document.querySelector('.pair-selector');
            if (pairSelector) {
                // Ensure parent is positioned relative for absolute positioning
                if (getComputedStyle(pairSelector).position === 'static') {
                    pairSelector.style.position = 'relative';
                }
                pairSelector.appendChild(div);
                // Add event listener for window button
                const windowBtn = document.getElementById('bybit-net-flow-window-btn');
                if (windowBtn) {
                    windowBtn.addEventListener('click', function() {
                        netFlowWindowIdx = (netFlowWindowIdx + 1) % NET_FLOW_WINDOWS.length;
                        NET_FLOW_WINDOW_MS = NET_FLOW_WINDOWS[netFlowWindowIdx].ms;
                        windowBtn.textContent = NET_FLOW_WINDOWS[netFlowWindowIdx].label;
                        // Remove trades outside the new window, aligned to global time boundary
                        const now = Date.now();
                        const boundary = now - (now % NET_FLOW_WINDOW_MS);
                        while (netFlowTrades.length && netFlowTrades[0].time < boundary - NET_FLOW_WINDOW_MS) {
                            netFlowTrades.shift();
                        }
                        updateNetFlowDisplay();
                    });
                }
            } else {
                setTimeout(tryAppend, 300);
            }
        }
        tryAppend();
    }

    // --- LOGIC ---
    function addBybitTrade(trade) {
        if (!trade || !trade.side || !trade.price || !trade.size) return;
        const now = Date.now();
        const dollarValue = trade.price * trade.size;
        netFlowTrades.push({
            time: now,
            side: trade.side,
            price: trade.price,
            size: trade.size,
            dollarValue
        });
        // Remove trades outside the window
        while (netFlowTrades.length && netFlowTrades[0].time < now - NET_FLOW_WINDOW_MS) {
            netFlowTrades.shift();
        }
        updateNetFlowDisplay();
    }

    function updateNetFlowDisplay() {
        let buy = 0, sell = 0;
        for (const t of netFlowTrades) {
            if (t.side === 'Buy') buy += t.dollarValue;
            else if (t.side === 'Sell') sell += t.dollarValue;
        }
        const net = buy - sell;
        const el = document.getElementById('bybit-net-flow');
        if (el) {
            el.textContent = net.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
            el.style.color = net > 0 ? "rgba(0, 255, 255, 0.75)" : net < 0 ? "rgba(255, 85, 85, 0.75)" : "#BBBBBB";
            el.style.fontSize = "12px";
            el.style.fontFamily = "'Arial',sans-serif";
            el.style.lineHeight = "1.2";
        }
    }

    // --- EXPORT/HANDLER HOOK ---
    // Attach to window for integration with Bybit trade stream
    window.addBybitTrade = addBybitTrade;

    // Reset function to clear state and UI when chart switches
    window.resetNetFlow = function() {
        // Fully reset state and UI for netflow on chart switch
        netFlowTrades = [];
        netFlowWindowIdx = 1; // Reset to 5m
        NET_FLOW_WINDOW_MS = NET_FLOW_WINDOWS[netFlowWindowIdx].ms;
        // Reset UI to default
        const el = document.getElementById('bybit-net-flow');
        if (el) {
            el.textContent = "$0";
            el.style.color = "#BBBBBB";
        }
        const windowBtn = document.getElementById('bybit-net-flow-window-btn');
        if (windowBtn) {
            windowBtn.textContent = NET_FLOW_WINDOWS[netFlowWindowIdx].label;
        }
    };

    // --- INIT ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            console.log("[bybitNetFlow] DOMContentLoaded fired");
            createNetFlowWindow();
        });
    } else {
        createNetFlowWindow();
    }
})();

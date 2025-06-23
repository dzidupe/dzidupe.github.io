```socket-profile4.2/utils/shared/circuitBreakerManager.js#L1-70
// circuitBreakerManager.js - Shared utility for circuit breaker logic

const DEFAULT_CONFIG = {
    circuitBreakerThreshold: 5, // Failures before opening circuit
    circuitResetTimeout: 30000, // Time before trying again (ms)
};

class CircuitBreakerManager {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.circuits = new Map();
        // Clean up old circuits periodically
        setInterval(() => this.cleanCircuits(), 60 * 1000);
    }

    getCircuit(name) {
        if (!this.circuits.has(name)) {
            this.circuits.set(name, {
                failures: 0,
                lastFailure: 0,
                state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
                lastStateChange: Date.now()
            });
        }
        return this.circuits.get(name);
    }

    isCircuitOpen(name) {
        const circuit = this.getCircuit(name);
        const now = Date.now();

        if (circuit.state === 'OPEN') {
            if (now - circuit.lastStateChange > this.config.circuitResetTimeout) {
                circuit.state = 'HALF_OPEN';
                circuit.lastStateChange = now;
                console.log(`Circuit breaker for ${name} half-open, allowing test request`);
                return false;
            }
            return true;
        }
        return false;
    }

    recordSuccess(name) {
        const circuit = this.getCircuit(name);
        if (circuit.state === 'HALF_OPEN') {
            circuit.failures = 0;
            circuit.state = 'CLOSED';
            circuit.lastStateChange = Date.now();
            console.log(`Circuit breaker for ${name} closed after successful test request`);
        } else if (circuit.state === 'CLOSED') {
            circuit.failures = 0;
        }
    }

    recordFailure(name) {
        const circuit = this.getCircuit(name);
        const now = Date.now();
        circuit.lastFailure = now;

        if (circuit.state === 'HALF_OPEN') {
            circuit.state = 'OPEN';
            circuit.lastStateChange = now;
            console.warn(`Circuit breaker for ${name} reopened after failed test request`);
        } else if (circuit.state === 'CLOSED') {
            circuit.failures++;
            if (circuit.failures >= this.config.circuitBreakerThreshold) {
                circuit.state = 'OPEN';
                circuit.lastStateChange = now;
                console.warn(`Circuit breaker for ${name} opened after ${circuit.failures} consecutive failures`);
            }
        }
    }

    cleanCircuits() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        for (const [name, circuit] of this.circuits.entries()) {
            if (circuit.state === 'CLOSED' &&
                now - circuit.lastFailure > maxAge &&
                now - circuit.lastStateChange > maxAge) {
                this.circuits.delete(name);
            }
        }
    }
}

export default CircuitBreakerManager;
```
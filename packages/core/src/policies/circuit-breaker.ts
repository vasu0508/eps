// Circuit breaker state machine implementation

import type { CircuitBreaker, CircuitBreakerOptions, CircuitState } from "../types.js";
import { CircuitOpenError } from "../errors.js";

/**
 * Internal state tracked per circuit breaker instance.
 */
interface CircuitBreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  lastStateChangeTime: number;
  halfOpenProbes: number;
}

/**
 * Static registry that persists circuit breaker state across executions,
 * keyed by service identifier.
 */
const circuitRegistry = new Map<string, CircuitBreakerState>();

/**
 * Creates a CircuitBreaker for the given service identifier.
 * State persists across calls via the static registry.
 *
 * @param serviceName - Unique identifier for the service being protected
 * @param options - Circuit breaker configuration
 */
export function createCircuitBreaker(
  serviceName: string,
  options: CircuitBreakerOptions
): CircuitBreaker {
  const failureThreshold = Math.min(100, Math.max(1, options.failureThreshold));
  const resetTimeout = Math.min(600000, Math.max(100, options.resetTimeout));
  const halfOpenMax = Math.min(10, Math.max(1, options.halfOpenMax ?? 1));
  const onStateChange = options.onStateChange;

  // Retrieve or initialize persisted state
  if (!circuitRegistry.has(serviceName)) {
    circuitRegistry.set(serviceName, {
      state: "closed",
      consecutiveFailures: 0,
      lastStateChangeTime: Date.now(),
      halfOpenProbes: 0,
    });
  }

  function getState(): CircuitBreakerState {
    return circuitRegistry.get(serviceName)!;
  }

  function transitionTo(newState: CircuitState): void {
    const s = getState();
    const from = s.state;
    if (from === newState) return;
    s.state = newState;
    s.lastStateChangeTime = Date.now();
    if (newState === "half-open") {
      s.halfOpenProbes = 0;
    }
    onStateChange?.(from, newState);
  }

  function checkOpenTimeout(): void {
    const s = getState();
    if (s.state === "open") {
      const elapsed = Date.now() - s.lastStateChangeTime;
      if (elapsed >= resetTimeout) {
        transitionTo("half-open");
      }
    }
  }

  function getRemainingMs(): number {
    const s = getState();
    const elapsed = Date.now() - s.lastStateChangeTime;
    return Math.max(0, resetTimeout - elapsed);
  }

  const breaker: CircuitBreaker = {
    get state(): CircuitState {
      checkOpenTimeout();
      return getState().state;
    },

    async execute<T>(fn: () => Promise<T>): Promise<T> {
      // Check if open state has timed out
      checkOpenTimeout();
      const s = getState();

      if (s.state === "open") {
        throw new CircuitOpenError(serviceName, getRemainingMs());
      }

      if (s.state === "half-open") {
        if (s.halfOpenProbes >= halfOpenMax) {
          throw new CircuitOpenError(serviceName, getRemainingMs());
        }
        s.halfOpenProbes++;

        try {
          const result = await fn();
          breaker.recordSuccess();
          return result;
        } catch (error) {
          breaker.recordFailure();
          throw error;
        }
      }

      // Closed state: execute normally
      try {
        const result = await fn();
        breaker.recordSuccess();
        return result;
      } catch (error) {
        breaker.recordFailure();
        throw error;
      }
    },

    recordSuccess(): void {
      const s = getState();

      if (s.state === "half-open") {
        // Probe succeeded: transition to closed
        s.consecutiveFailures = 0;
        transitionTo("closed");
      } else if (s.state === "closed") {
        // Reset failure count on success in closed state
        s.consecutiveFailures = 0;
      }
    },

    recordFailure(): void {
      const s = getState();

      if (s.state === "half-open") {
        // Probe failed: transition back to open, reject remaining probes
        s.halfOpenProbes = halfOpenMax; // prevent further probes
        transitionTo("open");
      } else if (s.state === "closed") {
        s.consecutiveFailures++;
        if (s.consecutiveFailures >= failureThreshold) {
          transitionTo("open");
        }
      }
    },

    reset(): void {
      const s = getState();
      s.consecutiveFailures = 0;
      s.halfOpenProbes = 0;
      if (s.state !== "closed") {
        transitionTo("closed");
      }
    },
  };

  return breaker;
}

/**
 * Clears all circuit breaker state from the registry.
 * Useful for testing.
 */
export function clearCircuitBreakerRegistry(): void {
  circuitRegistry.clear();
}

/**
 * Removes a single service's circuit breaker state from the registry.
 * Useful for testing.
 */
export function removeCircuitBreakerState(serviceName: string): void {
  circuitRegistry.delete(serviceName);
}

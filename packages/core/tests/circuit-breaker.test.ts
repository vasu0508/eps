import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createCircuitBreaker,
  clearCircuitBreakerRegistry,
} from "../src/policies/circuit-breaker.js";
import { CircuitOpenError } from "../src/errors.js";
import type { CircuitBreakerOptions } from "../src/types.js";

describe("Circuit Breaker", () => {
  beforeEach(() => {
    clearCircuitBreakerRegistry();
    vi.restoreAllMocks();
  });

  describe("closed state", () => {
    it("starts in closed state", () => {
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 5,
        resetTimeout: 30000,
      });
      expect(cb.state).toBe("closed");
    });

    it("executes handler normally in closed state", async () => {
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 5,
        resetTimeout: 30000,
      });
      const result = await cb.execute(async () => "ok");
      expect(result).toBe("ok");
    });

    it("resets failure count on success", async () => {
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 3,
        resetTimeout: 30000,
      });

      // Cause 2 failures (below threshold)
      for (let i = 0; i < 2; i++) {
        await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      }

      // Success resets the counter
      await cb.execute(async () => "ok");

      // 2 more failures should not trip the breaker (counter was reset)
      for (let i = 0; i < 2; i++) {
        await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      }

      expect(cb.state).toBe("closed");
    });

    it("increments failure count on handler error", async () => {
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 2,
        resetTimeout: 30000,
      });

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb.state).toBe("closed");

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb.state).toBe("open");
    });

    it("transitions to open when failureThreshold is reached", async () => {
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 3,
        resetTimeout: 30000,
        onStateChange,
      });

      for (let i = 0; i < 3; i++) {
        await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      }

      expect(cb.state).toBe("open");
      expect(onStateChange).toHaveBeenCalledWith("closed", "open");
    });
  });

  describe("open state", () => {
    it("rejects with CircuitOpenError without invoking handler", async () => {
      const cb = createCircuitBreaker("payment-api", {
        failureThreshold: 1,
        resetTimeout: 30000,
      });

      // Trip the breaker
      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb.state).toBe("open");

      // Verify it rejects without calling handler
      const handler = vi.fn(async () => "result");
      await expect(cb.execute(handler)).rejects.toThrow(CircuitOpenError);
      expect(handler).not.toHaveBeenCalled();
    });

    it("CircuitOpenError contains serviceName and remainingMs", async () => {
      const cb = createCircuitBreaker("payment-api", {
        failureThreshold: 1,
        resetTimeout: 5000,
      });

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});

      try {
        await cb.execute(async () => "ok");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        const coe = error as CircuitOpenError;
        expect(coe.serviceName).toBe("payment-api");
        expect(coe.remainingMs).toBeGreaterThan(0);
        expect(coe.remainingMs).toBeLessThanOrEqual(5000);
      }
    });

    it("transitions to half-open after resetTimeout", async () => {
      vi.useFakeTimers();
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 1,
        resetTimeout: 1000,
        onStateChange,
      });

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb.state).toBe("open");

      vi.advanceTimersByTime(1000);
      expect(cb.state).toBe("half-open");
      expect(onStateChange).toHaveBeenCalledWith("open", "half-open");
      vi.useRealTimers();
    });
  });

  describe("half-open state", () => {
    it("allows up to halfOpenMax concurrent probes", async () => {
      vi.useFakeTimers();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMax: 2,
      });

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      vi.advanceTimersByTime(1000);
      expect(cb.state).toBe("half-open");
      vi.useRealTimers();

      // First two probes should be allowed
      const result1 = cb.execute(async () => "probe1");
      const result2 = cb.execute(async () => "probe2");

      // Third probe should be rejected
      await expect(cb.execute(async () => "probe3")).rejects.toThrow(CircuitOpenError);

      expect(await result1).toBe("probe1");
      expect(await result2).toBe("probe2");
    });

    it("transitions to closed on probe success", async () => {
      vi.useFakeTimers();
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 1,
        resetTimeout: 1000,
        onStateChange,
      });

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      vi.advanceTimersByTime(1000);

      expect(cb.state).toBe("half-open");

      await cb.execute(async () => "success");
      expect(cb.state).toBe("closed");
      expect(onStateChange).toHaveBeenCalledWith("half-open", "closed");
      vi.useRealTimers();
    });

    it("resets failure count when transitioning to closed", async () => {
      vi.useFakeTimers();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      }
      vi.advanceTimersByTime(1000);

      // Probe success -> closed
      await cb.execute(async () => "ok");
      expect(cb.state).toBe("closed");

      // Now needs 3 failures again to trip
      for (let i = 0; i < 2; i++) {
        await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      }
      expect(cb.state).toBe("closed");
      vi.useRealTimers();
    });

    it("transitions back to open on probe failure", async () => {
      vi.useFakeTimers();
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 1,
        resetTimeout: 1000,
        onStateChange,
      });

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      vi.advanceTimersByTime(1000);

      expect(cb.state).toBe("half-open");

      await cb.execute(async () => { throw new Error("probe fail"); }).catch(() => {});
      expect(cb.state).toBe("open");
      expect(onStateChange).toHaveBeenCalledWith("half-open", "open");
      vi.useRealTimers();
    });
  });

  describe("onStateChange callback", () => {
    it("fires on every state transition", async () => {
      vi.useFakeTimers();
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 1,
        resetTimeout: 1000,
        onStateChange,
      });

      // closed -> open
      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(onStateChange).toHaveBeenCalledWith("closed", "open");

      // open -> half-open
      vi.advanceTimersByTime(1000);
      // Access state to trigger check
      void cb.state;
      expect(onStateChange).toHaveBeenCalledWith("open", "half-open");
      vi.useRealTimers();

      // half-open -> closed
      await cb.execute(async () => "ok");
      expect(onStateChange).toHaveBeenCalledWith("half-open", "closed");

      expect(onStateChange).toHaveBeenCalledTimes(3);
    });
  });

  describe("state persistence", () => {
    it("persists state across multiple createCircuitBreaker calls with same serviceName", async () => {
      const cb1 = createCircuitBreaker("shared-service", {
        failureThreshold: 2,
        resetTimeout: 30000,
      });

      // Cause 1 failure
      await cb1.execute(async () => { throw new Error("fail"); }).catch(() => {});

      // Create a new breaker instance for the same service
      const cb2 = createCircuitBreaker("shared-service", {
        failureThreshold: 2,
        resetTimeout: 30000,
      });

      // 1 more failure should trip the breaker since state is shared
      await cb2.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb2.state).toBe("open");
    });

    it("maintains separate state for different service names", async () => {
      const cb1 = createCircuitBreaker("service-a", {
        failureThreshold: 1,
        resetTimeout: 30000,
      });
      const cb2 = createCircuitBreaker("service-b", {
        failureThreshold: 1,
        resetTimeout: 30000,
      });

      // Trip service-a
      await cb1.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb1.state).toBe("open");

      // service-b should still be closed
      expect(cb2.state).toBe("closed");
    });
  });

  describe("configuration validation", () => {
    it("clamps failureThreshold to min 1", async () => {
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 0,
        resetTimeout: 30000,
      });

      // With threshold clamped to 1, a single failure should open it
      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb.state).toBe("open");
    });

    it("clamps failureThreshold to max 100", async () => {
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 200,
        resetTimeout: 30000,
      });

      // Should use 100 as threshold - won't trip with fewer failures
      for (let i = 0; i < 99; i++) {
        await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      }
      expect(cb.state).toBe("closed");

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb.state).toBe("open");
    });

    it("uses default halfOpenMax of 1", async () => {
      vi.useFakeTimers();
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 1,
        resetTimeout: 1000,
      });

      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      vi.advanceTimersByTime(1000);
      expect(cb.state).toBe("half-open");
      vi.useRealTimers();

      // First probe allowed, second rejected
      const probe1 = cb.execute(async () => "ok");
      await expect(cb.execute(async () => "rejected")).rejects.toThrow(CircuitOpenError);
      await probe1;
    });
  });

  describe("reset", () => {
    it("resets to closed state and clears failure count", async () => {
      const cb = createCircuitBreaker("test-service", {
        failureThreshold: 2,
        resetTimeout: 30000,
      });

      // Trip the breaker
      for (let i = 0; i < 2; i++) {
        await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      }
      expect(cb.state).toBe("open");

      cb.reset();
      expect(cb.state).toBe("closed");

      // Should need full threshold again
      await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
      expect(cb.state).toBe("closed");
    });
  });
});

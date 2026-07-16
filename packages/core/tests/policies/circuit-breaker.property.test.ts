import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import {
  createCircuitBreaker,
  clearCircuitBreakerRegistry,
} from "../../src/policies/circuit-breaker.js";
import { CircuitOpenError } from "../../src/errors.js";

/**
 * Property 9: Circuit Breaker State Machine
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9
 */
describe("Property 9: Circuit Breaker State Machine", () => {
  beforeEach(() => {
    clearCircuitBreakerRegistry();
  });

  // Arbitrary for valid failure threshold (1-100)
  const failureThresholdArb = fc.integer({ min: 1, max: 100 });

  // Arbitrary for valid resetTimeout (100-600000)
  const resetTimeoutArb = fc.integer({ min: 100, max: 600000 });

  // Arbitrary for valid halfOpenMax (1-10)
  const halfOpenMaxArb = fc.integer({ min: 1, max: 10 });

  // Arbitrary for a sequence of success/failure operations (true = success, false = failure)
  const operationSequenceArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 50 });

  // Counter for unique service names to avoid registry collisions
  let serviceCounter = 0;
  function uniqueService(): string {
    return `svc-prop-${Date.now()}-${serviceCounter++}`;
  }

  /**
   * Property 1: State starts as "closed" for any valid configuration
   * Validates: Requirements 6.1
   */
  it("always starts in closed state for any valid configuration", () => {
    fc.assert(
      fc.property(
        failureThresholdArb,
        resetTimeoutArb,
        halfOpenMaxArb,
        (threshold, timeout, halfOpenMax) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: threshold,
            resetTimeout: timeout,
            halfOpenMax,
          });
          expect(cb.state).toBe("closed");
        }
      )
    );
  });

  /**
   * Property 2: For any failureThreshold T (1-100), exactly T consecutive failures
   * transition from closed to open
   * Validates: Requirements 6.3
   */
  it("transitions from closed to open after exactly failureThreshold consecutive failures", async () => {
    await fc.assert(
      fc.asyncProperty(
        failureThresholdArb,
        async (threshold) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: threshold,
            resetTimeout: 600000,
          });

          // T-1 failures should keep it closed
          for (let i = 0; i < threshold - 1; i++) {
            await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
            expect(cb.state).toBe("closed");
          }

          // The T-th failure should transition to open
          await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
          expect(cb.state).toBe("open");
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * Property 3: Success in closed state always resets the failure counter
   * (partial failures followed by success don't accumulate)
   * Validates: Requirements 6.2
   */
  it("success in closed state resets failure counter, preventing accumulation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        async (threshold, repetitions) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: threshold,
            resetTimeout: 600000,
          });

          // Repeatedly do (threshold-1) failures followed by 1 success
          // This should never trip the breaker because each success resets the counter
          for (let rep = 0; rep < repetitions; rep++) {
            for (let i = 0; i < threshold - 1; i++) {
              await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
            }
            // Success resets the counter
            await cb.execute(async () => "ok");
            expect(cb.state).toBe("closed");
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 4: In open state, execute() always throws CircuitOpenError without invoking the handler
   * Validates: Requirements 6.4
   */
  it("in open state, execute always throws CircuitOpenError without invoking handler", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 20 }),
        async (threshold, callCount) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: threshold,
            resetTimeout: 600000,
          });

          // Trip the breaker
          for (let i = 0; i < threshold; i++) {
            await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
          }
          expect(cb.state).toBe("open");

          // Every subsequent call should throw CircuitOpenError without invoking handler
          for (let i = 0; i < callCount; i++) {
            let handlerCalled = false;
            try {
              await cb.execute(async () => {
                handlerCalled = true;
                return "should not reach";
              });
              expect.fail("should have thrown");
            } catch (err) {
              expect(err).toBeInstanceOf(CircuitOpenError);
              expect(handlerCalled).toBe(false);
            }
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 5: After transition to open, remainingMs in CircuitOpenError is always <= resetTimeout
   * Validates: Requirements 6.4, 6.5
   */
  it("remainingMs in CircuitOpenError is always <= resetTimeout", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 100, max: 60000 }),
        async (threshold, timeout) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: threshold,
            resetTimeout: timeout,
          });

          // Trip the breaker
          for (let i = 0; i < threshold; i++) {
            await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
          }
          expect(cb.state).toBe("open");

          // Check remainingMs
          try {
            await cb.execute(async () => "ok");
            expect.fail("should have thrown");
          } catch (err) {
            expect(err).toBeInstanceOf(CircuitOpenError);
            const coe = err as CircuitOpenError;
            expect(coe.remainingMs).toBeGreaterThanOrEqual(0);
            expect(coe.remainingMs).toBeLessThanOrEqual(timeout);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 6: In half-open state, at most halfOpenMax probes are allowed
   * (additional calls throw CircuitOpenError)
   * Validates: Requirements 6.6
   */
  it("in half-open state, at most halfOpenMax probes are allowed", async () => {
    await fc.assert(
      fc.asyncProperty(
        halfOpenMaxArb,
        fc.integer({ min: 1, max: 5 }),
        async (halfOpenMax, extraCalls) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: 1,
            resetTimeout: 100,
            halfOpenMax,
          });

          // Trip the breaker
          await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
          expect(cb.state).toBe("open");

          // Wait for resetTimeout to elapse so it transitions to half-open
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(cb.state).toBe("half-open");

          // Launch halfOpenMax probes that don't resolve immediately
          // (keep them pending so they occupy probe slots)
          const resolvers: Array<() => void> = [];
          const probePromises: Promise<unknown>[] = [];
          for (let i = 0; i < halfOpenMax; i++) {
            probePromises.push(
              cb.execute(() => new Promise<string>((resolve) => {
                resolvers.push(() => resolve(`probe-${i}`));
              }))
            );
          }

          // Additional calls beyond halfOpenMax should be rejected
          for (let i = 0; i < extraCalls; i++) {
            await expect(
              cb.execute(async () => "extra")
            ).rejects.toBeInstanceOf(CircuitOpenError);
          }

          // Resolve all probes to let them complete
          resolvers.forEach((r) => r());
          await Promise.all(probePromises);
        }
      ),
      { numRuns: 15 }
    );
  });

  /**
   * Property 7: Probe success in half-open always transitions to closed
   * Validates: Requirements 6.7
   */
  it("probe success in half-open always transitions to closed", async () => {
    await fc.assert(
      fc.asyncProperty(
        halfOpenMaxArb,
        async (halfOpenMax) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: 1,
            resetTimeout: 100,
            halfOpenMax,
          });

          // Trip the breaker
          await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
          expect(cb.state).toBe("open");

          // Wait for half-open
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(cb.state).toBe("half-open");

          // Successful probe should transition to closed
          await cb.execute(async () => "success");
          expect(cb.state).toBe("closed");
        }
      ),
      { numRuns: 15 }
    );
  });

  /**
   * Property 8: Probe failure in half-open always transitions back to open
   * Validates: Requirements 6.8
   */
  it("probe failure in half-open always transitions back to open", async () => {
    await fc.assert(
      fc.asyncProperty(
        halfOpenMaxArb,
        async (halfOpenMax) => {
          const cb = createCircuitBreaker(uniqueService(), {
            failureThreshold: 1,
            resetTimeout: 100,
            halfOpenMax,
          });

          // Trip the breaker
          await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
          expect(cb.state).toBe("open");

          // Wait for half-open
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(cb.state).toBe("half-open");

          // Failed probe should transition back to open
          await cb.execute(async () => { throw new Error("probe fail"); }).catch(() => {});
          expect(cb.state).toBe("open");
        }
      ),
      { numRuns: 15 }
    );
  });

  /**
   * Property 9: State is deterministic: same sequence of success/failure operations
   * always produces the same state
   * Validates: Requirements 6.1, 6.2, 6.3
   */
  it("same sequence of operations always produces the same final state", async () => {
    await fc.assert(
      fc.asyncProperty(
        operationSequenceArb,
        fc.integer({ min: 1, max: 10 }),
        async (ops, threshold) => {
          // Run the same sequence twice with different service names and verify identical final state
          const runSequence = async (suffix: string) => {
            const cb = createCircuitBreaker(uniqueService() + suffix, {
              failureThreshold: threshold,
              resetTimeout: 600000, // large enough to not trigger timeout transitions
            });

            for (const isSuccess of ops) {
              if (cb.state === "open") {
                // In open state, all calls throw CircuitOpenError — just catch it
                await cb.execute(async () => "x").catch(() => {});
              } else {
                if (isSuccess) {
                  await cb.execute(async () => "ok");
                } else {
                  await cb.execute(async () => { throw new Error("fail"); }).catch(() => {});
                }
              }
            }

            return cb.state;
          };

          const state1 = await runSequence("-a");
          const state2 = await runSequence("-b");

          expect(state1).toBe(state2);
        }
      ),
      { numRuns: 50 }
    );
  });
});

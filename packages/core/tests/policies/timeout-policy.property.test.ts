import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createTimeoutPolicy } from "../../src/policies/timeout-policy.js";
import { TimeoutError, CancellationError } from "../../src/errors.js";

/**
 * Property-based tests for the Timeout Policy.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
 *
 * Property 8 (Timeout Enforcement): For any timeout value t, execution
 * duration is bounded by t + epsilon.
 */
describe("TimeoutPolicy - Property Tests", () => {
  // Epsilon accounts for timer scheduling variance
  const EPSILON = 100;

  describe("Property 8: Timeout Enforcement — execution duration <= t + epsilon", () => {
    it("rejects within t + epsilon when fn takes longer than t", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 200 }),
          async (timeoutMs) => {
            const policy = createTimeoutPolicy({ ms: timeoutMs });
            const controller = new AbortController();

            // fn that takes much longer than the timeout
            const slowFn = () =>
              new Promise<string>((resolve) =>
                setTimeout(() => resolve("late"), timeoutMs + 500)
              );

            const start = Date.now();
            try {
              await policy.wrap(slowFn, controller.signal);
              // Should never reach here
              expect.fail("Expected TimeoutError to be thrown");
            } catch (error) {
              const elapsed = Date.now() - start;
              expect(error).toBeInstanceOf(TimeoutError);
              // The rejection should happen within t + epsilon
              expect(elapsed).toBeLessThanOrEqual(timeoutMs + EPSILON);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe("Property: Successful resolution when fn completes before timeout", () => {
    it("returns the result when fn resolves in time < t", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 50, max: 200 }),
          fc.anything(),
          async (timeoutMs, value) => {
            const policy = createTimeoutPolicy({ ms: timeoutMs });
            const controller = new AbortController();

            // fn that resolves immediately (well before timeout)
            const fastFn = () => Promise.resolve(value);

            const result = await policy.wrap(fastFn, controller.signal);
            expect(result).toBe(value);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Property: TimeoutError has correct ms value", () => {
    it("rejects with TimeoutError containing the configured ms", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 200 }),
          async (timeoutMs) => {
            const policy = createTimeoutPolicy({ ms: timeoutMs });
            const controller = new AbortController();

            const slowFn = () =>
              new Promise<string>((resolve) =>
                setTimeout(() => resolve("late"), timeoutMs + 500)
              );

            try {
              await policy.wrap(slowFn, controller.signal);
              expect.fail("Expected TimeoutError to be thrown");
            } catch (error) {
              expect(error).toBeInstanceOf(TimeoutError);
              expect((error as TimeoutError).ms).toBe(timeoutMs);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe("Property: Immediate rejection when signal is already aborted (CancellationError)", () => {
    it("rejects immediately with CancellationError when signal is pre-aborted", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 200 }),
          async (timeoutMs) => {
            const policy = createTimeoutPolicy({ ms: timeoutMs });
            const controller = new AbortController();
            controller.abort("pre-aborted");

            const start = Date.now();
            try {
              await policy.wrap(
                () => new Promise<string>((resolve) => setTimeout(() => resolve("value"), 1000)),
                controller.signal
              );
              expect.fail("Expected CancellationError to be thrown");
            } catch (error) {
              const elapsed = Date.now() - start;
              expect(error).toBeInstanceOf(CancellationError);
              // Should be nearly immediate (well under the timeout)
              expect(elapsed).toBeLessThan(50);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Property: Readonly ms property matches configured value", () => {
    it("exposes the configured timeout as a readonly ms property", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 60000 }),
          (timeoutMs) => {
            const policy = createTimeoutPolicy({ ms: timeoutMs });
            expect(policy.ms).toBe(timeoutMs);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

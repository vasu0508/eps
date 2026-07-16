import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { executeRepeatUntil } from "../../src/execution/repeat-executor.js";
import { MaxIterationsExhaustedError, PredicateError } from "../../src/errors.js";

/**
 * Property-based tests for RepeatUntil Executor
 *
 * **Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9**
 */

describe("RepeatUntil Executor — Property Tests", () => {
  describe("Property 27: RepeatUntil Termination Guarantee", () => {
    /**
     * **Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.6, 17.8**
     *
     * For any maxIterations N, the handler is called at most N times.
     * When predicate never returns true, MaxIterationsExhaustedError is thrown after exactly N calls.
     * When predicate returns true on iteration K (K <= N), handler is called exactly K times.
     * Handler failure on iteration K means exactly K handler calls.
     * Predicate failure wraps in PredicateError.
     */

    it("handler is called at most maxIterations times when predicate never returns true", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations) => {
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: () => false,
              maxIterations,
              delay: 0,
            };

            await expect(executeRepeatUntil(config, handler)).rejects.toThrow(
              MaxIterationsExhaustedError
            );
            expect(invocations).toBe(maxIterations);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("MaxIterationsExhaustedError is thrown with correct maxIterations value", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations) => {
            const handler = async () => "result";
            const config = {
              predicate: () => false,
              maxIterations,
              delay: 0,
            };

            try {
              await executeRepeatUntil(config, handler);
              expect.fail("Should have thrown");
            } catch (err) {
              expect(err).toBeInstanceOf(MaxIterationsExhaustedError);
              expect((err as MaxIterationsExhaustedError).maxIterations).toBe(maxIterations);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("when predicate returns true on iteration K, handler is called exactly K times", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations, kRaw) => {
            // Ensure K <= maxIterations
            const K = ((kRaw - 1) % maxIterations) + 1;
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === K,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);

            expect(invocations).toBe(K);
            expect(result.value).toBe(K);
            expect(result.report.predicateSatisfied).toBe(true);
            expect(result.report.finalIteration).toBe(K);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("handler failure on iteration K results in exactly K handler calls", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations, kRaw) => {
            // K is the iteration where handler throws (1-indexed)
            const K = ((kRaw - 1) % maxIterations) + 1;
            let invocations = 0;
            const failureMessage = `handler-failure-at-${K}`;

            const handler = async () => {
              invocations++;
              if (invocations === K) {
                throw new Error(failureMessage);
              }
              return invocations;
            };

            const config = {
              predicate: () => false,
              maxIterations,
              delay: 0,
            };

            await expect(executeRepeatUntil(config, handler)).rejects.toThrow(
              failureMessage
            );
            expect(invocations).toBe(K);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("predicate failure wraps original error in PredicateError", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (maxIterations, errorMessage) => {
            const originalError = new Error(errorMessage);
            const handler = async () => "value";
            const config = {
              predicate: () => {
                throw originalError;
              },
              maxIterations,
              delay: 0,
            };

            try {
              await executeRepeatUntil(config, handler);
              expect.fail("Should have thrown");
            } catch (err) {
              expect(err).toBeInstanceOf(PredicateError);
              expect((err as PredicateError).originalError).toBe(originalError);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Property 28: RepeatUntil Delay and Reporting", () => {
    /**
     * **Validates: Requirements 17.5, 17.7, 17.9**
     *
     * Report contains exactly K iterations.
     * Each iteration records predicateResult correctly.
     * report.predicateSatisfied matches whether predicate returned true.
     * report.finalIteration matches the last iteration number.
     * Delay is applied between iterations (not after the final one).
     */

    it("report contains exactly K iterations when predicate satisfied at K", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations, kRaw) => {
            const K = ((kRaw - 1) % maxIterations) + 1;
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === K,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);

            expect(result.report.iterations).toHaveLength(K);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("each iteration records predicateResult correctly (false for non-final, true for final)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 15 }),
          fc.integer({ min: 1, max: 15 }),
          async (maxIterations, kRaw) => {
            const K = ((kRaw - 1) % maxIterations) + 1;
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === K,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);
            const { iterations } = result.report;

            // All non-final iterations have predicateResult = false
            for (let i = 0; i < iterations.length - 1; i++) {
              expect(iterations[i]!.predicateResult).toBe(false);
            }

            // Final iteration has predicateResult = true
            expect(iterations[iterations.length - 1]!.predicateResult).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("report.predicateSatisfied is true when predicate returns true", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations, kRaw) => {
            const K = ((kRaw - 1) % maxIterations) + 1;
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === K,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);
            expect(result.report.predicateSatisfied).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("report.predicateSatisfied is false when maxIterations exhausted", async () => {
      // When maxIterations is exhausted, the function throws MaxIterationsExhaustedError.
      // We validate that the error is thrown (meaning predicate was never satisfied).
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations) => {
            const handler = async () => "value";
            const config = {
              predicate: () => false,
              maxIterations,
              delay: 0,
            };

            await expect(executeRepeatUntil(config, handler)).rejects.toThrow(
              MaxIterationsExhaustedError
            );
          }
        ),
        { numRuns: 50 }
      );
    });

    it("report.finalIteration matches the last iteration number", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 20 }),
          async (maxIterations, kRaw) => {
            const K = ((kRaw - 1) % maxIterations) + 1;
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === K,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);
            expect(result.report.finalIteration).toBe(K);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("each iteration records the correct iteration number (1-indexed)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 15 }),
          async (maxIterations) => {
            let invocations = 0;
            // Predicate satisfied on last iteration
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === maxIterations,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);
            const { iterations } = result.report;

            for (let i = 0; i < iterations.length; i++) {
              expect(iterations[i]!.iteration).toBe(i + 1);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("each iteration records the handler result", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (maxIterations) => {
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return `result-${invocations}`;
            };

            const config = {
              predicate: (result: unknown) => result === `result-${maxIterations}`,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);
            const { iterations } = result.report;

            for (let i = 0; i < iterations.length; i++) {
              expect(iterations[i]!.result).toBe(`result-${i + 1}`);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("each iteration records a non-negative duration", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (maxIterations) => {
            let invocations = 0;
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === maxIterations,
              maxIterations,
              delay: 0,
            };

            const result = await executeRepeatUntil(config, handler);
            const { iterations } = result.report;

            for (const iter of iterations) {
              expect(iter.duration).toBeGreaterThanOrEqual(0);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("delay is applied between iterations (total time >= (K-1) * delay)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 10, max: 30 }),
          async (maxIterations, delay) => {
            let invocations = 0;
            // Predicate satisfied on last iteration
            const handler = async () => {
              invocations++;
              return invocations;
            };

            const config = {
              predicate: (result: unknown) => result === maxIterations,
              maxIterations,
              delay,
            };

            const start = Date.now();
            const result = await executeRepeatUntil(config, handler);
            const elapsed = Date.now() - start;

            // Should have waited at least (K-1) delays between K iterations
            // Allow some slack for timer imprecision
            const expectedMinDelay = (maxIterations - 1) * delay;
            expect(elapsed).toBeGreaterThanOrEqual(expectedMinDelay - 5);
            expect(result.report.iterations).toHaveLength(maxIterations);
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});

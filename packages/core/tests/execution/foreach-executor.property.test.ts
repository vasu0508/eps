import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { executeForEach } from "../../src/execution/foreach-executor.js";
import type { ExecutionContext } from "../../src/types.js";
import type { ForEachConfig } from "../../src/types/foreach.js";
import { ForEachPartialError } from "../../src/errors.js";

/**
 * Property-based tests for ForEach Executor
 *
 * **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9**
 */

// --- Helpers ---

function createContext(
  overrides: Partial<ExecutionContext<unknown>> = {}
): ExecutionContext<unknown> {
  return {
    pipelineId: "test-pipeline",
    correlationId: "test-correlation",
    stepResults: new Map(),
    userContext: {},
    abortSignal: new AbortController().signal,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    metrics: {
      increment: () => {},
      gauge: () => {},
      histogram: () => {},
      timing: () => {},
    },
    ...overrides,
  };
}

describe("ForEach Executor — Property Tests", () => {
  describe("Property 25: ForEach Parallelism and Order", () => {
    /**
     * **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.8, 16.9**
     *
     * - Results array length equals input collection length (on success)
     * - Results preserve index order (results[i] corresponds to collection[i])
     * - Maximum concurrent executions never exceed maxConcurrency
     */

    it("results array length equals input collection length on success", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 0, maxLength: 30 }),
          fc.integer({ min: 1, max: 10 }),
          async (items, maxConcurrency) => {
            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency,
            };

            const handler = async (el: unknown) => el;
            const result = await executeForEach(config, handler, createContext(), true);

            expect(result.results).toHaveLength(items.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("results preserve index order — results[i] corresponds to collection[i]", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 5 }),
          async (items, maxConcurrency) => {
            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency,
            };

            // Transform each element deterministically so we can verify order
            const handler = async (el: unknown, index: number) => {
              // Add a variable delay to force out-of-order completion
              await new Promise((r) => setTimeout(r, Math.random() * 5));
              return (el as number) * 2 + index;
            };

            const result = await executeForEach(config, handler, createContext(), true);

            // Verify each result matches expected transformation at its index
            for (let i = 0; i < items.length; i++) {
              expect(result.results[i]).toBe(items[i]! * 2 + i);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("maximum concurrent executions never exceed maxConcurrency", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 2, maxLength: 15 }),
          fc.integer({ min: 1, max: 5 }),
          async (items, maxConcurrency) => {
            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency,
            };

            let concurrentCount = 0;
            let maxConcurrent = 0;

            const handler = async (el: unknown) => {
              concurrentCount++;
              maxConcurrent = Math.max(maxConcurrent, concurrentCount);
              // Small delay to create overlap window for concurrency measurement
              await new Promise((r) => setTimeout(r, 5));
              concurrentCount--;
              return el;
            };

            await executeForEach(config, handler, createContext(), true);

            expect(maxConcurrent).toBeLessThanOrEqual(maxConcurrency);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("empty array always returns empty result immediately with no handler calls", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          async (maxConcurrency) => {
            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => [],
              maxConcurrency,
            };

            let handlerCalled = false;
            const handler = async (el: unknown) => {
              handlerCalled = true;
              return el;
            };

            const result = await executeForEach(config, handler, createContext(), true);

            expect(result.results).toEqual([]);
            expect(result.report.totalElements).toBe(0);
            expect(result.report.successCount).toBe(0);
            expect(result.report.failureCount).toBe(0);
            expect(handlerCalled).toBe(false);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("handler is invoked exactly once per element in the collection", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 8 }),
          async (items, maxConcurrency) => {
            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency,
            };

            const invokedIndices: number[] = [];
            const handler = async (el: unknown, index: number) => {
              invokedIndices.push(index);
              return el;
            };

            await executeForEach(config, handler, createContext(), true);

            // Every index 0..items.length-1 should appear exactly once
            const sorted = [...invokedIndices].sort((a, b) => a - b);
            const expected = Array.from({ length: items.length }, (_, i) => i);
            expect(sorted).toEqual(expected);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Property 26: ForEach Failure Semantics", () => {
    /**
     * **Validates: Requirements 16.5, 16.6, 16.7**
     *
     * - For required steps (isRequired=true): throws ForEachPartialError when any element fails
     * - For optional steps (isRequired=false): failed elements produce undefined, successful keep values
     * - Empty array always returns empty result immediately (no handler calls)
     */

    it("required step throws ForEachPartialError when any element fails", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 2, maxLength: 10 }),
          fc.integer({ min: 1, max: 3 }),
          async (items, maxConcurrency) => {
            // Use sequential execution to ensure the failing index is deterministic
            const failIndex = 0; // Fail on the first element to guarantee the error triggers

            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency,
            };

            const handler = async (el: unknown, index: number) => {
              if (index === failIndex) throw new Error(`element ${index} failed`);
              return el;
            };

            await expect(
              executeForEach(config, handler, createContext(), true)
            ).rejects.toThrow(ForEachPartialError);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("ForEachPartialError includes the error details for the failing element", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 2, maxLength: 8 }),
          async (items) => {
            // Fail first element to guarantee it happens regardless of concurrency
            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency: 1, // Sequential ensures deterministic failure
            };

            const handler = async (el: unknown, index: number) => {
              if (index === 0) throw new Error("fail-first");
              return el;
            };

            try {
              await executeForEach(config, handler, createContext(), true);
              expect.fail("should have thrown");
            } catch (err) {
              expect(err).toBeInstanceOf(ForEachPartialError);
              const partialErr = err as ForEachPartialError;
              expect(partialErr.errors.length).toBeGreaterThanOrEqual(1);
              // At least one error should be from the failing element
              const failedError = partialErr.errors.find((e) => e.index === 0);
              expect(failedError).toBeDefined();
              expect(failedError!.error.message).toBe("fail-first");
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("optional step: failed elements produce undefined, successful elements keep values", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 1, maxLength: 15 }),
          fc.integer({ min: 1, max: 5 }),
          async (items, maxConcurrency) => {
            // Decide which indices fail (even indices fail)
            const failingIndices = new Set(
              items.map((_, i) => i).filter((i) => i % 2 === 0)
            );

            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency,
            };

            const handler = async (el: unknown, index: number) => {
              if (failingIndices.has(index)) {
                throw new Error(`element ${index} failed`);
              }
              return (el as number) * 3;
            };

            const result = await executeForEach(config, handler, createContext(), false);

            // Results array has same length as input
            expect(result.results).toHaveLength(items.length);

            // Verify each element's result
            for (let i = 0; i < items.length; i++) {
              if (failingIndices.has(i)) {
                expect(result.results[i]).toBeUndefined();
              } else {
                expect(result.results[i]).toBe(items[i]! * 3);
              }
            }

            // Report tracks failures correctly
            expect(result.report.failureCount).toBe(failingIndices.size);
            expect(result.report.successCount).toBe(items.length - failingIndices.size);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("optional step does not throw even when all elements fail", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer(), { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 1, max: 5 }),
          async (items, maxConcurrency) => {
            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency,
            };

            const handler = async (_el: unknown, index: number) => {
              throw new Error(`element ${index} failed`);
            };

            // Should not throw for optional steps
            const result = await executeForEach(config, handler, createContext(), false);

            expect(result.results).toHaveLength(items.length);
            // All elements should be undefined since all failed
            for (let i = 0; i < items.length; i++) {
              expect(result.results[i]).toBeUndefined();
            }
            expect(result.report.failureCount).toBe(items.length);
            expect(result.report.successCount).toBe(0);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("required step aborts remaining elements after first failure (sequential)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 3, max: 10 }),
          async (itemCount) => {
            const items = Array.from({ length: itemCount }, (_, i) => i);

            const config: ForEachConfig<unknown, unknown> = {
              mapper: () => items,
              maxConcurrency: 1, // Sequential ensures deterministic abort behavior
            };

            const executedIndices: number[] = [];
            const handler = async (el: unknown, index: number) => {
              executedIndices.push(index);
              if (index === 1) throw new Error("fail at index 1");
              return el;
            };

            try {
              await executeForEach(config, handler, createContext(), true);
            } catch {
              // expected
            }

            // Index 0 and 1 were executed; indices >= 2 should be aborted
            expect(executedIndices).toContain(0);
            expect(executedIndices).toContain(1);
            for (let i = 2; i < itemCount; i++) {
              expect(executedIndices).not.toContain(i);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

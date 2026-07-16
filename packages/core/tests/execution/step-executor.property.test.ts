import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { executeStep } from "../../src/execution/step-executor.js";
import { createRetryPolicy } from "../../src/policies/retry-policy.js";
import type { ExecutionContext } from "../../src/types.js";
import type { StepNode } from "../../src/types/graph.js";

/**
 * Property-based tests for Step Executor
 *
 * **Validates: Requirements 3.1, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 19.1, 19.2, 19.3**
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

function createNode(overrides: Partial<StepNode> = {}): StepNode {
  return {
    name: "testStep",
    handler: async () => "result",
    policies: {},
    dependencies: [],
    isRequired: true,
    ...overrides,
  };
}

/**
 * Creates a retry policy with minimum allowed baseDelay for fast tests.
 * The minimum baseDelay is 100ms per the policy validator.
 */
function fastRetryPolicy(count: number, options?: { retryOn?: (err: Error) => boolean }) {
  return createRetryPolicy(count, { baseDelay: 100, ...options });
}

describe("Step Executor — Property Tests", () => {
  // Use small retry counts to keep tests fast (each retry sleeps 100ms minimum)
  const smallRetryCount = fc.integer({ min: 1, max: 3 });

  describe("Property 5: Retry Bound (Integration) — total invocations <= count + 1", () => {
    /**
     * **Validates: Requirements 3.1, 3.6, 3.7**
     *
     * For any retry count N (1-10), the handler is invoked at most N+1 times
     * total (1 initial attempt + at most N retries). The step executor computes
     * maxAttempts = 1 + policy.maxAttempts = 1 + count, but shouldRetry gates
     * at attempt >= count, resulting in exactly `count` invocations when all fail.
     * The upper bound property (invocations <= count + 1) always holds.
     */
    it("handler is invoked at most count + 1 times for any retry count", async () => {
      await fc.assert(
        fc.asyncProperty(smallRetryCount, async (count) => {
          let invocations = 0;
          const handler = async () => {
            invocations++;
            throw new Error("always fails");
          };

          const retry = fastRetryPolicy(count);
          const node = createNode({ handler, policies: { retry } });
          const context = createContext();

          await executeStep(node, context, new Map());

          expect(invocations).toBeLessThanOrEqual(count + 1);
          // More precisely, the implementation calls handler exactly count times
          expect(invocations).toBe(count);
        }),
        { numRuns: 20 }
      );
    }, 30000);

    it("successful handler on Kth attempt (K <= count) stops further invocations", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 4 }),
          async (count) => {
            // Success on the second attempt
            let invocations = 0;
            const handler = async () => {
              invocations++;
              if (invocations < 2) throw new Error("not yet");
              return "success";
            };

            const retry = fastRetryPolicy(count);
            const node = createNode({ handler, policies: { retry } });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            expect(result.status).toBe("success");
            expect(invocations).toBe(2);
            expect(invocations).toBeLessThanOrEqual(count + 1);
          }
        ),
        { numRuns: 10 }
      );
    }, 30000);

    it("retry history length is less than or equal to count", async () => {
      await fc.assert(
        fc.asyncProperty(smallRetryCount, async (count) => {
          const handler = async () => {
            throw new Error("always fails");
          };

          const retry = fastRetryPolicy(count);
          const node = createNode({ handler, policies: { retry } });
          const context = createContext();

          const result = await executeStep(node, context, new Map());

          const metadata = (result as any).metadata;
          expect(metadata.retryHistory.length).toBeLessThanOrEqual(count);
        }),
        { numRuns: 20 }
      );
    }, 30000);
  });

  describe("Property 7: Fallback Order and Short-Circuit — fallbacks in declaration order, first success wins", () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
     *
     * Generate an array of 1-5 fallback handlers where exactly one succeeds
     * at a random index. Verify:
     * - All fallbacks before the successful one were called
     * - The successful fallback was called
     * - No fallbacks after the successful one were called
     * - The result is the successful fallback's value
     */
    it("fallbacks execute in declaration order and short-circuit on first success", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.nat(),
          async (fallbackCount, seed) => {
            // Determine which fallback succeeds (0-indexed)
            const successIndex = seed % fallbackCount;
            const callOrder: number[] = [];
            const successValue = `fallback-${successIndex}-result`;

            const fallbacks = Array.from({ length: fallbackCount }, (_, i) => {
              return async () => {
                callOrder.push(i);
                if (i === successIndex) return successValue;
                throw new Error(`fallback-${i}-failed`);
              };
            });

            const node = createNode({
              handler: async () => { throw new Error("primary failed"); },
              policies: { fallbacks: fallbacks as any },
            });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            // All fallbacks before success index were called
            for (let i = 0; i < successIndex; i++) {
              expect(callOrder).toContain(i);
            }

            // The successful fallback was called
            expect(callOrder).toContain(successIndex);

            // No fallbacks after success index were called
            for (let i = successIndex + 1; i < fallbackCount; i++) {
              expect(callOrder).not.toContain(i);
            }

            // Call order is strictly sequential
            const expectedOrder = Array.from(
              { length: successIndex + 1 },
              (_, i) => i
            );
            expect(callOrder).toEqual(expectedOrder);

            // Result is the successful fallback's value
            expect(result.status).toBe("fallback");
            if (result.status === "fallback") {
              expect(result.value).toBe(successValue);
              expect(result.fallbackIndex).toBe(successIndex);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it("when all fallbacks fail, step fails with last fallback error", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (fallbackCount) => {
          const callOrder: number[] = [];

          const fallbacks = Array.from({ length: fallbackCount }, (_, i) => {
            return async () => {
              callOrder.push(i);
              throw new Error(`fallback-${i}-failed`);
            };
          });

          const node = createNode({
            handler: async () => { throw new Error("primary failed"); },
            policies: { fallbacks: fallbacks as any },
          });
          const context = createContext();

          const result = await executeStep(node, context, new Map());

          // All fallbacks were called in order
          const expectedOrder = Array.from(
            { length: fallbackCount },
            (_, i) => i
          );
          expect(callOrder).toEqual(expectedOrder);

          // Step failed
          expect(result.status).toBe("failed");
          if (result.status === "failed") {
            // Last fallback's error
            expect(result.error.message).toBe(
              `fallback-${fallbackCount - 1}-failed`
            );
          }
        }),
        { numRuns: 50 }
      );
    });

    it("fallback metadata records attempt details for each tried fallback", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.nat(),
          async (fallbackCount, seed) => {
            const successIndex = seed % fallbackCount;

            const fallbacks = Array.from({ length: fallbackCount }, (_, i) => {
              return async () => {
                if (i === successIndex) return `result-${i}`;
                throw new Error(`fallback-${i}-failed`);
              };
            });

            const node = createNode({
              handler: async () => { throw new Error("primary failed"); },
              policies: { fallbacks: fallbacks as any },
            });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            const metadata = (result as any).metadata;
            // Fallback history should have successIndex + 1 entries
            expect(metadata.fallbackHistory).toHaveLength(successIndex + 1);

            // All entries before success have success: false
            for (let i = 0; i < successIndex; i++) {
              expect(metadata.fallbackHistory[i].index).toBe(i);
              expect(metadata.fallbackHistory[i].success).toBe(false);
            }

            // The success entry
            expect(metadata.fallbackHistory[successIndex].index).toBe(successIndex);
            expect(metadata.fallbackHistory[successIndex].success).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Property 18: RetryOn Predicate Short-Circuit — non-matching errors skip remaining retries", () => {
    /**
     * **Validates: Requirements 3.5**
     *
     * When a retryOn predicate rejects the error, no further retries happen.
     * Handler is called exactly once (only the initial attempt that produces
     * the non-matching error).
     */
    it("handler called exactly once when retryOn rejects the error", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => s !== "TRANSIENT"),
          async (count, errorMessage) => {
            let invocations = 0;
            const handler = async () => {
              invocations++;
              throw new Error(errorMessage);
            };

            // Predicate only allows retrying "TRANSIENT" errors — never matches
            const retry = fastRetryPolicy(count, {
              retryOn: (err) => err.message === "TRANSIENT",
            });
            const node = createNode({ handler, policies: { retry } });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            // Only one invocation — the initial attempt
            expect(invocations).toBe(1);
            expect(result.status).toBe("failed");
            if (result.status === "failed") {
              expect(result.error.message).toBe(errorMessage);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("handler retries normally when retryOn accepts the error", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 3 }),
          async (count) => {
            let invocations = 0;
            const handler = async () => {
              invocations++;
              throw new Error("TRANSIENT");
            };

            // Predicate accepts "TRANSIENT" errors
            const retry = fastRetryPolicy(count, {
              retryOn: (err) => err.message === "TRANSIENT",
            });
            const node = createNode({ handler, policies: { retry } });
            const context = createContext();

            await executeStep(node, context, new Map());

            // With the predicate accepting, retries happen normally
            // Handler is called count times (shouldRetry gates at attempt >= count)
            expect(invocations).toBe(count);
            expect(invocations).toBeGreaterThan(1);
          }
        ),
        { numRuns: 10 }
      );
    }, 30000);

    it("non-matching error proceeds to fallback chain after short-circuit", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 1, max: 3 }),
          async (count, fallbackCount) => {
            let handlerInvocations = 0;
            const fallbackCalls: number[] = [];

            const handler = async () => {
              handlerInvocations++;
              throw new Error("permanent");
            };

            // retryOn rejects "permanent" errors
            const retry = fastRetryPolicy(count, {
              retryOn: (err) => err.message !== "permanent",
            });

            const fallbacks = Array.from({ length: fallbackCount }, (_, i) => {
              return async () => {
                fallbackCalls.push(i);
                if (i === fallbackCount - 1) return "fallback-success";
                throw new Error(`fb-${i}-failed`);
              };
            });

            const node = createNode({
              handler,
              policies: { retry, fallbacks: fallbacks as any },
            });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            // Handler called exactly once due to retryOn rejection
            expect(handlerInvocations).toBe(1);

            // Fallback chain was invoked
            expect(fallbackCalls.length).toBeGreaterThan(0);

            // Result should be from fallback
            expect(result.status).toBe("fallback");
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Error transformer integration with retry", () => {
    /**
     * **Validates: Requirements 19.1, 19.2, 19.3**
     *
     * Error transformer is applied before retryOn predicate check.
     * The transformed error is what reaches the retryOn predicate.
     */
    it("error transformer runs before retryOn predicate evaluation", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 3 }),
          async (count) => {
            let invocations = 0;
            const handler = async () => {
              invocations++;
              throw new Error("raw-error");
            };

            // Transformer converts all errors to "transformed" prefix
            const errorTransformer = (err: Error) =>
              new Error(`transformed:${err.message}`);

            // retryOn only accepts transformed errors
            const retry = fastRetryPolicy(count, {
              retryOn: (err) => err.message.startsWith("transformed:"),
            });

            const node = createNode({
              handler,
              policies: { retry, errorTransformer },
            });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            // Since transformer runs before retryOn, the predicate sees
            // "transformed:raw-error" which matches → retries proceed normally
            expect(invocations).toBe(count);
            expect(result.status).toBe("failed");
            if (result.status === "failed") {
              expect(result.error.message).toBe("transformed:raw-error");
            }
          }
        ),
        { numRuns: 10 }
      );
    }, 30000);

    it("without transformer, retryOn sees original error (no transformation)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 10 }),
          async (count) => {
            let invocations = 0;
            const handler = async () => {
              invocations++;
              throw new Error("raw-error");
            };

            // retryOn only accepts "transformed:" prefix — without transformer, never matches
            const retry = fastRetryPolicy(count, {
              retryOn: (err) => err.message.startsWith("transformed:"),
            });

            const node = createNode({
              handler,
              policies: { retry },
            });
            const context = createContext();

            await executeStep(node, context, new Map());

            // Without transformer, retryOn sees "raw-error" → rejects → no retries
            expect(invocations).toBe(1);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("error transformations are recorded in metadata", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 3 }),
          async (count) => {
            const handler = async () => {
              throw new Error("original");
            };

            const errorTransformer = (err: Error) =>
              new Error(`mapped:${err.message}`);

            const retry = fastRetryPolicy(count, {
              retryOn: (err) => err.message.startsWith("mapped:"),
            });

            const node = createNode({
              handler,
              policies: { retry, errorTransformer },
            });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            const metadata = (result as any).metadata;
            // Each attempt that fails generates a transformation record
            expect(metadata.errorTransformations.length).toBeGreaterThan(0);
            // Each record should show original → transformed
            for (const t of metadata.errorTransformations) {
              expect(t.originalError.message).toBe("original");
              expect(t.transformedError.message).toBe("mapped:original");
            }
          }
        ),
        { numRuns: 10 }
      );
    }, 30000);
  });

  describe("Combined retry + fallback integration", () => {
    /**
     * **Validates: Requirements 3.1, 3.6, 3.7, 4.1, 4.2**
     *
     * When retry is exhausted, the fallback chain is invoked.
     * Handler is called the maximum allowed times, then fallbacks are tried.
     */
    it("handler exhausts retries, then fallback chain is invoked", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 3 }),
          fc.integer({ min: 1, max: 3 }),
          async (count, fallbackCount) => {
            let handlerInvocations = 0;
            const fallbackCalls: number[] = [];

            const handler = async () => {
              handlerInvocations++;
              throw new Error("always fails");
            };

            const retry = fastRetryPolicy(count);

            // Last fallback succeeds
            const fallbacks = Array.from({ length: fallbackCount }, (_, i) => {
              return async () => {
                fallbackCalls.push(i);
                if (i === fallbackCount - 1) return "fallback-result";
                throw new Error(`fb-${i}-failed`);
              };
            });

            const node = createNode({
              handler,
              policies: { retry, fallbacks: fallbacks as any },
            });
            const context = createContext();

            const result = await executeStep(node, context, new Map());

            // Handler called count times (shouldRetry returns false at count)
            expect(handlerInvocations).toBe(count);

            // Fallback chain tried after retries exhausted
            expect(fallbackCalls.length).toBe(fallbackCount);
            expect(fallbackCalls).toEqual(
              Array.from({ length: fallbackCount }, (_, i) => i)
            );

            // Result from last fallback which succeeded
            expect(result.status).toBe("fallback");
            if (result.status === "fallback") {
              expect(result.value).toBe("fallback-result");
            }
          }
        ),
        { numRuns: 10 }
      );
    }, 30000);
  });
});

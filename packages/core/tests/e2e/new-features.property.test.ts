// Integration property-based tests for new features via the builder API
// Tests branch, forEach, repeatUntil, and sub-pipeline composition end-to-end.

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createPipeline } from "../../src/index.js";

/**
 * Property-based integration tests for new features via the builder API.
 *
 * - Property 23: Branch Mutual Exclusivity (integration)
 * - Property 25: ForEach Parallelism and Order (integration)
 * - Property 27: RepeatUntil Termination Guarantee (integration)
 * - Property 29: Sub-Pipeline Composition (integration)
 *
 * **Validates: Requirements 15.1-15.8, 16.1-16.9, 17.1-17.9, 18.1-18.8**
 */

describe("New Features Integration — Property Tests (via builder API)", () => {
  describe("Property 23: Branch Mutual Exclusivity (integration)", () => {
    /**
     * **Validates: Requirements 15.1-15.8**
     *
     * For any set of N branches with distinct keys, using
     * createPipeline().branch().when()...execute(), exactly one branch handler executes.
     */
    it("exactly one branch handler executes for any matching discriminator value", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
            minLength: 2,
            maxLength: 6,
          }),
          fc.nat(),
          async (keys, seedIndex) => {
            const matchIndex = seedIndex % keys.length;
            const matchKey = keys[matchIndex];

            // Track which handlers were invoked
            const invocations: number[] = new Array(keys.length).fill(0);

            // Build pipeline with branch step
            let branchConfig = createPipeline<{ selection: string }>("branch-test")
              .withContext({ selection: matchKey })
              .branch("route", (ctx) => ctx.userContext.selection);

            // Register all .when() clauses
            for (let i = 0; i < keys.length; i++) {
              const idx = i;
              branchConfig = branchConfig.when(keys[i], async () => {
                invocations[idx]++;
                return `result-${idx}`;
              });
            }

            const result = await branchConfig.execute();

            expect(result.success).toBe(true);

            // Exactly one handler was invoked total
            const totalInvocations = invocations.reduce((a, b) => a + b, 0);
            expect(totalInvocations).toBe(1);

            // The correct branch was invoked
            expect(invocations[matchIndex]).toBe(1);

            // Result is from the matched branch
            expect(result.getValue("route")).toBe(`result-${matchIndex}`);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("otherwise handler executes when no .when() matches", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
            minLength: 2,
            maxLength: 5,
          }),
          async (keys) => {
            const unmatchedValue = "__never_matches__";
            let otherwiseCalled = false;
            const branchCalls: boolean[] = new Array(keys.length).fill(false);

            let branchConfig = createPipeline<{ value: string }>("branch-otherwise")
              .withContext({ value: unmatchedValue })
              .branch("route", (ctx) => ctx.userContext.value);

            for (let i = 0; i < keys.length; i++) {
              const idx = i;
              branchConfig = branchConfig.when(keys[i], async () => {
                branchCalls[idx] = true;
                return `branch-${idx}`;
              });
            }

            const result = await branchConfig
              .otherwise(async () => {
                otherwiseCalled = true;
                return "otherwise-result";
              })
              .execute();

            expect(result.success).toBe(true);
            expect(otherwiseCalled).toBe(true);
            expect(branchCalls.every((c) => c === false)).toBe(true);
            expect(result.getValue("route")).toBe("otherwise-result");
          }
        ),
        { numRuns: 50 }
      );
    });

    it("BranchNotMatchedError when no match and no otherwise", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
            minLength: 2,
            maxLength: 5,
          }),
          async (keys) => {
            const unmatchedValue = "__no_match__";

            let branchConfig = createPipeline<{ value: string }>("branch-no-match")
              .withContext({ value: unmatchedValue })
              .branch("route", (ctx) => ctx.userContext.value);

            for (const key of keys) {
              branchConfig = branchConfig.when(key, async () => `result-${key}`);
            }

            // Mark as optional so pipeline doesn't abort
            const result = await branchConfig.optional().execute();

            expect(result.success).toBe(true);
            const routeStep = result.steps.get("route");
            expect(routeStep?.status).toBe("failed");
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Property 25: ForEach Parallelism and Order (integration)", () => {
    /**
     * **Validates: Requirements 16.1-16.9**
     *
     * Using createPipeline().forEach().from().withConcurrency().execute(),
     * results preserve index order and concurrency is respected.
     */
    it("results array preserves index order regardless of completion order", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 5 }),
          async (items, maxConcurrency) => {
            const result = await createPipeline<{ items: number[] }>("foreach-order")
              .withContext({ items })
              .forEach("process", async (ctx) => {
                const item = ctx.userContext as unknown as number;
                // Add a small random delay to vary completion order
                await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
                return item * 2;
              })
              .from((ctx) => ctx.userContext.items)
              .withConcurrency(maxConcurrency)
              .execute();

            expect(result.success).toBe(true);
            const processResult = result.getValue<number[]>("process");
            expect(processResult).toHaveLength(items.length);
            // Results must be in index order (each is item * 2)
            for (let i = 0; i < items.length; i++) {
              expect(processResult![i]).toBe(items[i] * 2);
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it("concurrency limit is respected — never more than maxConcurrency concurrent handlers", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 3, maxLength: 15 }),
          fc.integer({ min: 1, max: 3 }),
          async (items, maxConcurrency) => {
            let currentActive = 0;
            let peakConcurrency = 0;

            const result = await createPipeline<{ items: number[] }>("foreach-concurrency")
              .withContext({ items })
              .forEach("process", async (ctx) => {
                const item = ctx.userContext as unknown as number;
                currentActive++;
                peakConcurrency = Math.max(peakConcurrency, currentActive);
                await new Promise((resolve) => setTimeout(resolve, 5));
                currentActive--;
                return item;
              })
              .from((ctx) => ctx.userContext.items)
              .withConcurrency(maxConcurrency)
              .execute();

            expect(result.success).toBe(true);
            expect(peakConcurrency).toBeLessThanOrEqual(maxConcurrency);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("empty collection results in immediate success with empty array", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (maxConcurrency) => {
            let handlerCalled = false;

            const result = await createPipeline<{ items: never[] }>("foreach-empty")
              .withContext({ items: [] })
              .forEach("process", async () => {
                handlerCalled = true;
                return "should-not-reach";
              })
              .from((ctx) => ctx.userContext.items)
              .withConcurrency(maxConcurrency)
              .execute();

            expect(result.success).toBe(true);
            expect(result.getValue<unknown[]>("process")).toEqual([]);
            expect(handlerCalled).toBe(false);
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  describe("Property 27: RepeatUntil Termination Guarantee (integration)", () => {
    /**
     * **Validates: Requirements 17.1-17.9**
     *
     * Using createPipeline().repeatUntil().until().maxIterations().execute(),
     * handler is called at most maxIterations times.
     */
    it("handler is called at most maxIterations times when predicate never returns true", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 15 }),
          async (maxIterations) => {
            let invocations = 0;

            const result = await createPipeline("repeat-exhaust")
              .repeatUntil("poll", async () => {
                invocations++;
                return { done: false, count: invocations };
              })
              .until(() => false)
              .maxIterations(maxIterations)
              .optional()
              .execute();

            // Pipeline succeeds because step is optional
            expect(result.success).toBe(true);
            // Handler was called exactly maxIterations times
            expect(invocations).toBe(maxIterations);
            // Step failed (MaxIterationsExhaustedError)
            expect(result.steps.get("poll")?.status).toBe("failed");
          }
        ),
        { numRuns: 30 }
      );
    });

    it("succeeds when predicate returns true on iteration K <= maxIterations", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          async (satisfyAt, extraIterations) => {
            const maxIterations = satisfyAt + extraIterations;
            let invocations = 0;

            const result = await createPipeline("repeat-satisfy")
              .repeatUntil("poll", async () => {
                invocations++;
                return { count: invocations };
              })
              .until((r: any) => r.count >= satisfyAt)
              .maxIterations(maxIterations)
              .execute();

            expect(result.success).toBe(true);
            // Handler called exactly satisfyAt times
            expect(invocations).toBe(satisfyAt);
            const pollResult = result.getValue<{ count: number }>("poll");
            expect(pollResult?.count).toBe(satisfyAt);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("fails immediately on handler error without retrying", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 10 }),
          fc.integer({ min: 1, max: 5 }),
          async (maxIterations, failOnIteration) => {
            const failAt = Math.min(failOnIteration, maxIterations);
            let invocations = 0;

            const result = await createPipeline("repeat-handler-fail")
              .repeatUntil("poll", async () => {
                invocations++;
                if (invocations === failAt) {
                  throw new Error(`fail on iteration ${failAt}`);
                }
                return { count: invocations };
              })
              .until(() => false)
              .maxIterations(maxIterations)
              .optional()
              .execute();

            expect(result.success).toBe(true); // optional
            // Handler was called exactly failAt times (no further iterations after failure)
            expect(invocations).toBe(failAt);
            expect(result.steps.get("poll")?.status).toBe("failed");
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Property 29: Sub-Pipeline Composition (integration)", () => {
    /**
     * **Validates: Requirements 18.1-18.8**
     *
     * When a pipeline step handler returns another pipeline's execute result
     * (simulating sub-pipeline pattern), the result propagates correctly.
     */
    it("sub-pipeline success propagates as parent step success", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.integer(),
          async (contextValue, numberResult) => {
            // Use sub-pipeline as step handler in parent pipeline
            const result = await createPipeline<{ data: string }>("parent")
              .withContext({ data: contextValue })
              .step("main", async (ctx) => {
                // Create and execute the sub-pipeline inside the handler
                const subResult = await createPipeline<{ input: string }>("sub")
                  .withContext({ input: ctx.userContext.data })
                  .step("subStep", async (subCtx) => {
                    return { processed: subCtx.userContext.input, extra: numberResult };
                  })
                  .execute();
                return subResult;
              })
              .execute();

            expect(result.success).toBe(true);
            const mainResult = result.getValue<any>("main");
            expect(mainResult).toBeDefined();
            expect(mainResult.success).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("sub-pipeline failure propagates as parent step failure", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 30 }),
          async (errorMessage) => {
            // Parent step invokes a failing sub-pipeline and re-throws on failure
            const result = await createPipeline("parent-with-failing-sub")
              .step("main", async () => {
                const subResult = await createPipeline("failing-sub")
                  .step("failStep", async () => {
                    throw new Error(errorMessage);
                  })
                  .required()
                  .execute();
                if (!subResult.success) {
                  throw new Error("Sub-pipeline failed");
                }
                return subResult;
              })
              .optional()
              .execute();

            expect(result.success).toBe(true); // optional step
            const mainStep = result.steps.get("main");
            expect(mainStep?.status).toBe("failed");
          }
        ),
        { numRuns: 30 }
      );
    });

    it("parent abort signal cancels sub-pipeline execution", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 50 }),
          async (timeoutMs) => {
            const controller = new AbortController();

            // Abort quickly
            setTimeout(() => controller.abort(), timeoutMs);

            const result = await createPipeline("parent-cancellation")
              .step("main", async (ctx) => {
                // Create and execute sub-pipeline, passing parent's abort signal
                const subResult = await createPipeline("slow-sub")
                  .step("slowStep", async (subCtx) => {
                    await new Promise<void>((resolve, reject) => {
                      const timer = setTimeout(resolve, 5000);
                      subCtx.abortSignal.addEventListener("abort", () => {
                        clearTimeout(timer);
                        reject(new Error("aborted"));
                      }, { once: true });
                    });
                    return "should-not-complete";
                  })
                  .execute({ signal: ctx.abortSignal });
                if (!subResult.success) {
                  throw new Error("Sub-pipeline cancelled");
                }
                return subResult;
              })
              .execute({ signal: controller.signal });

            // Pipeline should fail because of cancellation
            expect(result.success).toBe(false);
          }
        ),
        { numRuns: 5 } // Fewer runs since timing-sensitive
      );
    });

    it("sub-pipeline result is accessible to dependent steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1000 }),
          async (value) => {
            const result = await createPipeline<{ input: number }>("parent-dep")
              .withContext({ input: value })
              .step("sub", async (ctx) => {
                // Create and execute sub-pipeline
                const subResult = await createPipeline<{ val: number }>("value-sub")
                  .withContext({ val: ctx.userContext.input })
                  .step("compute", async (subCtx) => subCtx.userContext.val * 2)
                  .execute();
                return subResult.getValue<number>("compute");
              })
              .step("consumer", async (ctx) => {
                const subValue = ctx.stepResults.get("sub") as number;
                return subValue + 1;
              })
              .dependsOn("sub")
              .execute();

            expect(result.success).toBe(true);
            expect(result.getValue<number>("sub")).toBe(value * 2);
            expect(result.getValue<number>("consumer")).toBe(value * 2 + 1);
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});

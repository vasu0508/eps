import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { runScheduler } from "../../src/execution/step-scheduler.js";
import { buildExecutionGraph } from "../../src/graph/execution-graph.js";
import type { StepNode } from "../../src/types/graph.js";
import type { ExecutionContext } from "../../src/types.js";

/**
 * Property-based tests for Step Scheduler
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 8.5, 8.6, 8.7, 9.1, 9.2, 9.4, 9.5, 9.6, 9.7**
 */

// --- Helpers ---

function makeNode(overrides: Partial<StepNode> & { name: string }): StepNode {
  return {
    handler: async () => `result-${overrides.name}`,
    policies: {},
    dependencies: [],
    isRequired: true,
    ...overrides,
  } as StepNode;
}

function makeContext(overrides?: Partial<ExecutionContext<unknown>>): ExecutionContext<unknown> {
  return {
    pipelineId: "test-pipeline",
    correlationId: "test-corr-id",
    stepResults: new Map(),
    userContext: {},
    abortSignal: new AbortController().signal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    metrics: { increment: () => {}, gauge: () => {}, histogram: () => {}, timing: () => {} },
    ...overrides,
  };
}

/**
 * Generates a valid DAG as an array of StepNodes. Steps are named "s0", "s1", etc.
 * Each step may depend on steps with smaller indices (ensuring no cycles).
 */
function arbDAG(opts: { minSteps?: number; maxSteps?: number; delayMs?: number } = {}): fc.Arbitrary<StepNode[]> {
  const { minSteps = 2, maxSteps = 8, delayMs = 10 } = opts;

  return fc.integer({ min: minSteps, max: maxSteps }).chain((numSteps) => {
    // For each step, generate a subset of earlier steps as dependencies
    const depArbs = Array.from({ length: numSteps }, (_, i) => {
      if (i === 0) return fc.constant([] as string[]);
      // Each earlier step has a 30% chance of being a dependency
      return fc.array(fc.constantFrom(...Array.from({ length: i }, (_, j) => `s${j}`)), {
        minLength: 0,
        maxLength: Math.min(i, 3),
      }).map((deps) => [...new Set(deps)]); // deduplicate
    });

    return fc.tuple(...depArbs).map((allDeps) => {
      return allDeps.map((deps, i) =>
        makeNode({
          name: `s${i}`,
          dependencies: deps,
          handler: async () => {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            return `result-s${i}`;
          },
        })
      );
    });
  });
}

describe("Step Scheduler — Property Tests", () => {
  describe("Property 3: Step Order — S always starts after all dependencies D complete", () => {
    /**
     * **Validates: Requirements 8.5, 8.6**
     *
     * For any valid DAG, when the scheduler runs, step S never starts before
     * all its dependencies have completed. We verify by tracking start/complete
     * timestamps per step in the event stream.
     */
    it("no step starts before all its dependencies have completed", async () => {
      await fc.assert(
        fc.asyncProperty(arbDAG({ minSteps: 2, maxSteps: 6, delayMs: 5 }), async (nodes) => {
          const startTimes = new Map<string, number>();
          const completeTimes = new Map<string, number>();

          const graph = buildExecutionGraph(nodes);
          const result = await runScheduler({
            graph,
            context: makeContext(),
            onEvent: (event) => {
              if (event.type === "step:start") {
                startTimes.set(event.step, event.timestamp);
              }
              if (event.type === "step:complete") {
                completeTimes.set(event.step, Date.now());
              }
            },
          });

          expect(result.success).toBe(true);

          // Verify ordering property: for each step, all deps completed before it started
          for (const node of nodes) {
            if (node.dependencies.length === 0) continue;
            const stepStart = startTimes.get(node.name);
            if (stepStart === undefined) continue; // step was skipped

            for (const dep of node.dependencies) {
              const depComplete = completeTimes.get(dep);
              // Dependency must have completed before step started
              // (or at least at the same timestamp due to scheduling resolution)
              expect(depComplete).toBeDefined();
              expect(depComplete!).toBeLessThanOrEqual(stepStart);
            }
          }
        }),
        { numRuns: 50 }
      );
    }, 60000);
  });

  describe("Property 11: Concurrency Limit — active steps <= maxConcurrency", () => {
    /**
     * **Validates: Requirements 8.6**
     *
     * For any maxConcurrency value N (1-5) and any set of independent steps,
     * at most N steps run concurrently. We verify using an atomic concurrent
     * counter in handlers.
     */
    it("at most maxConcurrency steps run concurrently for independent steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.integer({ min: 3, max: 10 }),
          async (maxConcurrency, stepCount) => {
            let currentConcurrent = 0;
            let maxObserved = 0;

            const nodes = Array.from({ length: stepCount }, (_, i) =>
              makeNode({
                name: `s${i}`,
                handler: async () => {
                  currentConcurrent++;
                  maxObserved = Math.max(maxObserved, currentConcurrent);
                  await new Promise((r) => setTimeout(r, 10));
                  currentConcurrent--;
                  return `result-s${i}`;
                },
              })
            );

            const graph = buildExecutionGraph(nodes);
            const result = await runScheduler({
              graph,
              context: makeContext(),
              maxConcurrency,
            });

            expect(result.success).toBe(true);
            expect(maxObserved).toBeLessThanOrEqual(maxConcurrency);
            // Also verify all steps completed
            expect(result.stepResults.size).toBe(stepCount);
          }
        ),
        { numRuns: 30 }
      );
    }, 60000);

    it("concurrency limit holds for DAG-structured steps as well", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          arbDAG({ minSteps: 4, maxSteps: 8, delayMs: 0 }),
          async (maxConcurrency, nodes) => {
            let currentConcurrent = 0;
            let maxObserved = 0;

            // Override handlers with concurrency tracking
            const trackedNodes = nodes.map((node) =>
              makeNode({
                ...node,
                handler: async () => {
                  currentConcurrent++;
                  maxObserved = Math.max(maxObserved, currentConcurrent);
                  await new Promise((r) => setTimeout(r, 5));
                  currentConcurrent--;
                  return `result-${node.name}`;
                },
              })
            );

            const graph = buildExecutionGraph(trackedNodes);
            const result = await runScheduler({
              graph,
              context: makeContext(),
              maxConcurrency,
            });

            expect(result.success).toBe(true);
            expect(maxObserved).toBeLessThanOrEqual(maxConcurrency);
          }
        ),
        { numRuns: 30 }
      );
    }, 60000);
  });

  describe("Property 12: Conditional Skip Propagation — skipped steps release dependents", () => {
    /**
     * **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9**
     *
     * When a step has .onlyIf() returning false and is skipped, its dependents
     * still proceed (skipped counts as "done" for dependency resolution).
     */
    it("skipped step's dependents still execute", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          async (numDependents) => {
            // Create a skipped step and N dependents that depend on it
            const skippedNode = makeNode({
              name: "skipped",
              policies: { condition: () => false },
              handler: async () => "should-not-run",
            });

            const dependentNodes = Array.from({ length: numDependents }, (_, i) =>
              makeNode({
                name: `dep${i}`,
                dependencies: ["skipped"],
                handler: async () => `dep${i}-result`,
              })
            );

            const graph = buildExecutionGraph([skippedNode, ...dependentNodes]);
            const result = await runScheduler({ graph, context: makeContext() });

            expect(result.success).toBe(true);
            expect(result.stepResults.get("skipped")?.status).toBe("skipped");

            // All dependents should have executed successfully
            for (let i = 0; i < numDependents; i++) {
              const depResult = result.stepResults.get(`dep${i}`);
              expect(depResult?.status).toBe("success");
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("skipped steps in a chain still allow downstream steps to run", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 0, max: 3 }),
          async (chainLength, skipIndex) => {
            // Clamp skipIndex to be within chain (not the last step which is the final dependent)
            const actualSkipIndex = skipIndex % (chainLength - 1);

            const nodes: StepNode[] = [];
            for (let i = 0; i < chainLength; i++) {
              nodes.push(
                makeNode({
                  name: `step${i}`,
                  dependencies: i > 0 ? [`step${i - 1}`] : [],
                  policies: i === actualSkipIndex ? { condition: () => false } : {},
                  handler: async () => `result-step${i}`,
                })
              );
            }

            const graph = buildExecutionGraph(nodes);
            const result = await runScheduler({ graph, context: makeContext() });

            expect(result.success).toBe(true);

            // Skipped step should be marked as skipped
            expect(result.stepResults.get(`step${actualSkipIndex}`)?.status).toBe("skipped");

            // Steps after the skipped step should still execute
            const lastStep = result.stepResults.get(`step${chainLength - 1}`);
            expect(lastStep?.status).toBe("success");
          }
        ),
        { numRuns: 50 }
      );
    });

    it("condition predicate receives the userContext", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            flag: fc.boolean(),
            value: fc.integer(),
          }),
          async (userCtx) => {
            let receivedContext: unknown = null;

            const node = makeNode({
              name: "A",
              policies: {
                condition: (ctx: unknown) => {
                  receivedContext = ctx;
                  return true;
                },
              },
              handler: async () => "result",
            });

            const graph = buildExecutionGraph([node]);
            await runScheduler({
              graph,
              context: makeContext({ userContext: userCtx }),
            });

            expect(receivedContext).toEqual(userCtx);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Required failure cascades — when a required step fails, transitive dependents are skipped", () => {
    /**
     * **Validates: Requirements 8.7**
     *
     * When a required step fails, all steps that directly or transitively depend
     * on it are skipped with "dependency failed".
     */
    it("all transitive dependents of a failed required step are skipped", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          async (chainLength) => {
            // Create a chain: s0 → s1 → s2 → ... where s0 fails
            const nodes = Array.from({ length: chainLength }, (_, i) =>
              makeNode({
                name: `s${i}`,
                dependencies: i > 0 ? [`s${i - 1}`] : [],
                handler:
                  i === 0
                    ? async () => { throw new Error("s0 failed"); }
                    : async () => `result-s${i}`,
                isRequired: true,
              })
            );

            const graph = buildExecutionGraph(nodes);
            const result = await runScheduler({ graph, context: makeContext() });

            expect(result.success).toBe(false);
            expect(result.stepResults.get("s0")?.status).toBe("failed");

            // All downstream steps should be skipped with "dependency failed"
            for (let i = 1; i < chainLength; i++) {
              const stepResult = result.stepResults.get(`s${i}`);
              expect(stepResult?.status).toBe("skipped");
              if (stepResult?.status === "skipped") {
                expect(stepResult.reason).toContain("dependency failed");
              }
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("failure cascades only to dependents, not independent steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 1, max: 4 }),
          async (dependentCount, independentCount) => {
            // s0 fails, has dependentCount dependents
            // There are also independentCount independent steps
            const failNode = makeNode({
              name: "fail",
              handler: async () => { throw new Error("boom"); },
              isRequired: true,
            });

            const dependentNodes = Array.from({ length: dependentCount }, (_, i) =>
              makeNode({
                name: `dep${i}`,
                dependencies: ["fail"],
                handler: async () => `dep${i}-result`,
              })
            );

            const independentNodes = Array.from({ length: independentCount }, (_, i) =>
              makeNode({
                name: `ind${i}`,
                handler: async () => `ind${i}-result`,
              })
            );

            const graph = buildExecutionGraph([failNode, ...dependentNodes, ...independentNodes]);
            const result = await runScheduler({ graph, context: makeContext() });

            expect(result.success).toBe(false);

            // All dependents should be skipped with "dependency failed"
            for (let i = 0; i < dependentCount; i++) {
              const depResult = result.stepResults.get(`dep${i}`);
              expect(depResult?.status).toBe("skipped");
              if (depResult?.status === "skipped") {
                expect(depResult.reason).toContain("dependency failed");
              }
            }

            // Independent steps may have completed or been aborted (pipeline aborts
            // after required failure), but they should NOT be marked "dependency failed"
            for (let i = 0; i < independentCount; i++) {
              const indResult = result.stepResults.get(`ind${i}`);
              expect(indResult).toBeDefined();
              if (indResult?.status === "skipped") {
                // If skipped, it should be due to "pipeline aborted", not "dependency failed"
                expect(indResult.reason).not.toBe("dependency failed");
              }
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Optional failure continues — pipeline succeeds when optional step fails", () => {
    /**
     * **Validates: Requirements 9.1, 9.2, 9.4, 9.5, 9.6, 9.7**
     *
     * When an optional step fails with a defaultValue, the pipeline can still succeed
     * and dependent steps can proceed using the default value.
     */
    it("pipeline succeeds when optional step with default fails", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.anything().filter((v) => v !== undefined),
          fc.integer({ min: 0, max: 3 }),
          async (defaultValue, dependentCount) => {
            const optionalNode = makeNode({
              name: "optional",
              handler: async () => { throw new Error("optional fail"); },
              isRequired: false,
              policies: { defaultValue },
            });

            const dependentNodes = Array.from({ length: dependentCount }, (_, i) =>
              makeNode({
                name: `dep${i}`,
                dependencies: ["optional"],
                handler: async () => `dep${i}-result`,
              })
            );

            const graph = buildExecutionGraph([optionalNode, ...dependentNodes]);
            const result = await runScheduler({ graph, context: makeContext() });

            expect(result.success).toBe(true);
            expect(result.stepResults.get("optional")?.status).toBe("default");
            if (result.stepResults.get("optional")?.status === "default") {
              expect((result.stepResults.get("optional") as any).value).toEqual(defaultValue);
            }

            // Dependents should still execute
            for (let i = 0; i < dependentCount; i++) {
              expect(result.stepResults.get(`dep${i}`)?.status).toBe("success");
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { buildExecutionGraph } from "../../src/graph/execution-graph.js";
import { ValidationError } from "../../src/errors.js";
import type { StepNode } from "../../src/types/graph.js";

/**
 * Property-based tests for Execution Graph
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 13.2, 13.3, 13.6**
 */

// Helper to create minimal StepNode instances for testing
function createNode(
  name: string,
  dependencies: string[] = [],
  isRequired = true
): StepNode {
  return {
    name,
    handler: async () => undefined,
    policies: {},
    dependencies,
    isRequired,
  };
}

/**
 * Arbitrary that generates a valid DAG (directed acyclic graph).
 * Strategy: generate N step names, then for each step at index i,
 * assign dependencies only from steps with lower indices (ensures acyclicity).
 */
const validDAGArb = fc
  .integer({ min: 1, max: 15 })
  .chain((n) => {
    // Generate unique step names
    const names = Array.from({ length: n }, (_, i) => `step_${i}`);
    // For each step, pick dependencies from steps with lower indices
    const depsArbs = names.map((_, i) => {
      if (i === 0) return fc.constant([] as string[]);
      const possibleDeps = names.slice(0, i);
      return fc.shuffledSubarray(possibleDeps, { minLength: 0, maxLength: possibleDeps.length });
    });
    return fc.tuple(...depsArbs).map((allDeps) =>
      names.map((name, i) => ({ name, dependencies: allDeps[i]! }))
    );
  });

/**
 * Arbitrary that generates a graph with a guaranteed cycle.
 * Strategy: pick a cycle length k (2..n), then create steps where
 * step_0 -> step_1 -> ... -> step_(k-1) -> step_0 forms a cycle.
 * Remaining steps (if any) have no dependencies.
 */
const cyclicGraphArb = fc
  .integer({ min: 2, max: 8 })
  .chain((cycleLen) =>
    fc.integer({ min: cycleLen, max: cycleLen + 5 }).map((totalSteps) => {
      const names = Array.from({ length: totalSteps }, (_, i) => `step_${i}`);
      const steps = names.map((name) => ({ name, dependencies: [] as string[] }));
      // Create cycle: step_0 depends on step_1, step_1 depends on step_2, ..., step_(k-1) depends on step_0
      for (let i = 0; i < cycleLen; i++) {
        const nextIdx = (i + 1) % cycleLen;
        steps[i]!.dependencies.push(names[nextIdx]!);
      }
      return steps;
    })
  );

/**
 * Arbitrary that generates a graph with at least one invalid (non-existent) dependency reference.
 */
const invalidRefGraphArb = fc
  .integer({ min: 1, max: 10 })
  .chain((n) => {
    const names = Array.from({ length: n }, (_, i) => `step_${i}`);
    return fc.tuple(
      fc.integer({ min: 0, max: n - 1 }), // which step gets the invalid dep
      fc.string({ minLength: 1, maxLength: 10 }).filter(
        (s) => !names.includes(s) && s.trim().length > 0
      )
    ).map(([stepIdx, invalidName]) => {
      const steps = names.map((name) => ({ name, dependencies: [] as string[] }));
      steps[stepIdx]!.dependencies.push(invalidName);
      return steps;
    });
  });

describe("Execution Graph — Property Tests", () => {
  describe("Property 4: Dependency Order — getReadySteps never returns a step with unsatisfied dependencies", () => {
    it("getReadySteps only returns steps whose dependencies are all in completedSteps", () => {
      fc.assert(
        fc.property(
          validDAGArb,
          fc.context(),
          (dagSpec, ctx) => {
            const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
            const graph = buildExecutionGraph(nodes);
            const allNames = dagSpec.map((s) => s.name);

            // Pick a random subset as "completed"
            const completedArr = allNames.filter(() => Math.random() > 0.5);
            const completedSet = new Set(completedArr);

            const ready = graph.getReadySteps(completedSet);

            for (const step of ready) {
              // Every dependency must be in completedSteps
              for (const dep of step.dependencies) {
                expect(completedSet.has(dep)).toBe(true);
              }
              // Step itself must not be in completedSteps
              expect(completedSet.has(step.name)).toBe(false);
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it("getReadySteps with arbitrary subsets of completedSteps always satisfies dependency constraint", () => {
      fc.assert(
        fc.property(
          validDAGArb.chain((dagSpec) => {
            const allNames = dagSpec.map((s) => s.name);
            return fc.tuple(
              fc.constant(dagSpec),
              fc.shuffledSubarray(allNames, { minLength: 0, maxLength: allNames.length })
            );
          }),
          ([dagSpec, completedArr]) => {
            const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
            const graph = buildExecutionGraph(nodes);
            const completedSet = new Set(completedArr);

            const ready = graph.getReadySteps(completedSet);

            for (const step of ready) {
              for (const dep of step.dependencies) {
                expect(completedSet.has(dep)).toBe(true);
              }
              expect(completedSet.has(step.name)).toBe(false);
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it("completed steps never appear in ready results", () => {
      fc.assert(
        fc.property(
          validDAGArb.chain((dagSpec) => {
            const allNames = dagSpec.map((s) => s.name);
            return fc.tuple(
              fc.constant(dagSpec),
              fc.shuffledSubarray(allNames, { minLength: 0, maxLength: allNames.length })
            );
          }),
          ([dagSpec, completedArr]) => {
            const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
            const graph = buildExecutionGraph(nodes);
            const completedSet = new Set(completedArr);

            const ready = graph.getReadySteps(completedSet);
            const readyNames = ready.map((s) => s.name);

            for (const name of readyNames) {
              expect(completedSet.has(name)).toBe(false);
            }
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("Property 14: Graph Acyclicity and Dependency Validation", () => {
    it("any graph with a cycle throws ValidationError containing CircularDependencyError message", () => {
      fc.assert(
        fc.property(cyclicGraphArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));

          expect(() => buildExecutionGraph(nodes)).toThrow(ValidationError);
          try {
            buildExecutionGraph(nodes);
          } catch (e) {
            expect(e).toBeInstanceOf(ValidationError);
            const ve = e as ValidationError;
            const hasCycleError = ve.errors.some((err) =>
              err.message.includes("Circular dependency")
            );
            expect(hasCycleError).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });

    it("any graph referencing a non-existent step throws ValidationError containing InvalidDependencyError message", () => {
      fc.assert(
        fc.property(invalidRefGraphArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));

          expect(() => buildExecutionGraph(nodes)).toThrow(ValidationError);
          try {
            buildExecutionGraph(nodes);
          } catch (e) {
            expect(e).toBeInstanceOf(ValidationError);
            const ve = e as ValidationError;
            const hasInvalidDepError = ve.errors.some((err) =>
              err.message.includes("does not exist")
            );
            expect(hasInvalidDepError).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });

    it("a valid DAG (no cycles, all deps exist) builds successfully", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));

          // Should not throw
          const graph = buildExecutionGraph(nodes);

          // Graph should be valid
          expect(graph.nodes.size).toBe(nodes.length);
          expect(graph.executionOrder.length).toBeGreaterThan(0);
        }),
        { numRuns: 200 }
      );
    });

    it("when multiple validation errors exist, all are collected in a single ValidationError", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 8 }),
          (n) => {
            // Generate n steps each referencing a different non-existent dep
            const nodes = Array.from({ length: n }, (_, i) =>
              createNode(`step_${i}`, [`nonexistent_${i}`])
            );

            try {
              buildExecutionGraph(nodes);
              // Should not reach here
              expect(true).toBe(false);
            } catch (e) {
              expect(e).toBeInstanceOf(ValidationError);
              const ve = e as ValidationError;
              // All invalid deps should be reported
              expect(ve.errors.length).toBe(n);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Layer Properties — steps in same layer have no mutual dependencies and all layers cover all steps", () => {
    it("steps in the same execution layer have no mutual dependencies", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          for (const layer of graph.executionOrder) {
            const layerSet = new Set(layer.steps);
            for (const stepName of layer.steps) {
              const node = graph.nodes.get(stepName)!;
              // No dependency of this step should be in the same layer
              for (const dep of node.dependencies) {
                expect(layerSet.has(dep)).toBe(false);
              }
            }
          }
        }),
        { numRuns: 200 }
      );
    });

    it("all layers together contain exactly all step names", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          const allStepsFromLayers: string[] = [];
          for (const layer of graph.executionOrder) {
            allStepsFromLayers.push(...layer.steps);
          }

          const expectedNames = dagSpec.map((s) => s.name).sort();
          const actualNames = [...allStepsFromLayers].sort();
          expect(actualNames).toEqual(expectedNames);
        }),
        { numRuns: 200 }
      );
    });

    it("the total of steps across all layers equals the number of input nodes", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          let totalSteps = 0;
          for (const layer of graph.executionOrder) {
            totalSteps += layer.steps.length;
          }
          expect(totalSteps).toBe(nodes.length);
        }),
        { numRuns: 200 }
      );
    });

    it("layer ordering respects dependencies: step in layer[i] only depends on steps in layers[0..i-1]", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          // Build a map from step name to its layer index
          const stepToLayer = new Map<string, number>();
          for (let layerIdx = 0; layerIdx < graph.executionOrder.length; layerIdx++) {
            for (const stepName of graph.executionOrder[layerIdx]!.steps) {
              stepToLayer.set(stepName, layerIdx);
            }
          }

          // For each step, all dependencies must be in earlier layers
          for (const node of graph.nodes.values()) {
            const nodeLayer = stepToLayer.get(node.name)!;
            for (const dep of node.dependencies) {
              const depLayer = stepToLayer.get(dep)!;
              expect(depLayer).toBeLessThan(nodeLayer);
            }
          }
        }),
        { numRuns: 200 }
      );
    });

    it("parallelizable flag is true only when layer has more than one step", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          for (const layer of graph.executionOrder) {
            if (layer.steps.length > 1) {
              expect(layer.parallelizable).toBe(true);
            } else {
              expect(layer.parallelizable).toBe(false);
            }
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("getReadySteps Properties — additional invariants", () => {
    it("with empty completedSteps, only steps with no dependencies are ready", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          const ready = graph.getReadySteps(new Set());
          const readyNames = new Set(ready.map((s) => s.name));

          for (const spec of dagSpec) {
            if (spec.dependencies.length === 0) {
              expect(readyNames.has(spec.name)).toBe(true);
            } else {
              expect(readyNames.has(spec.name)).toBe(false);
            }
          }
        }),
        { numRuns: 200 }
      );
    });

    it("simulating complete execution: repeatedly calling getReadySteps covers all nodes", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          const completed = new Set<string>();
          const allNames = new Set(dagSpec.map((s) => s.name));
          let iterations = 0;
          const maxIterations = dagSpec.length + 1;

          while (completed.size < allNames.size && iterations < maxIterations) {
            const ready = graph.getReadySteps(completed);
            if (ready.length === 0) break;
            for (const step of ready) {
              completed.add(step.name);
            }
            iterations++;
          }

          // All steps should have been processed
          expect(completed.size).toBe(allNames.size);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe("toJSON Properties — produces consistent adjacency structure matching input dependencies", () => {
    it("toJSON keys match exactly the step names in the graph", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          const json = graph.toJSON();
          const jsonKeys = Object.keys(json).sort();
          const expectedKeys = dagSpec.map((s) => s.name).sort();
          expect(jsonKeys).toEqual(expectedKeys);
        }),
        { numRuns: 200 }
      );
    });

    it("toJSON dependency arrays match the input dependencies for each step", () => {
      fc.assert(
        fc.property(validDAGArb, (dagSpec) => {
          const nodes = dagSpec.map((s) => createNode(s.name, s.dependencies));
          const graph = buildExecutionGraph(nodes);

          const json = graph.toJSON();

          for (const spec of dagSpec) {
            const actualDeps = [...json[spec.name]!].sort();
            const expectedDeps = [...spec.dependencies].sort();
            expect(actualDeps).toEqual(expectedDeps);
          }
        }),
        { numRuns: 200 }
      );
    });
  });
});

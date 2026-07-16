import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { resolveInputWiring } from "../../src/execution/input-wiring.js";
import { InputWiringError } from "../../src/errors.js";
import type { StepNode } from "../../src/types/graph.js";

/**
 * Property-based tests for Input Wiring
 *
 * **Property 22: Input Wiring Correctness** — handler receives mapper output, backward compat preserved
 * **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.6, 14.7**
 */

function makeNode(overrides?: Partial<StepNode>): StepNode {
  return {
    name: "testStep",
    handler: async () => undefined,
    policies: {},
    dependencies: [],
    isRequired: true,
    ...overrides,
  };
}

// Arbitraries
const arbStepName = fc.string({ minLength: 1, maxLength: 64 }).filter(
  (s) => !s.includes("\0") && s.trim().length > 0
);

const arbStepValue = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.integer()),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.integer()),
);

const arbStepResults = fc
  .array(fc.tuple(arbStepName, arbStepValue), { minLength: 0, maxLength: 10 })
  .map((pairs) => new Map<string, unknown>(pairs));

const arbNodeName = fc.string({ minLength: 1, maxLength: 64 }).filter(
  (s) => !s.includes("\0") && s.trim().length > 0
);

describe("Input Wiring — Property Tests", () => {
  describe("Backward compatibility: no inputMapper returns undefined", () => {
    it("when node has no inputMapper (undefined), resolveInputWiring always returns undefined regardless of stepResults", () => {
      fc.assert(
        fc.property(arbStepResults, arbNodeName, (stepResults, nodeName) => {
          const node = makeNode({ name: nodeName, inputMapper: undefined });
          const result = resolveInputWiring(node, stepResults);
          expect(result).toBeUndefined();
        })
      );
    });
  });

  describe("Mapper receives all step results and return value is passed through", () => {
    it("the mapper receives all step results and its return value is passed through as the resolved input", () => {
      fc.assert(
        fc.property(arbStepResults, (stepResults) => {
          let receivedKeys: string[] = [];

          const node = makeNode({
            inputMapper: (results) => {
              receivedKeys = Object.keys(results);
              return "mapped-output";
            },
          });

          const result = resolveInputWiring(node, stepResults);

          // Return value is passed through
          expect(result).toBe("mapped-output");

          // Mapper received exactly the keys from the stepResults map
          const expectedKeys = [...stepResults.keys()].sort();
          expect(receivedKeys.sort()).toEqual(expectedKeys);
        })
      );
    });

    it("mapper can return any value type and it is preserved", () => {
      fc.assert(
        fc.property(arbStepValue, arbStepResults, (returnValue, stepResults) => {
          const node = makeNode({
            inputMapper: () => returnValue,
          });

          const result = resolveInputWiring(node, stepResults);
          expect(result).toEqual(returnValue);
        })
      );
    });
  });

  describe("Mapper errors are always wrapped in InputWiringError", () => {
    it("when the mapper throws any error, resolveInputWiring throws InputWiringError with the node name", () => {
      fc.assert(
        fc.property(
          arbNodeName,
          fc.string({ minLength: 1 }),
          arbStepResults,
          (nodeName, errorMsg, stepResults) => {
            const node = makeNode({
              name: nodeName,
              inputMapper: () => {
                throw new Error(errorMsg);
              },
            });

            expect(() => resolveInputWiring(node, stepResults)).toThrow(
              InputWiringError
            );

            try {
              resolveInputWiring(node, stepResults);
            } catch (e) {
              const err = e as InputWiringError;
              expect(err.stepName).toBe(nodeName);
              expect(err.message).toContain(errorMsg);
            }
          }
        )
      );
    });

    it("when the mapper throws a non-Error value, it is still wrapped in InputWiringError", () => {
      fc.assert(
        fc.property(
          arbNodeName,
          fc.string({ minLength: 1 }),
          arbStepResults,
          (nodeName, thrown, stepResults) => {
            const node = makeNode({
              name: nodeName,
              inputMapper: () => {
                throw thrown;
              },
            });

            expect(() => resolveInputWiring(node, stepResults)).toThrow(
              InputWiringError
            );

            try {
              resolveInputWiring(node, stepResults);
            } catch (e) {
              const err = e as InputWiringError;
              expect(err).toBeInstanceOf(InputWiringError);
              expect(err.stepName).toBe(nodeName);
              expect(err.referencedStep).toBeNull();
            }
          }
        )
      );
    });
  });

  describe("Accessing a missing step throws InputWiringError with the referenced step name", () => {
    it("when the mapper accesses a step not in results, InputWiringError is thrown with the referenced step name", () => {
      fc.assert(
        fc.property(
          arbNodeName,
          arbStepName,
          arbStepResults,
          (nodeName, missingStepName, stepResults) => {
            // Ensure the missing step is actually missing
            fc.pre(!stepResults.has(missingStepName));

            const node = makeNode({
              name: nodeName,
              inputMapper: (results) => results[missingStepName],
            });

            expect(() => resolveInputWiring(node, stepResults)).toThrow(
              InputWiringError
            );

            try {
              resolveInputWiring(node, stepResults);
            } catch (e) {
              const err = e as InputWiringError;
              expect(err.stepName).toBe(nodeName);
              expect(err.referencedStep).toBe(missingStepName);
            }
          }
        )
      );
    });
  });

  describe("Mapper receives exactly the step names in stepResults", () => {
    it("the set of keys available to the mapper matches exactly the stepResults map keys", () => {
      fc.assert(
        fc.property(arbStepResults, (stepResults) => {
          let observedKeys: string[] = [];

          const node = makeNode({
            inputMapper: (results) => {
              observedKeys = Object.keys(results);
              return null;
            },
          });

          resolveInputWiring(node, stepResults);

          const expectedKeys = [...stepResults.keys()].sort();
          expect(observedKeys.sort()).toEqual(expectedKeys);
        })
      );
    });

    it("the mapper receives the correct values for each step name", () => {
      fc.assert(
        fc.property(arbStepResults, (stepResults) => {
          const node = makeNode({
            inputMapper: (results) => {
              // Verify each value matches
              for (const [key, value] of stepResults.entries()) {
                expect(results[key]).toEqual(value);
              }
              return null;
            },
          });

          resolveInputWiring(node, stepResults);
        })
      );
    });
  });

  describe("Mapper can compose any combination of available step results", () => {
    it("mapper can select and combine any subset of available step results", () => {
      // Generate a non-empty step results map and a subset of keys to compose
      const arbNonEmptyStepResults = fc
        .array(fc.tuple(arbStepName, fc.integer()), { minLength: 1, maxLength: 10 })
        .map((pairs) => new Map<string, unknown>(pairs));

      fc.assert(
        fc.property(
          arbNonEmptyStepResults,
          fc.nat(),
          (stepResults, seed) => {
            const keys = [...stepResults.keys()];
            // Select a random subset of keys to compose
            const subsetSize = (seed % keys.length) + 1;
            const selectedKeys = keys.slice(0, subsetSize);

            const node = makeNode({
              inputMapper: (results) => {
                const composed: Record<string, unknown> = {};
                for (const k of selectedKeys) {
                  composed[k] = results[k];
                }
                return composed;
              },
            });

            const result = resolveInputWiring(node, stepResults) as Record<string, unknown>;

            // Verify the composed result contains the right values
            for (const k of selectedKeys) {
              expect(result[k]).toEqual(stepResults.get(k));
            }
          }
        )
      );
    });

    it("mapper can transform step results into any structure (array, object, primitive)", () => {
      const arbNonEmptyStepResults = fc
        .array(fc.tuple(arbStepName, fc.integer()), { minLength: 1, maxLength: 5 })
        .map((pairs) => new Map<string, unknown>(pairs));

      fc.assert(
        fc.property(arbNonEmptyStepResults, (stepResults) => {
          const keys = [...stepResults.keys()];

          // Compose into an array of values
          const node = makeNode({
            inputMapper: (results) => keys.map((k) => results[k]),
          });

          const result = resolveInputWiring(node, stepResults) as unknown[];

          expect(result).toHaveLength(keys.length);
          for (let i = 0; i < keys.length; i++) {
            expect(result[i]).toEqual(stepResults.get(keys[i]));
          }
        })
      );
    });
  });
});

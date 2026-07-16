import { describe, it, expect } from "vitest";
import { resolveInputWiring } from "../../src/execution/input-wiring.js";
import { InputWiringError } from "../../src/errors.js";
import type { StepNode } from "../../src/types/graph.js";

function makeNode(overrides: Partial<StepNode> = {}): StepNode {
  return {
    name: "testStep",
    handler: async () => undefined,
    policies: {},
    dependencies: [],
    isRequired: true,
    ...overrides,
  };
}

describe("resolveInputWiring", () => {
  it("returns undefined when node has no inputMapper", () => {
    const node = makeNode({ inputMapper: undefined });
    const stepResults = new Map<string, unknown>([["stepA", 42]]);

    const result = resolveInputWiring(node, stepResults);

    expect(result).toBeUndefined();
  });

  it("invokes the inputMapper with step results and returns mapped value", () => {
    const node = makeNode({
      inputMapper: (results) => results.stepA,
    });
    const stepResults = new Map<string, unknown>([["stepA", 42]]);

    const result = resolveInputWiring(node, stepResults);

    expect(result).toBe(42);
  });

  it("passes all completed step results to the mapper", () => {
    const node = makeNode({
      inputMapper: (results) => ({
        a: results.stepA,
        b: results.stepB,
      }),
    });
    const stepResults = new Map<string, unknown>([
      ["stepA", "hello"],
      ["stepB", 99],
    ]);

    const result = resolveInputWiring(node, stepResults);

    expect(result).toEqual({ a: "hello", b: 99 });
  });

  it("throws InputWiringError when mapper accesses a missing step", () => {
    const node = makeNode({
      name: "myStep",
      inputMapper: (results) => results.nonExistent,
    });
    const stepResults = new Map<string, unknown>([["stepA", 42]]);

    expect(() => resolveInputWiring(node, stepResults)).toThrow(
      InputWiringError
    );

    try {
      resolveInputWiring(node, stepResults);
    } catch (e) {
      expect(e).toBeInstanceOf(InputWiringError);
      const err = e as InputWiringError;
      expect(err.stepName).toBe("myStep");
      expect(err.referencedStep).toBe("nonExistent");
    }
  });

  it("wraps non-InputWiringError mapper errors in InputWiringError", () => {
    const node = makeNode({
      name: "failStep",
      inputMapper: () => {
        throw new Error("unexpected failure");
      },
    });
    const stepResults = new Map<string, unknown>();

    expect(() => resolveInputWiring(node, stepResults)).toThrow(
      InputWiringError
    );

    try {
      resolveInputWiring(node, stepResults);
    } catch (e) {
      expect(e).toBeInstanceOf(InputWiringError);
      const err = e as InputWiringError;
      expect(err.stepName).toBe("failStep");
      expect(err.referencedStep).toBeNull();
      expect(err.message).toContain("unexpected failure");
    }
  });

  it("handles empty step results map", () => {
    const node = makeNode({
      inputMapper: () => "static value",
    });
    const stepResults = new Map<string, unknown>();

    const result = resolveInputWiring(node, stepResults);

    expect(result).toBe("static value");
  });

  it("allows accessing step results that have undefined as their value", () => {
    const node = makeNode({
      inputMapper: (results) => results.stepA,
    });
    const stepResults = new Map<string, unknown>([["stepA", undefined]]);

    const result = resolveInputWiring(node, stepResults);

    expect(result).toBeUndefined();
  });

  it("allows accessing step results that have null as their value", () => {
    const node = makeNode({
      inputMapper: (results) => results.stepA,
    });
    const stepResults = new Map<string, unknown>([["stepA", null]]);

    const result = resolveInputWiring(node, stepResults);

    expect(result).toBeNull();
  });

  it("mapper can compose results from multiple steps", () => {
    const node = makeNode({
      inputMapper: (results) => [
        results.customer,
        results.billing,
        results.inventory,
      ],
    });
    const stepResults = new Map<string, unknown>([
      ["customer", { id: "c1" }],
      ["billing", { account: "b1" }],
      ["inventory", { stock: 5 }],
    ]);

    const result = resolveInputWiring(node, stepResults);

    expect(result).toEqual([
      { id: "c1" },
      { account: "b1" },
      { stock: 5 },
    ]);
  });
});

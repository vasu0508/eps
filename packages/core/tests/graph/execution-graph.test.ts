import { describe, it, expect } from "vitest";
import { buildExecutionGraph } from "../../src/graph/execution-graph.js";
import {
  CircularDependencyError,
  InvalidDependencyError,
  ValidationError,
} from "../../src/errors.js";
import type { StepNode } from "../../src/types/graph.js";

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

describe("buildExecutionGraph", () => {
  describe("basic graph construction", () => {
    it("should build a graph from a single step with no dependencies", () => {
      const nodes = [createNode("A")];
      const graph = buildExecutionGraph(nodes);

      expect(graph.nodes.size).toBe(1);
      expect(graph.nodes.get("A")).toBeDefined();
      expect(graph.edges).toHaveLength(0);
      expect(graph.executionOrder).toHaveLength(1);
      expect(graph.executionOrder[0]!.steps).toEqual(["A"]);
      expect(graph.executionOrder[0]!.parallelizable).toBe(false);
    });

    it("should build a graph with multiple independent steps in one layer", () => {
      const nodes = [createNode("A"), createNode("B"), createNode("C")];
      const graph = buildExecutionGraph(nodes);

      expect(graph.nodes.size).toBe(3);
      expect(graph.edges).toHaveLength(0);
      expect(graph.executionOrder).toHaveLength(1);
      expect(graph.executionOrder[0]!.steps).toEqual(["A", "B", "C"]);
      expect(graph.executionOrder[0]!.parallelizable).toBe(true);
    });

    it("should build a linear chain of dependencies", () => {
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C", ["B"]),
      ];
      const graph = buildExecutionGraph(nodes);

      expect(graph.executionOrder).toHaveLength(3);
      expect(graph.executionOrder[0]!.steps).toEqual(["A"]);
      expect(graph.executionOrder[1]!.steps).toEqual(["B"]);
      expect(graph.executionOrder[2]!.steps).toEqual(["C"]);
      expect(graph.edges).toHaveLength(2);
    });

    it("should partition into layers correctly for a diamond dependency", () => {
      // A -> B, A -> C, B -> D, C -> D
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C", ["A"]),
        createNode("D", ["B", "C"]),
      ];
      const graph = buildExecutionGraph(nodes);

      expect(graph.executionOrder).toHaveLength(3);
      expect(graph.executionOrder[0]!.steps).toEqual(["A"]);
      expect(graph.executionOrder[1]!.steps).toContain("B");
      expect(graph.executionOrder[1]!.steps).toContain("C");
      expect(graph.executionOrder[1]!.parallelizable).toBe(true);
      expect(graph.executionOrder[2]!.steps).toEqual(["D"]);
    });
  });

  describe("cycle detection", () => {
    it("should throw ValidationError with CircularDependencyError for a simple cycle", () => {
      const nodes = [
        createNode("A", ["B"]),
        createNode("B", ["A"]),
      ];

      expect(() => buildExecutionGraph(nodes)).toThrow(ValidationError);
      try {
        buildExecutionGraph(nodes);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ve = e as ValidationError;
        expect(ve.errors.length).toBeGreaterThanOrEqual(1);
        const cycleError = ve.errors.find((err) =>
          err.message.includes("Circular dependency")
        );
        expect(cycleError).toBeDefined();
      }
    });

    it("should detect a 3-node cycle", () => {
      const nodes = [
        createNode("A", ["C"]),
        createNode("B", ["A"]),
        createNode("C", ["B"]),
      ];

      expect(() => buildExecutionGraph(nodes)).toThrow(ValidationError);
      try {
        buildExecutionGraph(nodes);
      } catch (e) {
        const ve = e as ValidationError;
        const cycleError = ve.errors.find((err) =>
          err.message.includes("Circular dependency")
        );
        expect(cycleError).toBeDefined();
      }
    });

    it("should detect self-referencing cycle", () => {
      const nodes = [createNode("A", ["A"])];

      expect(() => buildExecutionGraph(nodes)).toThrow(ValidationError);
    });
  });

  describe("invalid dependency detection", () => {
    it("should throw ValidationError for a non-existent dependency", () => {
      const nodes = [createNode("A", ["NonExistent"])];

      expect(() => buildExecutionGraph(nodes)).toThrow(ValidationError);
      try {
        buildExecutionGraph(nodes);
      } catch (e) {
        const ve = e as ValidationError;
        expect(ve.errors.length).toBe(1);
        expect(ve.errors[0]!.message).toContain("NonExistent");
        expect(ve.errors[0]!.message).toContain("A");
      }
    });

    it("should collect multiple invalid dependency errors", () => {
      const nodes = [
        createNode("A", ["Missing1"]),
        createNode("B", ["Missing2"]),
      ];

      expect(() => buildExecutionGraph(nodes)).toThrow(ValidationError);
      try {
        buildExecutionGraph(nodes);
      } catch (e) {
        const ve = e as ValidationError;
        expect(ve.errors.length).toBe(2);
      }
    });
  });

  describe("getReadySteps", () => {
    it("should return root nodes when no steps are completed", () => {
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C"),
      ];
      const graph = buildExecutionGraph(nodes);

      const ready = graph.getReadySteps(new Set());
      const readyNames = ready.map((n) => n.name).sort();
      expect(readyNames).toEqual(["A", "C"]);
    });

    it("should return dependent steps when dependencies are complete", () => {
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C", ["A"]),
      ];
      const graph = buildExecutionGraph(nodes);

      const ready = graph.getReadySteps(new Set(["A"]));
      const readyNames = ready.map((n) => n.name).sort();
      expect(readyNames).toEqual(["B", "C"]);
    });

    it("should not return a step if not all dependencies are complete", () => {
      const nodes = [
        createNode("A"),
        createNode("B"),
        createNode("C", ["A", "B"]),
      ];
      const graph = buildExecutionGraph(nodes);

      const ready = graph.getReadySteps(new Set(["A"]));
      const readyNames = ready.map((n) => n.name).sort();
      // B is ready (no deps), C is NOT ready (needs B)
      expect(readyNames).toEqual(["B"]);
    });

    it("should not return already completed steps", () => {
      const nodes = [createNode("A"), createNode("B")];
      const graph = buildExecutionGraph(nodes);

      const ready = graph.getReadySteps(new Set(["A"]));
      const readyNames = ready.map((n) => n.name);
      expect(readyNames).toEqual(["B"]);
    });

    it("should return empty array when all steps are completed", () => {
      const nodes = [createNode("A"), createNode("B", ["A"])];
      const graph = buildExecutionGraph(nodes);

      const ready = graph.getReadySteps(new Set(["A", "B"]));
      expect(ready).toHaveLength(0);
    });
  });

  describe("getDependents", () => {
    it("should return nodes that depend on the given step", () => {
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C", ["A"]),
        createNode("D", ["B"]),
      ];
      const graph = buildExecutionGraph(nodes);

      const dependents = graph.getDependents("A");
      const dependentNames = dependents.map((n) => n.name).sort();
      expect(dependentNames).toEqual(["B", "C"]);
    });

    it("should return empty array for leaf nodes", () => {
      const nodes = [createNode("A"), createNode("B", ["A"])];
      const graph = buildExecutionGraph(nodes);

      const dependents = graph.getDependents("B");
      expect(dependents).toHaveLength(0);
    });

    it("should return empty array for non-existent step name", () => {
      const nodes = [createNode("A")];
      const graph = buildExecutionGraph(nodes);

      const dependents = graph.getDependents("NonExistent");
      expect(dependents).toHaveLength(0);
    });
  });

  describe("validate", () => {
    it("should return valid=true for a valid graph", () => {
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
      ];
      const graph = buildExecutionGraph(nodes);

      const result = graph.validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should report valid for a graph with no issues after construction", () => {
      // A graph that passes buildExecutionGraph should also pass validate()
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C", ["A"]),
        createNode("D", ["B", "C"]),
      ];
      const graph = buildExecutionGraph(nodes);

      const result = graph.validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("toJSON", () => {
    it("should return adjacency structure for a simple graph", () => {
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C", ["A", "B"]),
      ];
      const graph = buildExecutionGraph(nodes);

      const json = graph.toJSON();
      expect(json).toEqual({
        A: [],
        B: ["A"],
        C: ["A", "B"],
      });
    });

    it("should return empty arrays for independent steps", () => {
      const nodes = [createNode("A"), createNode("B"), createNode("C")];
      const graph = buildExecutionGraph(nodes);

      const json = graph.toJSON();
      expect(json).toEqual({
        A: [],
        B: [],
        C: [],
      });
    });
  });

  describe("edge cases", () => {
    it("should handle a complex graph with mixed independent and dependent steps", () => {
      // Layer 0: A, E (independent)
      // Layer 1: B (depends on A), F (depends on E)
      // Layer 2: C (depends on B), G (depends on B, F)
      // Layer 3: D (depends on C, G)
      const nodes = [
        createNode("A"),
        createNode("E"),
        createNode("B", ["A"]),
        createNode("F", ["E"]),
        createNode("C", ["B"]),
        createNode("G", ["B", "F"]),
        createNode("D", ["C", "G"]),
      ];
      const graph = buildExecutionGraph(nodes);

      expect(graph.executionOrder.length).toBe(4);

      // Layer 0
      expect(graph.executionOrder[0]!.steps).toContain("A");
      expect(graph.executionOrder[0]!.steps).toContain("E");

      // Layer 1
      expect(graph.executionOrder[1]!.steps).toContain("B");
      expect(graph.executionOrder[1]!.steps).toContain("F");

      // Layer 2
      expect(graph.executionOrder[2]!.steps).toContain("C");
      expect(graph.executionOrder[2]!.steps).toContain("G");

      // Layer 3
      expect(graph.executionOrder[3]!.steps).toEqual(["D"]);
    });

    it("should correctly build edges array", () => {
      const nodes = [
        createNode("A"),
        createNode("B", ["A"]),
        createNode("C", ["A"]),
      ];
      const graph = buildExecutionGraph(nodes);

      expect(graph.edges).toHaveLength(2);
      expect(graph.edges).toContainEqual({ from: "A", to: "B" });
      expect(graph.edges).toContainEqual({ from: "A", to: "C" });
    });
  });
});

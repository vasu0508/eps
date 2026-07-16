// Execution graph builder with topological sort for @workflow/core

import {
  CircularDependencyError,
  InvalidDependencyError,
  ValidationError,
} from "../errors.js";

import type {
  ExecutionGraph,
  StepNode,
  ExecutionLayer,
  DependencyEdge,
  ValidationResult,
  SerializedGraphStructure,
} from "../types/graph.js";

/**
 * Builds an ExecutionGraph from an array of StepNodes.
 *
 * Validates dependencies, detects cycles using Kahn's algorithm,
 * and partitions steps into parallel execution layers.
 *
 * @throws ValidationError if any validation errors are found (cycles, invalid deps)
 */
export function buildExecutionGraph(steps: StepNode[]): ExecutionGraph {
  const nodes = new Map<string, StepNode>();
  for (const step of steps) {
    nodes.set(step.name, step);
  }

  // Collect all validation errors
  const validationErrors: Array<{ message: string }> = [];

  // Build edges and detect invalid dependencies
  const edges: DependencyEdge[] = [];
  for (const step of steps) {
    for (const depName of step.dependencies) {
      if (!nodes.has(depName)) {
        validationErrors.push({
          message: new InvalidDependencyError(step.name, depName).message,
        });
      } else {
        edges.push({ from: depName, to: step.name });
      }
    }
  }

  // Perform topological sort using Kahn's algorithm to detect cycles
  // Only run topological sort if there are no invalid dependency errors
  // (since invalid deps would break the algorithm)
  let executionOrder: ExecutionLayer[] = [];
  detectCycleAndBuildLayers(
    steps,
    edges,
    nodes,
    validationErrors,
    (layers) => {
      executionOrder = layers;
    }
  );

  // If there are any errors, throw ValidationError
  if (validationErrors.length > 0) {
    throw new ValidationError(validationErrors);
  }

  return createExecutionGraph(nodes, edges, executionOrder);
}

/**
 * Detects cycles using Kahn's algorithm and builds execution layers.
 * Returns true if a cycle was detected.
 */
function detectCycleAndBuildLayers(
  steps: StepNode[],
  edges: DependencyEdge[],
  nodes: ReadonlyMap<string, StepNode>,
  errors: Array<{ message: string }>,
  onLayers: (layers: ExecutionLayer[]) => void
): boolean {
  // Build in-degree map (only count edges with valid deps)
  const inDegree = new Map<string, number>();
  for (const step of steps) {
    inDegree.set(step.name, 0);
  }

  // Build adjacency list for outgoing edges
  const outEdges = new Map<string, string[]>();
  for (const step of steps) {
    outEdges.set(step.name, []);
  }

  for (const edge of edges) {
    // Only process edges where both ends exist in the graph
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      const currentDegree = inDegree.get(edge.to);
      if (currentDegree !== undefined) {
        inDegree.set(edge.to, currentDegree + 1);
      }
      const adjacents = outEdges.get(edge.from);
      if (adjacents) {
        adjacents.push(edge.to);
      }
    }
  }

  // Kahn's algorithm: peel off nodes with in-degree 0 in layers
  const layers: ExecutionLayer[] = [];
  const remaining = new Set<string>(nodes.keys());
  const sorted: string[] = [];

  while (remaining.size > 0) {
    const currentLayer: string[] = [];

    for (const stepName of remaining) {
      const degree = inDegree.get(stepName);
      if (degree === 0) {
        currentLayer.push(stepName);
      }
    }

    if (currentLayer.length === 0) {
      // Cycle detected among remaining nodes
      const cycleSteps = findCycle(remaining, outEdges);
      errors.push({
        message: new CircularDependencyError(cycleSteps).message,
      });
      return true;
    }

    // Sort for deterministic ordering within a layer
    currentLayer.sort();

    layers.push({
      steps: currentLayer,
      parallelizable: currentLayer.length > 1,
    });

    // Remove processed nodes and update in-degrees
    for (const stepName of currentLayer) {
      remaining.delete(stepName);
      sorted.push(stepName);

      const adjacents = outEdges.get(stepName) ?? [];
      for (const dependent of adjacents) {
        const deg = inDegree.get(dependent);
        if (deg !== undefined) {
          inDegree.set(dependent, deg - 1);
        }
      }
    }
  }

  onLayers(layers);
  return false;
}

/**
 * Finds a cycle among the remaining nodes using DFS.
 * Returns the step names forming the cycle.
 */
function findCycle(
  remaining: Set<string>,
  outEdges: ReadonlyMap<string, string[]>
): string[] {
  const WHITE = 0; // unvisited
  const GRAY = 1; // in current DFS path
  const BLACK = 2; // fully processed

  const color = new Map<string, number>();
  for (const name of remaining) {
    color.set(name, WHITE);
  }

  const parent = new Map<string, string>();

  for (const startNode of remaining) {
    if (color.get(startNode) !== WHITE) continue;

    const stack: Array<{ node: string; neighborIdx: number }> = [
      { node: startNode, neighborIdx: 0 },
    ];
    color.set(startNode, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = (outEdges.get(frame.node) ?? []).filter((n) =>
        remaining.has(n)
      );

      if (frame.neighborIdx >= neighbors.length) {
        // All neighbors processed
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }

      const neighbor = neighbors[frame.neighborIdx]!;
      frame.neighborIdx++;

      const neighborColor = color.get(neighbor);
      if (neighborColor === GRAY) {
        // Found a cycle! Reconstruct it
        const cycle: string[] = [neighbor];
        for (let i = stack.length - 1; i >= 0; i--) {
          cycle.push(stack[i]!.node);
          if (stack[i]!.node === neighbor) break;
        }
        cycle.reverse();
        return cycle;
      }

      if (neighborColor === WHITE) {
        color.set(neighbor, GRAY);
        parent.set(neighbor, frame.node);
        stack.push({ node: neighbor, neighborIdx: 0 });
      }
    }
  }

  // Shouldn't reach here if called when a cycle exists
  return [...remaining];
}

/**
 * Creates an ExecutionGraph instance with the computed data.
 */
function createExecutionGraph(
  nodes: ReadonlyMap<string, StepNode>,
  edges: ReadonlyArray<DependencyEdge>,
  executionOrder: ReadonlyArray<ExecutionLayer>
): ExecutionGraph {
  // Pre-compute dependents map for fast lookup
  const dependentsMap = new Map<string, StepNode[]>();
  for (const node of nodes.values()) {
    dependentsMap.set(node.name, []);
  }
  for (const edge of edges) {
    const dependents = dependentsMap.get(edge.from);
    const targetNode = nodes.get(edge.to);
    if (dependents && targetNode) {
      dependents.push(targetNode);
    }
  }

  const graph: ExecutionGraph = {
    nodes,
    edges,
    executionOrder,

    getReadySteps(completedSteps: Set<string>): StepNode[] {
      const ready: StepNode[] = [];
      for (const node of nodes.values()) {
        // Skip already completed steps
        if (completedSteps.has(node.name)) continue;

        // Check if all dependencies are completed
        const allDepsComplete = node.dependencies.every((dep) =>
          completedSteps.has(dep)
        );
        if (allDepsComplete) {
          ready.push(node);
        }
      }
      return ready;
    },

    getDependents(stepName: string): StepNode[] {
      return dependentsMap.get(stepName) ?? [];
    },

    validate(): ValidationResult {
      const validationErrors: Array<{ message: string }> = [];

      // Check for invalid dependencies
      for (const node of nodes.values()) {
        for (const dep of node.dependencies) {
          if (!nodes.has(dep)) {
            validationErrors.push({
              message: new InvalidDependencyError(node.name, dep).message,
            });
          }
        }
      }

      // Check for cycles (re-run Kahn's to verify)
      const inDegree = new Map<string, number>();
      for (const node of nodes.values()) {
        inDegree.set(node.name, 0);
      }
      for (const edge of edges) {
        const deg = inDegree.get(edge.to);
        if (deg !== undefined) {
          inDegree.set(edge.to, deg + 1);
        }
      }

      const remaining = new Set<string>(nodes.keys());
      let processedCount = 0;

      while (true) {
        const batch: string[] = [];
        for (const name of remaining) {
          if (inDegree.get(name) === 0) {
            batch.push(name);
          }
        }
        if (batch.length === 0) break;

        for (const name of batch) {
          remaining.delete(name);
          processedCount++;
          for (const edge of edges) {
            if (edge.from === name) {
              const deg = inDegree.get(edge.to);
              if (deg !== undefined) {
                inDegree.set(edge.to, deg - 1);
              }
            }
          }
        }
      }

      if (remaining.size > 0) {
        // Build adjacency for cycle detection
        const outEdges = new Map<string, string[]>();
        for (const name of remaining) {
          outEdges.set(name, []);
        }
        for (const edge of edges) {
          if (remaining.has(edge.from) && remaining.has(edge.to)) {
            outEdges.get(edge.from)?.push(edge.to);
          }
        }
        const cycleSteps = findCycle(remaining, outEdges);
        validationErrors.push({
          message: new CircularDependencyError(cycleSteps).message,
        });
      }

      return {
        valid: validationErrors.length === 0,
        errors: validationErrors,
      };
    },

    toJSON(): SerializedGraphStructure {
      const result: SerializedGraphStructure = {};
      for (const node of nodes.values()) {
        result[node.name] = [...node.dependencies];
      }
      return result;
    },
  };

  return graph;
}

// Execution graph types for @workflow/core

import type {
  StepHandler,
  StepPolicies,
  ErrorTransformer,
} from "../types.js";
import type { BranchDefinition } from "./branch.js";
import type { ForEachConfig } from "./foreach.js";
import type { RepeatConfig } from "./repeat.js";
import type { InputMapper } from "./input-wiring.js";

/**
 * Represents the resolved dependency graph of steps.
 */
export interface ExecutionGraph {
  readonly nodes: ReadonlyMap<string, StepNode>;
  readonly edges: ReadonlyArray<DependencyEdge>;
  readonly executionOrder: ReadonlyArray<ExecutionLayer>;

  getReadySteps(completedSteps: Set<string>): StepNode[];
  getDependents(stepName: string): StepNode[];
  validate(): ValidationResult;
  toJSON(): SerializedGraphStructure;
}

/**
 * A single step node in the execution graph.
 */
export interface StepNode {
  readonly name: string;
  readonly handler: StepHandler<unknown, unknown>;
  readonly policies: StepPolicies;
  readonly dependencies: ReadonlyArray<string>;
  readonly isRequired: boolean;
  readonly inputMapper?: InputMapper<unknown>;
  readonly forEachConfig?: ForEachConfig<unknown, unknown>;
  readonly repeatConfig?: RepeatConfig<unknown>;
  readonly branchDefinition?: BranchDefinition<unknown>;
  readonly errorTransformer?: ErrorTransformer;
}

/**
 * A group of steps that can be executed in parallel.
 */
export interface ExecutionLayer {
  readonly steps: ReadonlyArray<string>;
  readonly parallelizable: boolean;
}

/**
 * A directed edge in the dependency graph.
 */
export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * Result of graph validation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{ message: string }>;
}

/**
 * Serialized graph as adjacency structure.
 */
export interface SerializedGraphStructure {
  [stepName: string]: string[];
}

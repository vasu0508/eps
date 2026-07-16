// Branch-related types for @workflow/core

import type { ExecutionContext, StepHandler, StepPolicies } from "../types.js";

/**
 * Builder for configuring mutually exclusive execution branches.
 */
export interface BranchConfigurator<TContext, TDisc, TResult> {
  when<TBranchResult>(
    value: TDisc,
    handler:
      | StepHandler<TContext, TBranchResult>
      | ((input: unknown) => Promise<TBranchResult>)
  ): BranchConfigurator<TContext, TDisc, TResult | TBranchResult>;

  otherwise<TDefaultResult>(
    handler:
      | StepHandler<TContext, TDefaultResult>
      | ((input: unknown) => Promise<TDefaultResult>)
  ): BranchConfigurator<TContext, TDisc, TResult | TDefaultResult>;
}

/**
 * Complete definition of a branch step.
 */
export interface BranchDefinition<TContext> {
  readonly name: string;
  readonly discriminator: (context: ExecutionContext<TContext>) => unknown;
  readonly branches: ReadonlyMap<unknown, BranchHandler>;
  readonly defaultBranch?: BranchHandler;
}

/**
 * A handler associated with a specific branch value.
 */
export interface BranchHandler {
  readonly handler:
    | StepHandler<unknown, unknown>
    | ((input: unknown) => Promise<unknown>);
  readonly policies?: StepPolicies;
}

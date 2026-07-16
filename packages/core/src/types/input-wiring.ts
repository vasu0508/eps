// Input wiring types for @workflow/core

/**
 * Map of step names to their result values, used by input mappers.
 */
export interface StepResultMap {
  [stepName: string]: unknown;
}

/**
 * A function that maps accumulated step results to a step handler's input.
 */
export type InputMapper<TInput> = (results: StepResultMap) => TInput;

/**
 * Configuration for input wiring on a step.
 */
export interface InputWiringConfig<TInput> {
  readonly mapper: InputMapper<TInput>;
}

// Error transformation types for @workflow/core

/**
 * A function that transforms/enriches errors before retry/fallback evaluation.
 */
export type ErrorTransformer = (error: Error) => Error;

/**
 * Configuration for error transformation on a step.
 */
export interface ErrorTransformConfig {
  readonly transformer: ErrorTransformer;
}

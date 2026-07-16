// Repeat/poll-related types for @workflow/core

/**
 * Builder for configuring repeatUntil (polling) step execution.
 */
export interface RepeatConfigurator<TContext, TResult> {
  maxIterations(count: number): RepeatConfigurator<TContext, TResult>;
  delay(ms: number): RepeatConfigurator<TContext, TResult>;
}

/**
 * Configuration for repeat/poll step execution.
 */
export interface RepeatConfig<TResult> {
  readonly predicate: (result: TResult) => boolean;
  readonly maxIterations: number;
  readonly delay: number;
}

/**
 * Report for repeat/poll step execution.
 */
export interface RepeatReport {
  readonly iterations: RepeatIteration[];
  readonly finalIteration: number;
  readonly predicateSatisfied: boolean;
}

/**
 * Record of a single repeat iteration.
 */
export interface RepeatIteration {
  readonly iteration: number;
  readonly duration: number;
  readonly result: unknown;
  readonly predicateResult: boolean;
}

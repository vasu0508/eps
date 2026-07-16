// ForEach-related types for @workflow/core

import type { ExecutionContext } from "../types.js";

/**
 * Builder for configuring forEach (fan-out) step execution.
 */
export interface ForEachConfigurator<TContext, TItem, TResult> {
  maxConcurrency(limit: number): ForEachConfigurator<TContext, TItem, TResult>;
}

/**
 * Configuration for forEach step execution.
 */
export interface ForEachConfig<TContext, TItem> {
  readonly mapper: (context: ExecutionContext<TContext>) => TItem[];
  readonly maxConcurrency: number;
}

/**
 * Result of a forEach step execution.
 */
export interface ForEachResult<TResult> {
  readonly results: TResult[];
  readonly errors: ForEachElementError[];
  readonly totalElements: number;
  readonly successCount: number;
  readonly failureCount: number;
}

/**
 * Error details for a single failed element in a forEach execution.
 */
export interface ForEachElementError {
  readonly index: number;
  readonly element: unknown;
  readonly error: Error;
}

// Sub-pipeline executor for @workflow/core
// Enables composing pipelines as steps within other pipelines.

import type { ExecutionReport } from "../types.js";

/**
 * Result of executing a sub-pipeline within a parent step.
 */
export interface SubPipelineResult {
  success: boolean;
  value?: unknown;
  error?: Error;
  report?: ExecutionReport;
}

/**
 * Interface representing a pipeline that can be executed as a sub-pipeline.
 * This will be implemented by PipelineBuilder in task 15.1.
 *
 * Duck-typed: any object with a conforming `execute` method qualifies.
 */
export interface ExecutablePipeline {
  execute(options?: {
    signal?: AbortSignal;
    correlationId?: string;
    timeout?: number;
    context?: unknown;
  }): Promise<SubPipelineResult>;
}

/**
 * Options for sub-pipeline execution within a parent step.
 */
export interface SubPipelineExecutionOptions {
  /** Abort signal propagated from the parent pipeline. */
  signal?: AbortSignal;
  /** Correlation ID from the parent pipeline execution. */
  correlationId?: string;
  /** Timeout in milliseconds wrapping the entire sub-pipeline execution. */
  timeout?: number;
  /** Mapped context from the parent step's `.input(mapper)` result. */
  context?: unknown;
}

/**
 * Checks if a handler is a sub-pipeline (duck-typing: has an `execute` method).
 *
 * This is used by the step executor/scheduler to detect when a step's handler
 * is actually a sub-pipeline that should be composed rather than directly invoked.
 *
 * @param handler - The handler to check
 * @returns true if the handler conforms to the ExecutablePipeline interface
 */
export function isSubPipeline(handler: unknown): handler is ExecutablePipeline {
  return (
    handler !== null &&
    typeof handler === "object" &&
    "execute" in handler &&
    typeof (handler as Record<string, unknown>).execute === "function"
  );
}

/**
 * Executes a sub-pipeline within the parent step's execution scope.
 *
 * Behavior:
 * 1. Calls `pipeline.execute(options)` passing the abort signal, correlationId, and mapped context.
 * 2. If sub-pipeline succeeds → returns { success: true, value, report }.
 * 3. If sub-pipeline fails → returns { success: false, error, report }.
 *
 * Design notes:
 * - Parent abort signal propagation is handled by passing signal in options.
 *   The sub-pipeline is responsible for observing the signal and cancelling its steps.
 * - Parent timeout is handled by the step executor wrapping this call in its timeout policy.
 * - Re-execution on retry is handled by the step executor's retry loop — each retry
 *   calls this function fresh, re-executing the entire sub-pipeline from scratch.
 *
 * @param pipeline - The sub-pipeline to execute
 * @param options - Execution options including signal, correlationId, timeout, and context
 * @returns A SubPipelineResult describing the outcome
 */
export async function executeSubPipeline(
  pipeline: ExecutablePipeline,
  options: SubPipelineExecutionOptions
): Promise<SubPipelineResult> {
  try {
    const result = await pipeline.execute({
      signal: options.signal,
      correlationId: options.correlationId,
      timeout: options.timeout,
      context: options.context,
    });

    if (result.success) {
      return {
        success: true,
        value: result.value,
        report: result.report,
      };
    }

    return {
      success: false,
      error: result.error,
      report: result.report,
    };
  } catch (err) {
    // If the sub-pipeline throws rather than returning a failure result,
    // wrap it as a failed SubPipelineResult.
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      success: false,
      error,
    };
  }
}

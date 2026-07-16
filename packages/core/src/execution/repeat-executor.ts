// Repeat/poll executor for @workflow/core

import type { RepeatConfig, RepeatReport, RepeatIteration } from "../types/repeat.js";
import { CancellationError, MaxIterationsExhaustedError, PredicateError } from "../errors.js";

/**
 * Result of a repeat execution containing the final value and iteration report.
 */
export interface RepeatExecutionResult {
  value: unknown;
  report: RepeatReport;
}

/**
 * Executes a polling loop that calls the handler repeatedly until the predicate
 * returns true or maxIterations is exhausted.
 *
 * Algorithm:
 * 1. For each iteration 1..maxIterations:
 *    a. Invoke handler() — if it throws, fail immediately with that error
 *    b. Evaluate predicate(result) — if it throws, throw PredicateError
 *    c. Record the iteration in report
 *    d. If predicate returns true → return result with predicateSatisfied=true
 *    e. If predicate returns false and more iterations remain → wait delay ms
 *    f. Check abort signal between iterations
 * 2. If maxIterations exhausted → throw MaxIterationsExhaustedError
 *
 * @param config - Repeat configuration with predicate, maxIterations, and delay
 * @param handler - Async function to invoke each iteration
 * @param abortSignal - Optional signal to cancel execution between iterations
 * @returns The final result value and a RepeatReport with iteration details
 */
export async function executeRepeatUntil(
  config: RepeatConfig<unknown>,
  handler: () => Promise<unknown>,
  abortSignal?: AbortSignal
): Promise<RepeatExecutionResult> {
  const iterations: RepeatIteration[] = [];
  let lastResult: unknown;

  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    // Check abort signal before each iteration (after the first)
    if (iteration > 1 && abortSignal?.aborted) {
      throw new CancellationError(
        abortSignal.reason ?? "Operation was cancelled"
      );
    }

    const iterationStart = Date.now();

    // Step a: Invoke handler — fail immediately if it throws
    let result: unknown;
    try {
      result = await handler();
    } catch (handlerError) {
      // Fail immediately with the handler's error
      throw handlerError instanceof Error
        ? handlerError
        : new Error(String(handlerError));
    }

    lastResult = result;

    // Step b: Evaluate predicate — wrap errors in PredicateError
    let predicateResult: boolean;
    try {
      predicateResult = config.predicate(result);
    } catch (predicateError) {
      throw new PredicateError(
        predicateError instanceof Error
          ? predicateError
          : new Error(String(predicateError))
      );
    }

    const duration = Date.now() - iterationStart;

    // Step c: Record iteration
    iterations.push({
      iteration,
      duration,
      result,
      predicateResult,
    });

    // Step d: Predicate satisfied → return
    if (predicateResult) {
      return {
        value: result,
        report: {
          iterations,
          finalIteration: iteration,
          predicateSatisfied: true,
        },
      };
    }

    // Step e: If more iterations remain, apply delay (not after the last iteration)
    if (iteration < config.maxIterations && config.delay > 0) {
      await sleepWithAbort(config.delay, abortSignal);
    }

    // Step f: Check abort signal after delay
    if (abortSignal?.aborted) {
      throw new CancellationError(
        abortSignal.reason ?? "Operation was cancelled"
      );
    }
  }

  // All iterations exhausted without predicate satisfaction
  throw new MaxIterationsExhaustedError(config.maxIterations, lastResult);
}

/**
 * Sleeps for the specified duration, resolving early if the abort signal fires.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve();
    }

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// Step executor with full policy chain for @workflow/core

import type {
  ExecutionContext,
  StepResult,
  RetryAttempt,
  FallbackAttempt,
  ErrorTransformation,
} from "../types.js";
import type { StepNode } from "../types/graph.js";
import { CancellationError, CircuitOpenError } from "../errors.js";
import { resolveInputWiring } from "./input-wiring.js";
import { applyErrorTransformation } from "../policies/error-transformer.js";
import { evaluateBranch } from "./branch-evaluator.js";
import { executeForEach } from "./foreach-executor.js";
import { executeRepeatUntil } from "./repeat-executor.js";

/**
 * Extended step execution metadata for reporting purposes.
 */
export interface StepExecutionMetadata {
  retryHistory: RetryAttempt[];
  fallbackHistory: FallbackAttempt[];
  errorTransformations: ErrorTransformation[];
}

/**
 * Executes a single step node with the full policy chain:
 * 1. Resolve input wiring (if configured)
 * 2. Circuit breaker check — fail fast if open
 * 3. Primary execution with retry loop
 * 4. Fallback chain (declaration order, short-circuit on success)
 * 5. All policies exhausted → fail
 *
 * Records StepResult with duration, attempts, retry/fallback history.
 *
 * @param node - The step node to execute
 * @param context - The execution context for this step
 * @param stepResults - Map of completed step names to their result values
 * @returns A StepResult describing the outcome of this step execution
 */
export async function executeStep(
  node: StepNode,
  context: ExecutionContext<unknown>,
  stepResults: Map<string, unknown>
): Promise<StepResult<unknown> & { metadata?: StepExecutionMetadata }> {
  const startTime = Date.now();
  const retryHistory: RetryAttempt[] = [];
  const fallbackHistory: FallbackAttempt[] = [];
  const errorTransformations: ErrorTransformation[] = [];

  const elapsed = () => Date.now() - startTime;

  // Check abort signal before starting
  if (context.abortSignal.aborted) {
    return {
      status: "failed",
      error: new CancellationError(
        context.abortSignal.reason ?? "Operation was cancelled"
      ),
      duration: elapsed(),
      attempts: 0,
      metadata: { retryHistory, fallbackHistory, errorTransformations },
    };
  }

  // Phase 0: Resolve input wiring
  let mappedInput: unknown | undefined;
  try {
    mappedInput = resolveInputWiring(node, stepResults);
  } catch (wiringError) {
    return {
      status: "failed",
      error: wiringError instanceof Error ? wiringError : new Error(String(wiringError)),
      duration: elapsed(),
      attempts: 0,
      metadata: { retryHistory, fallbackHistory, errorTransformations },
    };
  }

  // Phase 1: Circuit breaker check
  if (node.policies.circuitBreaker) {
    if (node.policies.circuitBreaker.state === "open") {
      const cbError = new CircuitOpenError(node.name, 0);
      return {
        status: "failed",
        error: cbError,
        duration: elapsed(),
        attempts: 0,
        metadata: { retryHistory, fallbackHistory, errorTransformations },
      };
    }
  }

  // Phase 2: Primary execution with retry loop
  let lastError: Error | null = null;
  const maxAttempts = 1 + (node.policies.retry?.maxAttempts ?? 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check cancellation before each attempt
    if (context.abortSignal.aborted) {
      return {
        status: "failed",
        error: new CancellationError(
          context.abortSignal.reason ?? "Operation was cancelled"
        ),
        duration: elapsed(),
        attempts: attempt - 1,
        metadata: { retryHistory, fallbackHistory, errorTransformations },
      };
    }

    const attemptStart = Date.now();

    try {
      const result = await invokeHandler(node, context, mappedInput);

      // Record success with circuit breaker
      if (node.policies.circuitBreaker) {
        node.policies.circuitBreaker.recordSuccess();
      }

      return {
        status: "success",
        value: result,
        duration: elapsed(),
        attempts: attempt,
        metadata: { retryHistory, fallbackHistory, errorTransformations },
      };
    } catch (rawError) {
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));

      // Apply error transformation before retry evaluation
      const transformedError = applyErrorTransformation(
        error,
        node.policies.errorTransformer ?? node.errorTransformer
      );

      // Record transformation if it changed the error
      if (transformedError !== error) {
        errorTransformations.push({
          originalError: { name: error.name, message: error.message },
          transformedError: { name: transformedError.name, message: transformedError.message },
        });
      }

      lastError = transformedError;

      // Record failure with circuit breaker
      if (node.policies.circuitBreaker) {
        node.policies.circuitBreaker.recordFailure();
      }

      // Determine if we should retry
      if (attempt < maxAttempts && node.policies.retry) {
        const shouldRetry = node.policies.retry.shouldRetry(transformedError, attempt);
        if (!shouldRetry) {
          // retryOn rejected — break to fallback chain
          const attemptDuration = Date.now() - attemptStart;
          retryHistory.push({
            attempt,
            duration: attemptDuration,
            error: { name: transformedError.name, message: transformedError.message },
            delay: 0,
          });
          break;
        }

        // Get delay and record retry history
        const delay = node.policies.retry.getDelay(attempt);
        const attemptDuration = Date.now() - attemptStart;
        retryHistory.push({
          attempt,
          duration: attemptDuration,
          error: { name: transformedError.name, message: transformedError.message },
          delay,
        });

        // Wait for backoff delay, but respect abort signal
        await sleepWithAbort(delay, context.abortSignal);
      } else if (attempt < maxAttempts && !node.policies.retry) {
        // No retry policy but more attempts shouldn't happen (maxAttempts would be 1)
        break;
      }
      // If this is the last attempt, just let the loop end
    }
  }

  // Phase 3: Fallback chain
  if (node.policies.fallbacks && node.policies.fallbacks.length > 0) {
    for (let index = 0; index < node.policies.fallbacks.length; index++) {
      // Check cancellation before each fallback
      if (context.abortSignal.aborted) {
        return {
          status: "failed",
          error: new CancellationError(
            context.abortSignal.reason ?? "Operation was cancelled"
          ),
          duration: elapsed(),
          attempts: maxAttempts,
          metadata: { retryHistory, fallbackHistory, errorTransformations },
        };
      }

      const fallbackStart = Date.now();
      const fallbackHandler = node.policies.fallbacks[index]!;

      try {
        const result = await invokeFallbackHandler(
          fallbackHandler,
          node,
          context
        );
        const fallbackDuration = Date.now() - fallbackStart;
        fallbackHistory.push({ index, duration: fallbackDuration, success: true });

        return {
          status: "fallback",
          value: result,
          duration: elapsed(),
          fallbackIndex: index,
          metadata: { retryHistory, fallbackHistory, errorTransformations },
        };
      } catch (fallbackError) {
        const fbError =
          fallbackError instanceof Error
            ? fallbackError
            : new Error(String(fallbackError));
        const fallbackDuration = Date.now() - fallbackStart;
        fallbackHistory.push({
          index,
          duration: fallbackDuration,
          success: false,
          error: { name: fbError.name, message: fbError.message },
        });
        // Update lastError so the final failure reports the last fallback's error
        lastError = fbError;
      }
    }
  }

  // Phase 4: All policies exhausted → fail
  return {
    status: "failed",
    error: lastError ?? new Error("Step execution failed"),
    duration: elapsed(),
    attempts: maxAttempts,
    metadata: { retryHistory, fallbackHistory, errorTransformations },
  };
}

/**
 * Invokes the step handler with timeout wrapping (if configured).
 * If the step has a branchDefinition, dispatches to the branch evaluator.
 * If the step has forEachConfig, dispatches to the forEach executor.
 * If the step has repeatConfig, dispatches to the repeat executor.
 * If input wiring produced a mapped input, the handler is called with that;
 * otherwise, the handler receives the ExecutionContext.
 */
async function invokeHandler(
  node: StepNode,
  context: ExecutionContext<unknown>,
  mappedInput: unknown | undefined
): Promise<unknown> {
  // Branch step: dispatch to branch evaluator
  if (node.branchDefinition) {
    const branchResult = await evaluateBranch(node.branchDefinition, context);
    return branchResult.value;
  }

  // ForEach step: dispatch to forEach executor
  if (node.forEachConfig) {
    const forEachResult = await executeForEach(
      node.forEachConfig,
      async (element: unknown, _index: number) => {
        return node.handler({ ...context, userContext: element } as ExecutionContext<unknown>);
      },
      context,
      node.isRequired
    );
    return forEachResult.results;
  }

  // RepeatUntil step: dispatch to repeat executor
  if (node.repeatConfig) {
    const repeatResult = await executeRepeatUntil(
      node.repeatConfig,
      async () => node.handler(context),
      context.abortSignal
    );
    return repeatResult.value;
  }

  const handlerFn = () => {
    if (mappedInput !== undefined) {
      // Input-wired: call handler with mapped input as a pure function
      return (node.handler as (input: unknown) => Promise<unknown>)(mappedInput);
    }
    // Standard: call handler with ExecutionContext
    return node.handler(context);
  };

  if (node.policies.timeout) {
    return node.policies.timeout.wrap(handlerFn, context.abortSignal);
  }

  return handlerFn();
}

/**
 * Invokes a fallback handler with timeout wrapping (if configured on the step).
 * Fallback handlers receive the full ExecutionContext.
 */
async function invokeFallbackHandler(
  fallbackHandler: (context: ExecutionContext<unknown>) => Promise<unknown>,
  node: StepNode,
  context: ExecutionContext<unknown>
): Promise<unknown> {
  const handlerFn = () => fallbackHandler(context);

  if (node.policies.timeout) {
    return node.policies.timeout.wrap(handlerFn, context.abortSignal);
  }

  return handlerFn();
}

/**
 * Sleeps for the specified duration, but resolves early if the abort signal fires.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve();
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Branch evaluator for @workflow/core

import type { ExecutionContext } from "../types.js";
import type { BranchDefinition, BranchHandler } from "../types/branch.js";
import {
  BranchNotMatchedError,
  BranchDiscriminatorError,
} from "../errors.js";

/**
 * Result of evaluating a branch step.
 */
export interface BranchEvaluationResult {
  value: unknown;
  branchSelected: unknown;
  duration: number;
}

/**
 * Evaluates a branch definition by:
 * 1. Running the discriminator to determine the branch key
 * 2. Matching against registered .when() values using strict equality
 * 3. Executing the matched handler or .otherwise() default
 * 4. Failing with appropriate errors if no match/discriminator throws
 *
 * @param branchDefinition - The branch configuration to evaluate
 * @param context - The execution context passed to handlers
 * @returns The result of the selected branch handler
 */
export async function evaluateBranch(
  branchDefinition: BranchDefinition<unknown>,
  context: ExecutionContext<unknown>
): Promise<BranchEvaluationResult> {
  const startTime = Date.now();

  // Step 1: Evaluate the discriminator
  let discriminatorValue: unknown;
  try {
    discriminatorValue = branchDefinition.discriminator(context);
  } catch (error) {
    throw new BranchDiscriminatorError(
      branchDefinition.name,
      error instanceof Error ? error : new Error(String(error))
    );
  }

  // Step 2: Find matching branch using strict equality
  let matchedHandler: BranchHandler | undefined;
  let selectedKey: unknown = discriminatorValue;

  for (const [key, handler] of branchDefinition.branches) {
    if (key === discriminatorValue) {
      matchedHandler = handler;
      selectedKey = key;
      break;
    }
  }

  // Step 3: Fall back to defaultBranch if no match
  if (!matchedHandler) {
    if (branchDefinition.defaultBranch) {
      matchedHandler = branchDefinition.defaultBranch;
      selectedKey = discriminatorValue;
    } else {
      throw new BranchNotMatchedError(
        branchDefinition.name,
        discriminatorValue
      );
    }
  }

  // Step 4: Execute the matched handler with optional timeout policy
  const value = await invokeHandlerWithPolicies(matchedHandler, context);

  return {
    value,
    branchSelected: selectedKey,
    duration: Date.now() - startTime,
  };
}

/**
 * Invokes a branch handler, applying individual policies if configured.
 * Currently supports timeout policy on branch handlers.
 */
async function invokeHandlerWithPolicies(
  branchHandler: BranchHandler,
  context: ExecutionContext<unknown>
): Promise<unknown> {
  const handlerFn = () => branchHandler.handler(context);

  if (branchHandler.policies?.timeout) {
    return branchHandler.policies.timeout.wrap(handlerFn, context.abortSignal);
  }

  return handlerFn();
}

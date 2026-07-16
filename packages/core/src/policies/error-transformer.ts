// Error transformer policy for @workflow/core

import { ErrorTransformResultError } from "../errors.js";
import type { ErrorTransformer } from "../types.js";

/**
 * Applies a single error transformation.
 *
 * - If `transformer` is undefined, returns the original error unchanged.
 * - If the transformer returns a non-Error value, wraps it in ErrorTransformResultError.
 * - If the transformer itself throws, the thrown value replaces the original error.
 *   If the thrown value is not an Error instance, it is wrapped in ErrorTransformResultError.
 *
 * @param error - The original error to transform
 * @param transformer - A single error transformer function, or undefined
 * @returns The transformed (or original) error
 */
export function applyErrorTransformation(
  error: Error,
  transformer: ErrorTransformer | undefined
): Error {
  if (transformer === undefined) {
    return error;
  }

  try {
    const result = transformer(error);

    if (!(result instanceof Error)) {
      return new ErrorTransformResultError(
        "mapError must return an Error instance"
      );
    }

    return result;
  } catch (thrown: unknown) {
    if (thrown instanceof Error) {
      return thrown;
    }
    return new ErrorTransformResultError(
      `mapError threw a non-Error value: ${String(thrown)}`
    );
  }
}

/**
 * Applies a chain of error transformers in order.
 * The output of the first transformer becomes the input to the second, and so on.
 *
 * - If `transformers` is undefined or empty, returns the original error unchanged.
 * - Each transform in the chain is applied via `applyErrorTransformation`.
 *
 * @param error - The original error to transform
 * @param transformers - An array of error transformer functions, or undefined
 * @returns The final transformed error after all transformers have been applied
 */
export function applyErrorTransformationChain(
  error: Error,
  transformers: ErrorTransformer[] | undefined
): Error {
  if (transformers === undefined || transformers.length === 0) {
    return error;
  }

  let current = error;
  for (const transformer of transformers) {
    current = applyErrorTransformation(current, transformer);
  }
  return current;
}

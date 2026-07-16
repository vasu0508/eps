// Retry policy implementation with fixed, exponential, and linear backoff strategies.

import type { BackoffStrategy, RetryOptions, RetryPolicy } from "../types.js";

/**
 * Creates a RetryPolicy from the given count and options.
 *
 * @param count - Number of retries (1–10 inclusive). Total invocations = count + 1.
 * @param options - Optional backoff, baseDelay, maxDelay, and retryOn predicate.
 * @returns A fully configured RetryPolicy instance.
 */
export function createRetryPolicy(
  count: number,
  options?: RetryOptions
): RetryPolicy {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 10
  ) {
    throw new RangeError(
      `Retry count must be an integer between 1 and 10 inclusive, got ${count}`
    );
  }

  const backoff: BackoffStrategy = options?.backoff ?? "fixed";
  const baseDelay = options?.baseDelay ?? 1000;
  const maxDelay = options?.maxDelay ?? 30000;
  const retryOn = options?.retryOn;

  if (baseDelay < 100 || baseDelay > 60000) {
    throw new RangeError(
      `baseDelay must be between 100 and 60000 ms inclusive, got ${baseDelay}`
    );
  }

  if (maxDelay < 0) {
    throw new RangeError(`maxDelay must be non-negative, got ${maxDelay}`);
  }

  return {
    maxAttempts: count,
    backoff,

    shouldRetry(error: Error, attempt: number): boolean {
      // If we've exhausted all retries, don't retry
      if (attempt >= count) {
        return false;
      }

      // If a retryOn predicate is provided, it must accept the error
      if (retryOn && !retryOn(error)) {
        return false;
      }

      return true;
    },

    getDelay(attempt: number): number {
      let delay: number;

      switch (backoff) {
        case "fixed":
          delay = baseDelay;
          break;
        case "exponential":
          // baseDelay * 2^(attempt-1)
          delay = baseDelay * Math.pow(2, attempt - 1);
          break;
        case "linear":
          // baseDelay * attempt
          delay = baseDelay * attempt;
          break;
        default:
          delay = baseDelay;
          break;
      }

      // Cap at maxDelay
      return Math.min(delay, maxDelay);
    },
  };
}

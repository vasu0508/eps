// Timeout policy implementation for @workflow/core

import { TimeoutError, CancellationError } from "../errors.js";
import type { TimeoutPolicy } from "../types.js";

/**
 * Options for creating a timeout policy.
 */
export interface CreateTimeoutPolicyOptions {
  /** Timeout duration in milliseconds. Must be a finite positive number. */
  ms: number;
  /** Optional step name for contextual error messages. */
  stepName?: string;
}

/**
 * Creates a TimeoutPolicy that enforces a time limit on function execution.
 *
 * The policy:
 * 1. Creates an AbortController linked to the incoming signal
 * 2. Starts a timer for `ms` milliseconds
 * 3. If the timer fires first, aborts the controller and rejects with TimeoutError
 * 4. If the function resolves first, clears the timer and returns the result
 * 5. If the function rejects first, clears the timer and propagates the error
 * 6. If the incoming signal is already aborted, rejects immediately
 */
export function createTimeoutPolicy(options: CreateTimeoutPolicyOptions): TimeoutPolicy {
  const { ms, stepName } = options;

  return {
    ms,

    wrap<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
      // If the incoming signal is already aborted, reject immediately
      if (signal.aborted) {
        return Promise.reject(
          new CancellationError(signal.reason ?? "Operation was cancelled")
        );
      }

      return new Promise<T>((resolve, reject) => {
        // Create a linked AbortController that aborts when either:
        // - The timeout fires
        // - The incoming signal is aborted
        const controller = new AbortController();
        let settled = false;

        // Start the timeout timer
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            controller.abort(new TimeoutError(ms, stepName));
            cleanup();
            reject(new TimeoutError(ms, stepName));
          }
        }, ms);

        // Listen for external abort signal
        const onAbort = () => {
          if (!settled) {
            settled = true;
            controller.abort(signal.reason);
            cleanup();
            reject(
              new CancellationError(signal.reason ?? "Operation was cancelled")
            );
          }
        };

        signal.addEventListener("abort", onAbort);

        function cleanup() {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        }

        // Execute the function, passing the linked abort signal via closure
        // The caller can access the linked signal through the AbortController
        // that the timeout policy manages
        fn()
          .then((value) => {
            if (!settled) {
              settled = true;
              cleanup();
              resolve(value);
            }
          })
          .catch((error) => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(error);
            }
          });
      });
    },
  };
}

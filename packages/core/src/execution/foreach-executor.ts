// ForEach executor with concurrency control for @workflow/core

import type {
  ExecutionContext,
  ForEachReport,
  ForEachElementReport,
} from "../types.js";
import type { ForEachConfig, ForEachElementError } from "../types/foreach.js";
import { ForEachMapperError, ForEachPartialError } from "../errors.js";

/**
 * Result of a forEach execution containing collected results and report.
 */
export interface ForEachExecutionResult {
  results: unknown[];
  report: ForEachReport;
}

/**
 * Simple semaphore for concurrency limiting.
 * Allows up to `limit` concurrent acquisitions.
 */
class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.limit) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}

/**
 * Executes a forEach (fan-out) step with concurrency control.
 *
 * 1. Extracts collection via config.mapper(context) — throws ForEachMapperError on failure
 * 2. Validates mapper returns an array — throws ForEachMapperError if not
 * 3. If empty array → returns immediately with empty results
 * 4. Processes elements in parallel with semaphore-based concurrency limiting
 * 5. Collects results in index order (results[index] = value)
 * 6. If isRequired and any element fails → aborts remaining and throws ForEachPartialError
 * 7. If !isRequired and elements fail → puts undefined for failed, continues others
 * 8. Tracks ForEachReport with per-element outcomes
 *
 * @param config - ForEach configuration with mapper and maxConcurrency
 * @param handler - Handler function to invoke for each element
 * @param context - The execution context
 * @param isRequired - Whether failure should abort remaining elements
 * @returns ForEachExecutionResult with results array and report
 */
export async function executeForEach(
  config: ForEachConfig<unknown, unknown>,
  handler: (element: unknown, index: number) => Promise<unknown>,
  context: ExecutionContext<unknown>,
  isRequired: boolean
): Promise<ForEachExecutionResult> {
  // Step 1: Extract collection via mapper
  let collection: unknown;
  try {
    collection = config.mapper(context);
  } catch (error) {
    throw new ForEachMapperError(
      error instanceof Error ? error : new Error(String(error))
    );
  }

  // Step 2: Validate mapper returns an array
  if (!Array.isArray(collection)) {
    throw new ForEachMapperError("mapper must return an array");
  }

  const items: unknown[] = collection;

  // Step 3: Empty array — immediate success
  if (items.length === 0) {
    return {
      results: [],
      report: {
        totalElements: 0,
        successCount: 0,
        failureCount: 0,
        elementResults: [],
      },
    };
  }

  // Step 4-8: Process elements with concurrency control
  const concurrencyLimit = config.maxConcurrency === Infinity
    ? items.length
    : Math.max(1, config.maxConcurrency);
  const semaphore = new Semaphore(concurrencyLimit);

  const results: unknown[] = new Array(items.length);
  const elementResults: ForEachElementReport[] = new Array(items.length);
  const errors: ForEachElementError[] = [];

  // AbortController to cancel remaining work on required step failure
  const abortController = new AbortController();
  let aborted = false;

  const processElement = async (element: unknown, index: number): Promise<void> => {
    // Check if we should abort before acquiring semaphore
    if (aborted) return;

    await semaphore.acquire();

    // Check again after acquiring (another element may have failed while waiting)
    if (aborted) {
      semaphore.release();
      return;
    }

    const elementStart = Date.now();

    try {
      const result = await handler(element, index);
      const duration = Date.now() - elementStart;

      results[index] = result;
      elementResults[index] = {
        index,
        status: "success",
        duration,
      };
    } catch (rawError) {
      const duration = Date.now() - elementStart;
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));

      elementResults[index] = {
        index,
        status: "failed",
        duration,
        error: { name: error.name, message: error.message },
      };

      errors.push({ index, element, error });

      if (isRequired) {
        // Abort remaining elements
        aborted = true;
        abortController.abort();
        results[index] = undefined;
      } else {
        // Optional: put undefined for failed element, continue
        results[index] = undefined;
      }
    } finally {
      semaphore.release();
    }
  };

  // Launch all element processing concurrently (semaphore limits actual parallelism)
  const promises = items.map((element, index) => processElement(element, index));
  await Promise.all(promises);

  // Build report
  const successCount = elementResults.filter(
    (r) => r && r.status === "success"
  ).length;
  const failureCount = elementResults.filter(
    (r) => r && r.status === "failed"
  ).length;

  const report: ForEachReport = {
    totalElements: items.length,
    successCount,
    failureCount,
    elementResults: elementResults.filter((r) => r != null),
  };

  // Step 6: For required steps, throw if any failures occurred
  if (isRequired && errors.length > 0) {
    throw new ForEachPartialError(errors, results);
  }

  return { results, report };
}

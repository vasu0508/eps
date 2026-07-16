import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  isSubPipeline,
  executeSubPipeline,
  type ExecutablePipeline,
  type SubPipelineResult,
} from "../../src/execution/sub-pipeline-executor.js";
import type { ExecutionReport } from "../../src/types.js";

/**
 * Property-based tests for Sub-Pipeline Executor
 *
 * **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8**
 */

// --- Helpers ---

/**
 * Creates a mock ExecutionReport for testing.
 */
function createMockReport(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    executionId: "sub-exec-1",
    correlationId: "sub-corr-1",
    startTime: Date.now(),
    endTime: Date.now() + 100,
    duration: 100,
    status: "success",
    steps: [],
    graph: {},
    toJSON: () => ({
      executionId: "sub-exec-1",
      correlationId: "sub-corr-1",
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      duration: 100,
      status: "success",
      steps: [],
      graph: {},
    }),
    ...overrides,
  } as ExecutionReport;
}

/**
 * Arbitrary for generating JSON-serializable values (used as pipeline results).
 */
const arbJsonValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 5 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.integer(), { maxKeys: 5 })
);

/**
 * Arbitrary for generating error messages.
 */
const arbErrorMessage = fc.string({ minLength: 1, maxLength: 100 });

/**
 * Arbitrary for generating correlationId strings.
 */
const arbCorrelationId = fc.string({ minLength: 1, maxLength: 50 });

/**
 * Arbitrary for generating non-Error throwable values.
 */
const arbNonError = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.string(), { maxKeys: 3 })
);

describe("Sub-Pipeline Executor — Property Tests", () => {
  describe("Property 29: Sub-Pipeline Composition Isolation — timeout wraps sub-pipeline, signals propagate", () => {
    /**
     * **Validates: Requirements 18.1, 18.2, 18.4, 18.5, 18.6, 18.7, 18.8**
     */

    it("signal option is passed directly to sub-pipeline's execute call", async () => {
      await fc.assert(
        fc.asyncProperty(arbJsonValue, async (value) => {
          let receivedSignal: AbortSignal | undefined;
          const controller = new AbortController();

          const pipeline: ExecutablePipeline = {
            execute: async (options) => {
              receivedSignal = options?.signal;
              return { success: true, value };
            },
          };

          await executeSubPipeline(pipeline, { signal: controller.signal });

          expect(receivedSignal).toBe(controller.signal);
        }),
        { numRuns: 100 }
      );
    });

    it("correlationId is passed through to sub-pipeline", async () => {
      await fc.assert(
        fc.asyncProperty(arbCorrelationId, async (correlationId) => {
          let receivedCorrelationId: string | undefined;

          const pipeline: ExecutablePipeline = {
            execute: async (options) => {
              receivedCorrelationId = options?.correlationId;
              return { success: true, value: "ok" };
            },
          };

          await executeSubPipeline(pipeline, { correlationId });

          expect(receivedCorrelationId).toBe(correlationId);
        }),
        { numRuns: 100 }
      );
    });

    it("context is passed through to sub-pipeline", async () => {
      await fc.assert(
        fc.asyncProperty(arbJsonValue, async (context) => {
          let receivedContext: unknown;

          const pipeline: ExecutablePipeline = {
            execute: async (options) => {
              receivedContext = options?.context;
              return { success: true, value: "ok" };
            },
          };

          await executeSubPipeline(pipeline, { context });

          expect(receivedContext).toEqual(context);
        }),
        { numRuns: 100 }
      );
    });

    it("isSubPipeline returns true for any object with an execute function, false otherwise", async () => {
      // Test that objects WITH an `execute` function are recognized
      await fc.assert(
        fc.property(
          fc.record({
            execute: fc.constant(async () => ({ success: true })),
            // Extra properties should not interfere
            name: fc.option(fc.string(), { nil: undefined }),
            version: fc.option(fc.integer(), { nil: undefined }),
          }),
          (obj) => {
            expect(isSubPipeline(obj)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("isSubPipeline returns false for objects without an execute function", async () => {
      // Generate arbitrary objects that DO NOT have an execute function
      await fc.assert(
        fc.property(
          fc.oneof(
            // Objects with no execute property
            fc.record({
              run: fc.constant(async () => {}),
              name: fc.option(fc.string(), { nil: undefined }),
            }),
            // Objects with execute as non-function
            fc.record({
              execute: fc.oneof(
                fc.string(),
                fc.integer(),
                fc.boolean(),
                fc.constant(null),
                fc.constant(undefined),
                fc.array(fc.integer(), { maxLength: 3 })
              ),
            }),
            // Primitives
            fc.oneof(
              fc.string(),
              fc.integer(),
              fc.boolean()
            ).map((v) => v as unknown)
          ),
          (value) => {
            expect(isSubPipeline(value)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("isSubPipeline returns false for null and undefined", () => {
      expect(isSubPipeline(null)).toBe(false);
      expect(isSubPipeline(undefined)).toBe(false);
    });

    it("all options are propagated simultaneously to the sub-pipeline", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbCorrelationId,
          fc.integer({ min: 100, max: 60000 }),
          arbJsonValue,
          async (correlationId, timeout, context) => {
            let receivedOptions: any;
            const controller = new AbortController();

            const pipeline: ExecutablePipeline = {
              execute: async (options) => {
                receivedOptions = options;
                return { success: true, value: "done" };
              },
            };

            await executeSubPipeline(pipeline, {
              signal: controller.signal,
              correlationId,
              timeout,
              context,
            });

            expect(receivedOptions.signal).toBe(controller.signal);
            expect(receivedOptions.correlationId).toBe(correlationId);
            expect(receivedOptions.timeout).toBe(timeout);
            expect(receivedOptions.context).toEqual(context);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Property 30: Sub-Pipeline Result Propagation — success/failure maps to parent step", () => {
    /**
     * **Validates: Requirements 18.3, 18.5**
     */

    it("when sub-pipeline returns success:true, result.success===true and result.value===V", async () => {
      await fc.assert(
        fc.asyncProperty(arbJsonValue, async (value) => {
          const pipeline: ExecutablePipeline = {
            execute: async () => ({
              success: true,
              value,
            }),
          };

          const result = await executeSubPipeline(pipeline, {});

          expect(result.success).toBe(true);
          expect(result.value).toEqual(value);
          expect(result.error).toBeUndefined();
        }),
        { numRuns: 100 }
      );
    });

    it("when sub-pipeline returns success:false, result.success===false and result.error===E", async () => {
      await fc.assert(
        fc.asyncProperty(arbErrorMessage, async (message) => {
          const error = new Error(message);

          const pipeline: ExecutablePipeline = {
            execute: async () => ({
              success: false,
              error,
            }),
          };

          const result = await executeSubPipeline(pipeline, {});

          expect(result.success).toBe(false);
          expect(result.error).toBe(error);
          expect(result.value).toBeUndefined();
        }),
        { numRuns: 100 }
      );
    });

    it("when sub-pipeline throws an Error, result is { success: false, error: that Error }", async () => {
      await fc.assert(
        fc.asyncProperty(arbErrorMessage, async (message) => {
          const thrownError = new Error(message);

          const pipeline: ExecutablePipeline = {
            execute: async () => {
              throw thrownError;
            },
          };

          const result = await executeSubPipeline(pipeline, {});

          expect(result.success).toBe(false);
          expect(result.error).toBe(thrownError);
          expect(result.report).toBeUndefined();
        }),
        { numRuns: 100 }
      );
    });

    it("when sub-pipeline throws a non-Error, result wraps it in Error", async () => {
      await fc.assert(
        fc.asyncProperty(arbNonError, async (thrown) => {
          const pipeline: ExecutablePipeline = {
            execute: async () => {
              throw thrown;
            },
          };

          const result = await executeSubPipeline(pipeline, {});

          expect(result.success).toBe(false);
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error!.message).toBe(String(thrown));
        }),
        { numRuns: 100 }
      );
    });

    it("report from sub-pipeline is preserved in result.report on success", async () => {
      await fc.assert(
        fc.asyncProperty(arbJsonValue, async (value) => {
          const mockReport = createMockReport();

          const pipeline: ExecutablePipeline = {
            execute: async () => ({
              success: true,
              value,
              report: mockReport,
            }),
          };

          const result = await executeSubPipeline(pipeline, {});

          expect(result.success).toBe(true);
          expect(result.report).toBe(mockReport);
        }),
        { numRuns: 100 }
      );
    });

    it("report from sub-pipeline is preserved in result.report on failure", async () => {
      await fc.assert(
        fc.asyncProperty(arbErrorMessage, async (message) => {
          const mockReport = createMockReport({ status: "failed" });
          const error = new Error(message);

          const pipeline: ExecutablePipeline = {
            execute: async () => ({
              success: false,
              error,
              report: mockReport,
            }),
          };

          const result = await executeSubPipeline(pipeline, {});

          expect(result.success).toBe(false);
          expect(result.report).toBe(mockReport);
        }),
        { numRuns: 100 }
      );
    });

    it("re-execution produces independent results on each call (supports retry)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (successAttempt) => {
            let callCount = 0;

            const pipeline: ExecutablePipeline = {
              execute: async () => {
                callCount++;
                if (callCount < successAttempt) {
                  return { success: false, error: new Error(`attempt-${callCount}`) };
                }
                return { success: true, value: `success-at-${callCount}` };
              },
            };

            // Simulate retry loop: call multiple times
            let lastResult: SubPipelineResult | undefined;
            for (let i = 0; i < successAttempt; i++) {
              lastResult = await executeSubPipeline(pipeline, {});
            }

            expect(callCount).toBe(successAttempt);
            expect(lastResult!.success).toBe(true);
            expect(lastResult!.value).toBe(`success-at-${successAttempt}`);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

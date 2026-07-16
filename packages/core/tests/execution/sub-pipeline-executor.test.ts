import { describe, it, expect } from "vitest";
import {
  isSubPipeline,
  executeSubPipeline,
  type ExecutablePipeline,
  type SubPipelineResult,
} from "../../src/execution/sub-pipeline-executor.js";

describe("isSubPipeline", () => {
  it("returns true for an object with an execute function", () => {
    const pipeline = { execute: async () => ({ success: true }) };
    expect(isSubPipeline(pipeline)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isSubPipeline(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSubPipeline(undefined)).toBe(false);
  });

  it("returns false for a plain function", () => {
    expect(isSubPipeline(() => {})).toBe(false);
  });

  it("returns false for an object without execute", () => {
    expect(isSubPipeline({ run: async () => {} })).toBe(false);
  });

  it("returns false for an object where execute is not a function", () => {
    expect(isSubPipeline({ execute: "not a function" })).toBe(false);
  });

  it("returns false for a primitive string", () => {
    expect(isSubPipeline("execute")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isSubPipeline(42)).toBe(false);
  });

  it("returns true for a class instance with an execute method", () => {
    class MockPipeline {
      async execute() {
        return { success: true };
      }
    }
    expect(isSubPipeline(new MockPipeline())).toBe(true);
  });
});

describe("executeSubPipeline", () => {
  it("returns success result when sub-pipeline succeeds", async () => {
    const mockReport = { executionId: "test-123" } as any;
    const pipeline: ExecutablePipeline = {
      execute: async () => ({
        success: true,
        value: { data: "result" },
        report: mockReport,
      }),
    };

    const result = await executeSubPipeline(pipeline, {});

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ data: "result" });
    expect(result.report).toBe(mockReport);
    expect(result.error).toBeUndefined();
  });

  it("returns failure result when sub-pipeline fails", async () => {
    const mockError = new Error("sub-pipeline step failed");
    const mockReport = { executionId: "fail-123" } as any;
    const pipeline: ExecutablePipeline = {
      execute: async () => ({
        success: false,
        error: mockError,
        report: mockReport,
      }),
    };

    const result = await executeSubPipeline(pipeline, {});

    expect(result.success).toBe(false);
    expect(result.error).toBe(mockError);
    expect(result.report).toBe(mockReport);
    expect(result.value).toBeUndefined();
  });

  it("passes abort signal to sub-pipeline", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const pipeline: ExecutablePipeline = {
      execute: async (options) => {
        receivedSignal = options?.signal;
        return { success: true, value: "ok" };
      },
    };

    await executeSubPipeline(pipeline, { signal: controller.signal });

    expect(receivedSignal).toBe(controller.signal);
  });

  it("passes correlationId to sub-pipeline", async () => {
    let receivedCorrelationId: string | undefined;

    const pipeline: ExecutablePipeline = {
      execute: async (options) => {
        receivedCorrelationId = options?.correlationId;
        return { success: true, value: "ok" };
      },
    };

    await executeSubPipeline(pipeline, { correlationId: "parent-corr-123" });

    expect(receivedCorrelationId).toBe("parent-corr-123");
  });

  it("passes timeout to sub-pipeline", async () => {
    let receivedTimeout: number | undefined;

    const pipeline: ExecutablePipeline = {
      execute: async (options) => {
        receivedTimeout = options?.timeout;
        return { success: true, value: "ok" };
      },
    };

    await executeSubPipeline(pipeline, { timeout: 5000 });

    expect(receivedTimeout).toBe(5000);
  });

  it("passes mapped context to sub-pipeline", async () => {
    let receivedContext: unknown;

    const pipeline: ExecutablePipeline = {
      execute: async (options) => {
        receivedContext = options?.context;
        return { success: true, value: "ok" };
      },
    };

    const mappedContext = { userId: "user-1", action: "process" };
    await executeSubPipeline(pipeline, { context: mappedContext });

    expect(receivedContext).toEqual(mappedContext);
  });

  it("catches thrown errors and returns failure result", async () => {
    const pipeline: ExecutablePipeline = {
      execute: async () => {
        throw new Error("unexpected crash");
      },
    };

    const result = await executeSubPipeline(pipeline, {});

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe("unexpected crash");
    expect(result.report).toBeUndefined();
  });

  it("wraps non-Error throws in an Error", async () => {
    const pipeline: ExecutablePipeline = {
      execute: async () => {
        throw "string error";
      },
    };

    const result = await executeSubPipeline(pipeline, {});

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe("string error");
  });

  it("executes fresh on each call (supports retry re-execution)", async () => {
    let callCount = 0;

    const pipeline: ExecutablePipeline = {
      execute: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: false, error: new Error("first attempt failed") };
        }
        return { success: true, value: "second attempt succeeded" };
      },
    };

    // Simulate retry: first call fails, second call succeeds
    const result1 = await executeSubPipeline(pipeline, {});
    expect(result1.success).toBe(false);

    const result2 = await executeSubPipeline(pipeline, {});
    expect(result2.success).toBe(true);
    expect(result2.value).toBe("second attempt succeeded");
    expect(callCount).toBe(2);
  });

  it("handles sub-pipeline returning success with no value", async () => {
    const pipeline: ExecutablePipeline = {
      execute: async () => ({ success: true }),
    };

    const result = await executeSubPipeline(pipeline, {});

    expect(result.success).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.report).toBeUndefined();
  });

  it("propagates all options simultaneously", async () => {
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
      correlationId: "corr-456",
      timeout: 10000,
      context: { key: "value" },
    });

    expect(receivedOptions.signal).toBe(controller.signal);
    expect(receivedOptions.correlationId).toBe("corr-456");
    expect(receivedOptions.timeout).toBe(10000);
    expect(receivedOptions.context).toEqual({ key: "value" });
  });
});

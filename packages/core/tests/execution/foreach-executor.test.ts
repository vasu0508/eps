// Unit tests for foreach-executor

import { describe, it, expect, vi } from "vitest";
import { executeForEach } from "../../src/execution/foreach-executor.js";
import type { ExecutionContext } from "../../src/types.js";
import type { ForEachConfig } from "../../src/types/foreach.js";
import { ForEachMapperError, ForEachPartialError } from "../../src/errors.js";

// Helper to create a minimal ExecutionContext
function createContext(
  overrides: Partial<ExecutionContext<unknown>> = {}
): ExecutionContext<unknown> {
  return {
    pipelineId: "test-pipeline",
    correlationId: "test-correlation",
    stepResults: new Map(),
    userContext: {},
    abortSignal: new AbortController().signal,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    metrics: {
      increment: vi.fn(),
      gauge: vi.fn(),
      histogram: vi.fn(),
      timing: vi.fn(),
    },
    ...overrides,
  };
}

describe("executeForEach", () => {
  describe("mapper extraction and validation", () => {
    it("throws ForEachMapperError when mapper throws", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => { throw new Error("mapper failed"); },
        maxConcurrency: Infinity,
      };

      await expect(
        executeForEach(config, async (el) => el, createContext(), true)
      ).rejects.toThrow(ForEachMapperError);
    });

    it("throws ForEachMapperError when mapper returns non-array", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => "not-an-array" as unknown as unknown[],
        maxConcurrency: Infinity,
      };

      await expect(
        executeForEach(config, async (el) => el, createContext(), true)
      ).rejects.toThrow(ForEachMapperError);
    });

    it("preserves original error in ForEachMapperError", async () => {
      const originalError = new Error("original");
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => { throw originalError; },
        maxConcurrency: Infinity,
      };

      try {
        await executeForEach(config, async (el) => el, createContext(), true);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForEachMapperError);
        expect((err as ForEachMapperError).originalError).toBe(originalError);
      }
    });
  });

  describe("empty array handling", () => {
    it("returns immediately with empty results for empty array", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [],
        maxConcurrency: Infinity,
      };

      const result = await executeForEach(config, async (el) => el, createContext(), true);

      expect(result.results).toEqual([]);
      expect(result.report.totalElements).toBe(0);
      expect(result.report.successCount).toBe(0);
      expect(result.report.failureCount).toBe(0);
      expect(result.report.elementResults).toEqual([]);
    });
  });

  describe("parallel execution with concurrency", () => {
    it("processes all elements and collects results in index order", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3, 4, 5],
        maxConcurrency: Infinity,
      };

      const handler = async (el: unknown) => (el as number) * 2;
      const result = await executeForEach(config, handler, createContext(), true);

      expect(result.results).toEqual([2, 4, 6, 8, 10]);
      expect(result.report.totalElements).toBe(5);
      expect(result.report.successCount).toBe(5);
      expect(result.report.failureCount).toBe(0);
    });

    it("maintains index order even when elements complete out of order", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3],
        maxConcurrency: Infinity,
      };

      // Element 0 completes last, element 2 completes first
      const handler = async (el: unknown, index: number) => {
        const delays = [30, 20, 10];
        await new Promise((r) => setTimeout(r, delays[index]!));
        return (el as number) * 10;
      };

      const result = await executeForEach(config, handler, createContext(), true);

      expect(result.results).toEqual([10, 20, 30]);
    });

    it("respects maxConcurrency limit", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3, 4, 5],
        maxConcurrency: 2,
      };

      let concurrentCount = 0;
      let maxConcurrent = 0;

      const handler = async (el: unknown) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 20));
        concurrentCount--;
        return el;
      };

      await executeForEach(config, handler, createContext(), true);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("handles maxConcurrency of 1 (sequential)", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3],
        maxConcurrency: 1,
      };

      const order: number[] = [];
      const handler = async (el: unknown, index: number) => {
        order.push(index);
        await new Promise((r) => setTimeout(r, 5));
        return el;
      };

      await executeForEach(config, handler, createContext(), true);

      expect(order).toEqual([0, 1, 2]);
    });
  });

  describe("required step failure handling", () => {
    it("throws ForEachPartialError on element failure when required", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3],
        maxConcurrency: 1,
      };

      const handler = async (el: unknown, index: number) => {
        if (index === 1) throw new Error("element failed");
        return el;
      };

      await expect(
        executeForEach(config, handler, createContext(), true)
      ).rejects.toThrow(ForEachPartialError);
    });

    it("includes errors and partial results in ForEachPartialError", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3],
        maxConcurrency: 1,
      };

      const handler = async (el: unknown, index: number) => {
        if (index === 1) throw new Error("element failed");
        return (el as number) * 10;
      };

      try {
        await executeForEach(config, handler, createContext(), true);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ForEachPartialError);
        const partialErr = err as ForEachPartialError;
        expect(partialErr.errors).toHaveLength(1);
        expect(partialErr.errors[0]!.index).toBe(1);
        expect(partialErr.errors[0]!.error.message).toBe("element failed");
        // First element should have succeeded
        expect(partialErr.results[0]).toBe(10);
      }
    });

    it("aborts remaining elements after first failure when required", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3, 4, 5],
        maxConcurrency: 1,
      };

      const executed: number[] = [];
      const handler = async (el: unknown, index: number) => {
        executed.push(index);
        if (index === 1) throw new Error("fail");
        return el;
      };

      try {
        await executeForEach(config, handler, createContext(), true);
      } catch {
        // Expected
      }

      // With maxConcurrency 1, elements after index 1 should not execute
      expect(executed).toContain(0);
      expect(executed).toContain(1);
      // Elements 2, 3, 4 should be aborted
      expect(executed).not.toContain(2);
      expect(executed).not.toContain(3);
      expect(executed).not.toContain(4);
    });
  });

  describe("optional step failure handling", () => {
    it("continues processing after element failure when optional", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3],
        maxConcurrency: Infinity,
      };

      const handler = async (el: unknown, index: number) => {
        if (index === 1) throw new Error("element failed");
        return (el as number) * 10;
      };

      const result = await executeForEach(config, handler, createContext(), false);

      expect(result.results[0]).toBe(10);
      expect(result.results[1]).toBeUndefined();
      expect(result.results[2]).toBe(30);
    });

    it("records correct success and failure counts for optional", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2, 3, 4],
        maxConcurrency: Infinity,
      };

      const handler = async (el: unknown, index: number) => {
        if (index === 1 || index === 3) throw new Error("fail");
        return el;
      };

      const result = await executeForEach(config, handler, createContext(), false);

      expect(result.report.totalElements).toBe(4);
      expect(result.report.successCount).toBe(2);
      expect(result.report.failureCount).toBe(2);
    });
  });

  describe("ForEachReport tracking", () => {
    it("records per-element outcomes with durations", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => ["a", "b"],
        maxConcurrency: Infinity,
      };

      const handler = async (el: unknown) => el;
      const result = await executeForEach(config, handler, createContext(), true);

      expect(result.report.elementResults).toHaveLength(2);
      expect(result.report.elementResults[0]!.index).toBe(0);
      expect(result.report.elementResults[0]!.status).toBe("success");
      expect(result.report.elementResults[0]!.duration).toBeGreaterThanOrEqual(0);
      expect(result.report.elementResults[1]!.index).toBe(1);
      expect(result.report.elementResults[1]!.status).toBe("success");
    });

    it("records error details for failed elements", async () => {
      const config: ForEachConfig<unknown, unknown> = {
        mapper: () => [1, 2],
        maxConcurrency: Infinity,
      };

      const handler = async (_el: unknown, index: number) => {
        if (index === 0) throw new Error("oops");
        return "ok";
      };

      const result = await executeForEach(config, handler, createContext(), false);

      const failedReport = result.report.elementResults.find((r) => r.index === 0);
      expect(failedReport!.status).toBe("failed");
      expect(failedReport!.error).toEqual({ name: "Error", message: "oops" });
    });
  });
});

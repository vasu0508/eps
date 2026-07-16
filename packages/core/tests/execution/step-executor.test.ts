// Unit tests for step-executor

import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeStep } from "../../src/execution/step-executor.js";
import type { ExecutionContext, StepPolicies } from "../../src/types.js";
import type { StepNode } from "../../src/types/graph.js";
import { createRetryPolicy } from "../../src/policies/retry-policy.js";
import { createTimeoutPolicy } from "../../src/policies/timeout-policy.js";
import {
  createCircuitBreaker,
  clearCircuitBreakerRegistry,
} from "../../src/policies/circuit-breaker.js";
import {
  CancellationError,
  CircuitOpenError,
  InputWiringError,
} from "../../src/errors.js";

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

// Helper to create a minimal StepNode
function createNode(overrides: Partial<StepNode> = {}): StepNode {
  return {
    name: "testStep",
    handler: async () => "result",
    policies: {},
    dependencies: [],
    isRequired: true,
    ...overrides,
  };
}

describe("executeStep", () => {
  beforeEach(() => {
    clearCircuitBreakerRegistry();
  });

  describe("basic execution", () => {
    it("should execute a simple step successfully", async () => {
      const node = createNode({
        handler: async () => "hello",
      });
      const context = createContext();
      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.value).toBe("hello");
        expect(result.attempts).toBe(1);
        expect(result.duration).toBeGreaterThanOrEqual(0);
      }
    });

    it("should fail when handler throws", async () => {
      const node = createNode({
        handler: async () => {
          throw new Error("handler failed");
        },
      });
      const context = createContext();
      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.message).toBe("handler failed");
        expect(result.attempts).toBe(1);
      }
    });

    it("should pass ExecutionContext to handler when no input mapper", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      const node = createNode({ handler });
      const context = createContext();

      await executeStep(node, context, new Map());

      expect(handler).toHaveBeenCalledWith(context);
    });
  });

  describe("input wiring", () => {
    it("should pass mapped input to handler when inputMapper is configured", async () => {
      const handler = vi.fn().mockResolvedValue("processed");
      const node = createNode({
        handler,
        inputMapper: (results) => results["stepA"],
      });
      const context = createContext();
      const stepResults = new Map<string, unknown>([["stepA", "inputValue"]]);

      const result = await executeStep(node, context, stepResults);

      expect(result.status).toBe("success");
      expect(handler).toHaveBeenCalledWith("inputValue");
    });

    it("should fail with InputWiringError when mapper references missing step", async () => {
      const handler = vi.fn();
      const node = createNode({
        handler,
        inputMapper: (results) => results["nonExistent"],
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toBeInstanceOf(InputWiringError);
      }
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("circuit breaker", () => {
    it("should fail fast when circuit breaker is open", async () => {
      const cb = createCircuitBreaker("test-cb-open", {
        failureThreshold: 1,
        resetTimeout: 60000,
      });
      // Force circuit open by recording a failure
      cb.recordFailure();

      const handler = vi.fn().mockResolvedValue("ok");
      const node = createNode({
        handler,
        policies: { circuitBreaker: cb },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toBeInstanceOf(CircuitOpenError);
        expect(result.attempts).toBe(0);
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it("should record success with circuit breaker on successful execution", async () => {
      const cb = createCircuitBreaker("test-cb-success", {
        failureThreshold: 3,
        resetTimeout: 5000,
      });
      const node = createNode({
        handler: async () => "ok",
        policies: { circuitBreaker: cb },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("success");
      expect(cb.state).toBe("closed");
    });

    it("should record failure with circuit breaker on failed execution", async () => {
      const cb = createCircuitBreaker("test-cb-failure", {
        failureThreshold: 3,
        resetTimeout: 5000,
      });
      const node = createNode({
        handler: async () => {
          throw new Error("fail");
        },
        policies: { circuitBreaker: cb },
      });
      const context = createContext();

      await executeStep(node, context, new Map());
      // After one failure, still closed (threshold is 3)
      expect(cb.state).toBe("closed");
    });
  });

  describe("retry policy", () => {
    it("should retry on failure up to maxAttempts", async () => {
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) throw new Error(`fail ${callCount}`);
        return "success on 3";
      });

      const retry = createRetryPolicy(3, { baseDelay: 100 });
      const node = createNode({
        handler,
        policies: { retry },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.value).toBe("success on 3");
        expect(result.attempts).toBe(3);
      }
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it("should fail after all retries are exhausted", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("always fails"));

      // createRetryPolicy(3) → maxAttempts=3, total handler calls = 3
      // shouldRetry(e, 1) → true, shouldRetry(e, 2) → true, shouldRetry(e, 3) → false
      const retry = createRetryPolicy(3, { baseDelay: 100 });
      const node = createNode({
        handler,
        policies: { retry },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.message).toBe("always fails");
      }
      // With maxAttempts=3: initial + 2 retries (shouldRetry returns true for attempt 1,2; false for 3)
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it("should respect retryOn predicate and skip retries for non-matching errors", async () => {
      const handler = vi
        .fn()
        .mockRejectedValue(new Error("permanent error"));

      const retry = createRetryPolicy(3, {
        baseDelay: 100,
        retryOn: (e) => e.message.includes("transient"),
      });
      const node = createNode({
        handler,
        policies: { retry },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      // Should only have attempted once, since retryOn rejected
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should record retry history", async () => {
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) throw new Error(`fail ${callCount}`);
        return "ok";
      });

      const retry = createRetryPolicy(3, { baseDelay: 100 });
      const node = createNode({
        handler,
        policies: { retry },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("success");
      const metadata = (result as any).metadata;
      expect(metadata.retryHistory).toHaveLength(2);
      expect(metadata.retryHistory[0].attempt).toBe(1);
      expect(metadata.retryHistory[1].attempt).toBe(2);
    });
  });

  describe("timeout policy", () => {
    it("should timeout if handler exceeds configured ms", async () => {
      const handler = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      );

      const timeout = createTimeoutPolicy({ ms: 50, stepName: "testStep" });
      const node = createNode({
        handler,
        policies: { timeout },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.name).toBe("TimeoutError");
      }
    });

    it("should succeed if handler completes before timeout", async () => {
      const handler = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("fast"), 10))
      );

      const timeout = createTimeoutPolicy({ ms: 500, stepName: "testStep" });
      const node = createNode({
        handler,
        policies: { timeout },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.value).toBe("fast");
      }
    });
  });

  describe("fallback chain", () => {
    it("should use fallback when primary handler fails", async () => {
      const primary = vi.fn().mockRejectedValue(new Error("primary failed"));
      const fallback1 = vi.fn().mockResolvedValue("fallback result");

      const node = createNode({
        handler: primary,
        policies: { fallbacks: [fallback1] },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("fallback");
      if (result.status === "fallback") {
        expect(result.value).toBe("fallback result");
        expect(result.fallbackIndex).toBe(0);
      }
    });

    it("should try fallbacks in order and short-circuit on first success", async () => {
      const primary = vi.fn().mockRejectedValue(new Error("primary failed"));
      const fallback1 = vi.fn().mockRejectedValue(new Error("fb1 failed"));
      const fallback2 = vi.fn().mockResolvedValue("fb2 result");
      const fallback3 = vi.fn().mockResolvedValue("fb3 result");

      const node = createNode({
        handler: primary,
        policies: { fallbacks: [fallback1, fallback2, fallback3] },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("fallback");
      if (result.status === "fallback") {
        expect(result.value).toBe("fb2 result");
        expect(result.fallbackIndex).toBe(1);
      }
      expect(fallback1).toHaveBeenCalledTimes(1);
      expect(fallback2).toHaveBeenCalledTimes(1);
      expect(fallback3).not.toHaveBeenCalled();
    });

    it("should fail when all fallbacks fail", async () => {
      const primary = vi.fn().mockRejectedValue(new Error("primary failed"));
      const fallback1 = vi.fn().mockRejectedValue(new Error("fb1 failed"));
      const fallback2 = vi.fn().mockRejectedValue(new Error("fb2 failed"));

      const node = createNode({
        handler: primary,
        policies: { fallbacks: [fallback1, fallback2] },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        // Last fallback's error
        expect(result.error.message).toBe("fb2 failed");
      }
    });

    it("should record fallback history", async () => {
      const primary = vi.fn().mockRejectedValue(new Error("primary failed"));
      const fallback1 = vi.fn().mockRejectedValue(new Error("fb1 failed"));
      const fallback2 = vi.fn().mockResolvedValue("fb2 ok");

      const node = createNode({
        handler: primary,
        policies: { fallbacks: [fallback1, fallback2] },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      const metadata = (result as any).metadata;
      expect(metadata.fallbackHistory).toHaveLength(2);
      expect(metadata.fallbackHistory[0]).toMatchObject({
        index: 0,
        success: false,
      });
      expect(metadata.fallbackHistory[1]).toMatchObject({
        index: 1,
        success: true,
      });
    });

    it("should apply timeout to fallback handlers", async () => {
      const primary = vi.fn().mockRejectedValue(new Error("primary failed"));
      const slowFallback = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      );

      const timeout = createTimeoutPolicy({ ms: 50, stepName: "testStep" });
      const node = createNode({
        handler: primary,
        policies: { fallbacks: [slowFallback], timeout },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.name).toBe("TimeoutError");
      }
    });
  });

  describe("error transformer", () => {
    it("should transform error before retry evaluation", async () => {
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error(`raw-error-${callCount}`);
      });

      // createRetryPolicy(3) → maxAttempts=3 → shouldRetry true for attempt 1,2
      const retry = createRetryPolicy(3, {
        baseDelay: 100,
        retryOn: (e) => e.message.includes("transformed"),
      });

      const node = createNode({
        handler,
        policies: {
          retry,
          errorTransformer: (e) => new Error(`transformed: ${e.message}`),
        },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      // The transformed error should match retryOn, so all 3 attempts happen
      expect(handler).toHaveBeenCalledTimes(3);
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.message).toContain("transformed");
      }
    });

    it("should record error transformations in metadata", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("original"));
      const node = createNode({
        handler,
        policies: {
          errorTransformer: (e) => new Error(`mapped: ${e.message}`),
        },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      const metadata = (result as any).metadata;
      expect(metadata.errorTransformations).toHaveLength(1);
      expect(metadata.errorTransformations[0].originalError.message).toBe(
        "original"
      );
      expect(metadata.errorTransformations[0].transformedError.message).toBe(
        "mapped: original"
      );
    });
  });

  describe("cancellation", () => {
    it("should fail immediately when abort signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort("cancelled");

      const handler = vi.fn().mockResolvedValue("ok");
      const node = createNode({ handler });
      const context = createContext({ abortSignal: controller.signal });

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toBeInstanceOf(CancellationError);
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it("should cancel retry loop when abort signal fires", async () => {
      const controller = new AbortController();
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          controller.abort("cancelled during retry");
        }
        throw new Error("fail");
      });

      const retry = createRetryPolicy(5, { baseDelay: 100 });
      const node = createNode({
        handler,
        policies: { retry },
      });
      const context = createContext({ abortSignal: controller.signal });

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toBeInstanceOf(CancellationError);
      }
      // Should have stopped retrying after signal aborted
      expect(callCount).toBeLessThanOrEqual(3);
    });
  });

  describe("combined policies", () => {
    it("should retry then fallback on exhausted retries", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("always fails"));
      const fallback = vi.fn().mockResolvedValue("fallback value");

      // createRetryPolicy(3) → 3 total handler calls (initial + 2 retries)
      const retry = createRetryPolicy(3, { baseDelay: 100 });
      const node = createNode({
        handler,
        policies: { retry, fallbacks: [fallback] },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("fallback");
      expect(handler).toHaveBeenCalledTimes(3);
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it("should apply timeout per retry attempt", async () => {
      let callCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First attempt times out
          return new Promise((resolve) => setTimeout(resolve, 500));
        }
        return "success on retry";
      });

      const retry = createRetryPolicy(2, { baseDelay: 100 });
      const timeout = createTimeoutPolicy({ ms: 50, stepName: "testStep" });
      const node = createNode({
        handler,
        policies: { retry, timeout },
      });
      const context = createContext();

      const result = await executeStep(node, context, new Map());

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.value).toBe("success on retry");
        expect(result.attempts).toBe(2);
      }
    });
  });
});

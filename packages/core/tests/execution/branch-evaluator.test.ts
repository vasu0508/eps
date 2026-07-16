// Unit tests for branch-evaluator

import { describe, it, expect, vi } from "vitest";
import { evaluateBranch } from "../../src/execution/branch-evaluator.js";
import type { ExecutionContext } from "../../src/types.js";
import type { BranchDefinition, BranchHandler } from "../../src/types/branch.js";
import { createTimeoutPolicy } from "../../src/policies/timeout-policy.js";
import {
  BranchNotMatchedError,
  BranchDiscriminatorError,
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

describe("evaluateBranch", () => {
  describe("discriminator evaluation", () => {
    it("should evaluate the discriminator with the execution context", async () => {
      const discriminator = vi.fn().mockReturnValue("a");
      const handler: BranchHandler = {
        handler: async () => "result-a",
      };
      const definition: BranchDefinition<unknown> = {
        name: "testBranch",
        discriminator,
        branches: new Map([["a", handler]]),
      };
      const context = createContext();

      await evaluateBranch(definition, context);

      expect(discriminator).toHaveBeenCalledWith(context);
    });

    it("should throw BranchDiscriminatorError when discriminator throws", async () => {
      const definition: BranchDefinition<unknown> = {
        name: "failBranch",
        discriminator: () => {
          throw new Error("disc failed");
        },
        branches: new Map(),
      };
      const context = createContext();

      await expect(evaluateBranch(definition, context)).rejects.toThrow(
        BranchDiscriminatorError
      );
    });

    it("should wrap non-Error throws from discriminator in BranchDiscriminatorError", async () => {
      const definition: BranchDefinition<unknown> = {
        name: "failBranch",
        discriminator: () => {
          throw "string error";
        },
        branches: new Map(),
      };
      const context = createContext();

      const error = await evaluateBranch(definition, context).catch((e) => e);
      expect(error).toBeInstanceOf(BranchDiscriminatorError);
      expect(error.originalError.message).toBe("string error");
    });
  });

  describe("branch matching with strict equality", () => {
    it("should match the correct branch using strict equality", async () => {
      const handlerA: BranchHandler = { handler: async () => "result-a" };
      const handlerB: BranchHandler = { handler: async () => "result-b" };

      const definition: BranchDefinition<unknown> = {
        name: "testBranch",
        discriminator: () => "b",
        branches: new Map([
          ["a", handlerA],
          ["b", handlerB],
        ]),
      };
      const context = createContext();

      const result = await evaluateBranch(definition, context);

      expect(result.value).toBe("result-b");
      expect(result.branchSelected).toBe("b");
    });

    it("should not match loosely equal values (strict equality)", async () => {
      const handler: BranchHandler = { handler: async () => "matched" };

      const definition: BranchDefinition<unknown> = {
        name: "strictBranch",
        discriminator: () => 1, // number 1
        branches: new Map([["1", handler]]), // string "1"
      };
      const context = createContext();

      await expect(evaluateBranch(definition, context)).rejects.toThrow(
        BranchNotMatchedError
      );
    });

    it("should support non-string discriminator values", async () => {
      const handler: BranchHandler = { handler: async () => "num-result" };

      const definition: BranchDefinition<unknown> = {
        name: "numBranch",
        discriminator: () => 42,
        branches: new Map([[42, handler]]),
      };
      const context = createContext();

      const result = await evaluateBranch(definition, context);

      expect(result.value).toBe("num-result");
      expect(result.branchSelected).toBe(42);
    });
  });

  describe("otherwise (default branch)", () => {
    it("should execute defaultBranch when no match found", async () => {
      const defaultHandler: BranchHandler = {
        handler: async () => "default-result",
      };
      const definition: BranchDefinition<unknown> = {
        name: "defaultBranch",
        discriminator: () => "unknown",
        branches: new Map([["a", { handler: async () => "a" }]]),
        defaultBranch: defaultHandler,
      };
      const context = createContext();

      const result = await evaluateBranch(definition, context);

      expect(result.value).toBe("default-result");
      expect(result.branchSelected).toBe("unknown");
    });

    it("should throw BranchNotMatchedError when no match and no defaultBranch", async () => {
      const definition: BranchDefinition<unknown> = {
        name: "noDefault",
        discriminator: () => "missing",
        branches: new Map([["a", { handler: async () => "a" }]]),
      };
      const context = createContext();

      const error = await evaluateBranch(definition, context).catch((e) => e);
      expect(error).toBeInstanceOf(BranchNotMatchedError);
      expect(error.branchName).toBe("noDefault");
      expect(error.discriminatorValue).toBe("missing");
    });
  });

  describe("handler execution", () => {
    it("should pass context to the matched handler", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      const definition: BranchDefinition<unknown> = {
        name: "ctxBranch",
        discriminator: () => "a",
        branches: new Map([["a", { handler }]]),
      };
      const context = createContext();

      await evaluateBranch(definition, context);

      expect(handler).toHaveBeenCalledWith(context);
    });

    it("should return duration in the result", async () => {
      const handler: BranchHandler = {
        handler: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return "done";
        },
      };
      const definition: BranchDefinition<unknown> = {
        name: "durationBranch",
        discriminator: () => "a",
        branches: new Map([["a", handler]]),
      };
      const context = createContext();

      const result = await evaluateBranch(definition, context);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("individual branch policies", () => {
    it("should apply timeout policy to branch handler", async () => {
      const slowHandler: BranchHandler = {
        handler: async () => new Promise((r) => setTimeout(() => r("slow"), 500)),
        policies: { timeout: createTimeoutPolicy({ ms: 50 }) },
      };
      const definition: BranchDefinition<unknown> = {
        name: "timeoutBranch",
        discriminator: () => "slow",
        branches: new Map([["slow", slowHandler]]),
      };
      const context = createContext();

      await expect(evaluateBranch(definition, context)).rejects.toThrow("Timeout");
    });

    it("should not timeout when handler completes within limit", async () => {
      const fastHandler: BranchHandler = {
        handler: async () => "fast-result",
        policies: { timeout: createTimeoutPolicy({ ms: 500 }) },
      };
      const definition: BranchDefinition<unknown> = {
        name: "fastBranch",
        discriminator: () => "fast",
        branches: new Map([["fast", fastHandler]]),
      };
      const context = createContext();

      const result = await evaluateBranch(definition, context);

      expect(result.value).toBe("fast-result");
    });
  });

  describe("branchSelected reporting", () => {
    it("should record branchSelected as the discriminator value for matched branch", async () => {
      const definition: BranchDefinition<unknown> = {
        name: "reportBranch",
        discriminator: () => "selected",
        branches: new Map([["selected", { handler: async () => "val" }]]),
      };
      const context = createContext();

      const result = await evaluateBranch(definition, context);

      expect(result.branchSelected).toBe("selected");
    });

    it("should record branchSelected as discriminator value even for default branch", async () => {
      const definition: BranchDefinition<unknown> = {
        name: "reportDefault",
        discriminator: () => "unmatched-value",
        branches: new Map([["a", { handler: async () => "a" }]]),
        defaultBranch: { handler: async () => "default" },
      };
      const context = createContext();

      const result = await evaluateBranch(definition, context);

      expect(result.branchSelected).toBe("unmatched-value");
    });
  });
});

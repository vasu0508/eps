// Unit tests for the pipeline builder and step configurator

import { describe, it, expect } from "vitest";
import { createPipeline, PipelineBuilder } from "../../src/builder/pipeline-builder.js";
import { StepConfigurator } from "../../src/builder/step-configurator.js";
import {
  EmptyPipelineError,
  ValidationError,
  InvalidStepError,
  CircularDependencyError,
  InvalidDependencyError,
} from "../../src/errors.js";
import type { ExecutionContext } from "../../src/types.js";

describe("Pipeline Builder", () => {
  describe("createPipeline factory", () => {
    it("returns a PipelineBuilder instance", () => {
      const builder = createPipeline("test");
      expect(builder).toBeInstanceOf(PipelineBuilder);
    });

    it("works without a name argument", () => {
      const builder = createPipeline();
      expect(builder).toBeInstanceOf(PipelineBuilder);
    });
  });

  describe(".step(name, handler)", () => {
    it("returns a StepConfigurator for chaining", () => {
      const builder = createPipeline("test");
      const configurator = builder.step("myStep", async () => "result");
      expect(configurator).toBeInstanceOf(StepConfigurator);
    });

    it("throws ValidationError for empty step name", () => {
      const builder = createPipeline("test");
      expect(() => builder.step("", async () => "x")).toThrow(ValidationError);
    });

    it("throws ValidationError for step name > 128 chars", () => {
      const builder = createPipeline("test");
      const longName = "x".repeat(129);
      expect(() => builder.step(longName, async () => "x")).toThrow(ValidationError);
    });

    it("throws ValidationError for non-function handler", () => {
      const builder = createPipeline("test");
      expect(() => builder.step("test", "not a function" as unknown as any)).toThrow(
        ValidationError
      );
    });

    it("throws ValidationError for duplicate step name", () => {
      const builder = createPipeline("test");
      builder.step("dup", async () => 1);
      expect(() => builder.step("dup", async () => 2)).toThrow(ValidationError);
    });

    it("accepts a step name of exactly 128 chars", () => {
      const builder = createPipeline("test");
      const name = "x".repeat(128);
      expect(() => builder.step(name, async () => "ok")).not.toThrow();
    });
  });

  describe(".validate()", () => {
    it("throws EmptyPipelineError when no steps defined", () => {
      const builder = createPipeline("test");
      expect(() => builder.validate()).toThrow(EmptyPipelineError);
    });

    it("succeeds for a single-step pipeline", () => {
      const builder = createPipeline("test");
      builder.step("A", async () => 1);
      expect(() => builder.validate()).not.toThrow();
    });

    it("throws when a step references a non-existent dependency", () => {
      const builder = createPipeline("test");
      builder.step("A", async () => 1).dependsOn("nonExistent");
      expect(() => builder.validate()).toThrow();
    });

    it("throws when dependencies form a cycle", () => {
      const builder = createPipeline("test");
      builder.step("A", async () => 1).dependsOn("B");
      builder.step("B", async () => 2).dependsOn("A");
      expect(() => builder.validate()).toThrow();
    });

    it("succeeds for valid dependency chain", () => {
      const builder = createPipeline("test");
      builder.step("A", async () => 1);
      builder.step("B", async () => 2).dependsOn("A");
      builder.step("C", async () => 3).dependsOn("A", "B");
      expect(() => builder.validate()).not.toThrow();
    });
  });

  describe(".execute()", () => {
    it("throws EmptyPipelineError when no steps", async () => {
      const builder = createPipeline("test");
      await expect(builder.execute()).rejects.toThrow(EmptyPipelineError);
    });

    it("executes a single-step pipeline successfully", async () => {
      const result = await createPipeline("test")
        .step("greeting", async () => "hello")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue<string>("greeting")).toBe("hello");
      expect(result.executionId).toBeTruthy();
      expect(result.correlationId).toBeTruthy();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("uses provided correlationId", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 42)
        .execute({ correlationId: "my-corr-id" });

      expect(result.correlationId).toBe("my-corr-id");
    });

    it("executes steps in dependency order", async () => {
      const order: string[] = [];

      const result = await createPipeline("test")
        .step("A", async () => {
          order.push("A");
          return 1;
        })
        .step("B", async () => {
          order.push("B");
          return 2;
        })
        .dependsOn("A")
        .execute();

      expect(result.success).toBe(true);
      expect(order).toEqual(["A", "B"]);
    });

    it("runs independent steps in parallel", async () => {
      const starts: number[] = [];

      const result = await createPipeline("test")
        .step("A", async () => {
          starts.push(Date.now());
          await new Promise((r) => setTimeout(r, 50));
          return 1;
        })
        .step("B", async () => {
          starts.push(Date.now());
          await new Promise((r) => setTimeout(r, 50));
          return 2;
        })
        .execute();

      expect(result.success).toBe(true);
      // They should start at roughly the same time
      expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(30);
    });

    it("respects maxConcurrency option", async () => {
      let maxRunning = 0;
      let currentRunning = 0;

      const handler = async () => {
        currentRunning++;
        maxRunning = Math.max(maxRunning, currentRunning);
        await new Promise((r) => setTimeout(r, 30));
        currentRunning--;
        return "done";
      };

      const result = await createPipeline("test")
        .step("A", handler)
        .step("B", handler)
        .step("C", handler)
        .execute({ maxConcurrency: 1 });

      expect(result.success).toBe(true);
      expect(maxRunning).toBe(1);
    });

    it("throws ValidationError for maxConcurrency < 1", async () => {
      await expect(
        createPipeline("test")
          .step("A", async () => 1)
          .execute({ maxConcurrency: 0 })
      ).rejects.toThrow(ValidationError);
    });

    it("handles already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort("pre-aborted");

      const result = await createPipeline("test")
        .step("A", async () => 1)
        .execute({ signal: controller.signal });

      expect(result.success).toBe(false);
      const stepResult = result.steps.get("A");
      expect(stepResult?.status).toBe("skipped");
    });

    it("handles required step failure", async () => {
      const result = await createPipeline("test")
        .step("A", async () => {
          throw new Error("boom");
        })
        .execute();

      expect(result.success).toBe(false);
      expect(result.getError("A")?.message).toBe("boom");
    });

    it("handles optional step failure with default", async () => {
      const result = await createPipeline("test")
        .step("A", async () => {
          throw new Error("fail");
        })
        .optional("fallback-value")
        .step("B", async () => "ok")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("A")).toBe("fallback-value");
      expect(result.getValue("B")).toBe("ok");
    });

    it("skips steps when their dependency fails", async () => {
      const result = await createPipeline("test")
        .step("A", async () => {
          throw new Error("fail");
        })
        .step("B", async () => "should not run")
        .dependsOn("A")
        .execute();

      expect(result.success).toBe(false);
      const bResult = result.steps.get("B");
      expect(bResult?.status).toBe("skipped");
    });
  });

  describe("StepConfigurator policy methods", () => {
    it(".timeout() validates positive finite number", () => {
      const builder = createPipeline("test");
      expect(() => builder.step("A", async () => 1).timeout(-1)).toThrow(ValidationError);
      expect(() => builder.step("B", async () => 1).timeout(NaN)).toThrow(ValidationError);
      expect(() => builder.step("C", async () => 1).timeout(Infinity)).toThrow(ValidationError);
      expect(() => builder.step("D", async () => 1).timeout(0)).toThrow(ValidationError);
    });

    it(".retry() validates finite non-negative integer", () => {
      const builder = createPipeline("test");
      expect(() => builder.step("A", async () => 1).retry(-1)).toThrow(ValidationError);
      expect(() => builder.step("B", async () => 1).retry(NaN)).toThrow(ValidationError);
      expect(() => builder.step("C", async () => 1).retry(1.5)).toThrow(ValidationError);
    });

    it(".retry() works with valid count", async () => {
      let attempts = 0;
      const result = await createPipeline("test")
        .step("A", async () => {
          attempts++;
          if (attempts < 3) throw new Error("transient");
          return "ok";
        })
        .retry(3, { baseDelay: 100 })
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("A")).toBe("ok");
      expect(attempts).toBe(3);
    });

    it(".fallback() is invoked when retries exhausted", async () => {
      const result = await createPipeline("test")
        .step("A", async () => {
          throw new Error("primary fail");
        })
        .retry(1, { baseDelay: 100 })
        .fallback(async () => "fallback-result")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("A")).toBe("fallback-result");
    });

    it(".onlyIf() skips step when predicate returns false", async () => {
      const result = await createPipeline<{ skip: boolean }>("test")
        .withContext({ skip: true })
        .step("A", async () => "executed")
        .onlyIf((ctx) => !ctx.skip)
        .execute();

      expect(result.success).toBe(true);
      const stepResult = result.steps.get("A");
      expect(stepResult?.status).toBe("skipped");
    });

    it(".onlyIf() executes step when predicate returns true", async () => {
      const result = await createPipeline<{ skip: boolean }>("test")
        .withContext({ skip: false })
        .step("A", async () => "executed")
        .onlyIf((ctx) => !ctx.skip)
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("A")).toBe("executed");
    });

    it(".optional() and .required() on same step throws", () => {
      const builder = createPipeline("test");
      const configurator = builder.step("A", async () => 1).optional();
      expect(() => configurator.required()).toThrow(ValidationError);
    });

    it(".fallback() throws when exceeding 5 fallbacks", () => {
      const builder = createPipeline("test");
      const configurator = builder.step("A", async () => 1);
      for (let i = 0; i < 5; i++) {
        configurator.fallback(async () => i);
      }
      expect(() => configurator.fallback(async () => "too many")).toThrow(ValidationError);
    });
  });

  describe("PipelineResult accessors", () => {
    it("getValue throws InvalidStepError for non-existent step", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 1)
        .execute();

      expect(() => result.getValue("nonExistent")).toThrow(InvalidStepError);
    });

    it("getError throws InvalidStepError for non-existent step", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 1)
        .execute();

      expect(() => result.getError("nonExistent")).toThrow(InvalidStepError);
    });

    it("getValue returns undefined for failed steps", async () => {
      const result = await createPipeline("test")
        .step("A", async () => {
          throw new Error("boom");
        })
        .execute();

      expect(result.getValue("A")).toBeUndefined();
    });

    it("getError returns undefined for successful steps", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 1)
        .execute();

      expect(result.getError("A")).toBeUndefined();
    });

    it("toJSON produces serializable output", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 1)
        .execute({ correlationId: "test-corr" });

      const json = result.toJSON();
      expect(json.success).toBe(true);
      expect(json.correlationId).toBe("test-corr");
      expect(json.steps).toHaveProperty("A");

      // Verify it's JSON-serializable
      const serialized = JSON.stringify(json);
      const parsed = JSON.parse(serialized);
      expect(parsed.success).toBe(true);
    });
  });

  describe("withContext", () => {
    it("injects context into step handlers", async () => {
      interface MyCtx {
        userId: string;
      }

      let receivedCtx: MyCtx | undefined;

      const result = await createPipeline<MyCtx>("test")
        .withContext({ userId: "user-123" })
        .step("A", async (ctx: ExecutionContext<MyCtx>) => {
          receivedCtx = ctx.userContext;
          return "done";
        })
        .execute();

      expect(result.success).toBe(true);
      expect(receivedCtx?.userId).toBe("user-123");
    });
  });

  describe("execution report", () => {
    it("report contains step entries", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 1)
        .step("B", async () => 2)
        .execute();

      expect(result.report.steps).toHaveLength(2);
      expect(result.report.executionId).toBeTruthy();
      expect(result.report.duration).toBeGreaterThanOrEqual(0);
    });

    it("report.toJSON() produces ISO timestamps", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 1)
        .execute();

      const json = result.report.toJSON();
      expect(json.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(json.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("report graph contains dependencies", async () => {
      const result = await createPipeline("test")
        .step("A", async () => 1)
        .step("B", async () => 2)
        .dependsOn("A")
        .execute();

      expect(result.report.graph["A"]).toEqual([]);
      expect(result.report.graph["B"]).toEqual(["A"]);
    });
  });
});

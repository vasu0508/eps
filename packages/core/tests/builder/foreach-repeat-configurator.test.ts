// Unit tests for ForEachConfigurator and RepeatConfigurator

import { describe, it, expect } from "vitest";
import { createPipeline } from "../../src/builder/pipeline-builder.js";
import { ForEachConfigurator } from "../../src/builder/foreach-configurator.js";
import { RepeatConfigurator } from "../../src/builder/repeat-configurator.js";
import { StepConfigurator } from "../../src/builder/step-configurator.js";
import { ValidationError } from "../../src/errors.js";
import type { ExecutionContext } from "../../src/types.js";

describe("ForEachConfigurator", () => {
  describe("fluent API", () => {
    it(".forEach() returns a ForEachConfigurator instance", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      const configurator = builder.forEach("Process", async (ctx) => ctx.userContext);
      expect(configurator).toBeInstanceOf(ForEachConfigurator);
    });

    it(".from() sets the collection mapper and returns this", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      const configurator = builder.forEach("Process", async (ctx) => ctx.userContext);
      const result = configurator.from((ctx) => ctx.userContext.items);
      expect(result).toBe(configurator); // returns this for chaining
    });

    it(".withConcurrency() sets concurrency and returns this", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      const configurator = builder.forEach("Process", async (ctx) => ctx.userContext);
      const result = configurator.withConcurrency(3);
      expect(result).toBe(configurator);
    });

    it(".dependsOn() sets dependencies and returns this", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      builder.step("Fetch", async () => ["a", "b"]);
      const configurator = builder.forEach("Process", async (ctx) => ctx.userContext);
      const result = configurator.dependsOn("Fetch");
      expect(result).toBe(configurator);
    });

    it(".onlyIf() sets condition and returns this", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      const configurator = builder.forEach("Process", async (ctx) => ctx.userContext);
      const result = configurator.onlyIf((ctx) => ctx.items.length > 0);
      expect(result).toBe(configurator);
    });

    it(".optional() marks step as optional and returns this", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      const configurator = builder.forEach("Process", async (ctx) => ctx.userContext);
      const result = configurator.optional([]);
      expect(result).toBe(configurator);
    });

    it(".required() marks step as required and returns this", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      const configurator = builder.forEach("Process", async (ctx) => ctx.userContext);
      const result = configurator.required();
      expect(result).toBe(configurator);
    });

    it(".step() chains back to PipelineBuilder for next step definition", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      const nextStep = builder
        .forEach("Process", async (ctx) => ctx.userContext)
        .from((ctx) => ctx.userContext.items)
        .withConcurrency(3)
        .step("Next", async () => "done");
      expect(nextStep).toBeInstanceOf(StepConfigurator);
    });

    it(".execute() delegates to the pipeline builder", async () => {
      const result = await createPipeline<{ items: number[] }>("test")
        .withContext({ items: [1, 2, 3] })
        .forEach("Process", async (ctx) => {
          return ctx.userContext.items;
        })
        .from((ctx) => ctx.userContext.items)
        .execute();

      expect(result.success).toBe(true);
    });

    it(".validate() delegates to the pipeline builder", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      builder.forEach("Process", async (ctx) => ctx.userContext)
        .from((ctx) => ctx.userContext.items);
      // Should not throw for a valid pipeline with a single step
      expect(() => builder.validate()).not.toThrow();
    });
  });

  describe("chaining patterns", () => {
    it("supports full chaining: from -> withConcurrency -> dependsOn -> step", () => {
      const builder = createPipeline<{ items: string[] }>("test");
      builder.step("Fetch", async () => ["a", "b"]);

      const nextConfigurator = builder
        .forEach("Process", async (ctx) => ctx.userContext)
        .from((ctx) => ctx.userContext.items)
        .withConcurrency(5)
        .dependsOn("Fetch")
        .step("Finalize", async () => "done");

      expect(nextConfigurator).toBeInstanceOf(StepConfigurator);
    });
  });
});

describe("RepeatConfigurator", () => {
  describe("fluent API", () => {
    it(".repeatUntil() returns a RepeatConfigurator instance", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => ({ status: "pending" }));
      expect(configurator).toBeInstanceOf(RepeatConfigurator);
    });

    it(".until() sets the predicate and returns this", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => ({ status: "done" }));
      const result = configurator.until((r: unknown) => (r as any).status === "done");
      expect(result).toBe(configurator);
    });

    it(".maxIterations() sets max iterations and returns this", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      const result = configurator.maxIterations(10);
      expect(result).toBe(configurator);
    });

    it(".maxIterations() validates >= 1", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      expect(() => configurator.maxIterations(0)).toThrow(ValidationError);
      expect(() => configurator.maxIterations(-1)).toThrow(ValidationError);
      expect(() => configurator.maxIterations(1.5)).toThrow(ValidationError);
      expect(() => configurator.maxIterations(NaN)).toThrow(ValidationError);
      expect(() => configurator.maxIterations(Infinity)).toThrow(ValidationError);
    });

    it(".delay() sets delay and returns this", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      const result = configurator.delay(1000);
      expect(result).toBe(configurator);
    });

    it(".delay() validates >= 0", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      expect(() => configurator.delay(-1)).toThrow(ValidationError);
      expect(() => configurator.delay(NaN)).toThrow(ValidationError);
      expect(() => configurator.delay(Infinity)).toThrow(ValidationError);
    });

    it(".delay(0) is valid", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      expect(() => configurator.delay(0)).not.toThrow();
    });

    it(".dependsOn() sets dependencies and returns this", () => {
      const builder = createPipeline("test");
      builder.step("Init", async () => "init");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      const result = configurator.dependsOn("Init");
      expect(result).toBe(configurator);
    });

    it(".onlyIf() sets condition and returns this", () => {
      const builder = createPipeline<{ shouldPoll: boolean }>("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      const result = configurator.onlyIf((ctx) => ctx.shouldPoll);
      expect(result).toBe(configurator);
    });

    it(".optional() marks step as optional and returns this", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      const result = configurator.optional("default");
      expect(result).toBe(configurator);
    });

    it(".required() marks step as required and returns this", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      const result = configurator.required();
      expect(result).toBe(configurator);
    });

    it(".timeout() sets timeout for individual iterations", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      const result = configurator.timeout(5000);
      expect(result).toBe(configurator);
    });

    it(".timeout() validates positive finite number", () => {
      const builder = createPipeline("test");
      const configurator = builder.repeatUntil("Poll", async () => "x");
      expect(() => configurator.timeout(-1)).toThrow(ValidationError);
      expect(() => configurator.timeout(0)).toThrow(ValidationError);
      expect(() => configurator.timeout(NaN)).toThrow(ValidationError);
      expect(() => configurator.timeout(Infinity)).toThrow(ValidationError);
    });

    it(".step() chains back to PipelineBuilder for next step definition", () => {
      const builder = createPipeline("test");
      const nextStep = builder
        .repeatUntil("Poll", async () => ({ status: "done" }))
        .until((r: unknown) => (r as any).status === "done")
        .maxIterations(5)
        .delay(100)
        .step("Next", async () => "done");
      expect(nextStep).toBeInstanceOf(StepConfigurator);
    });

    it(".execute() delegates to the pipeline builder", async () => {
      let iteration = 0;
      const result = await createPipeline("test")
        .repeatUntil("Poll", async () => {
          iteration++;
          return { done: iteration >= 3 };
        })
        .until((r: unknown) => (r as any).done)
        .maxIterations(10)
        .execute();

      expect(result.success).toBe(true);
    });

    it(".validate() delegates to the pipeline builder", () => {
      const builder = createPipeline("test");
      builder.repeatUntil("Poll", async () => "x")
        .until(() => true)
        .maxIterations(5);
      expect(() => builder.validate()).not.toThrow();
    });
  });

  describe("chaining patterns", () => {
    it("supports full chaining: until -> maxIterations -> delay -> dependsOn -> step", () => {
      const builder = createPipeline("test");
      builder.step("Init", async () => "init");

      const nextConfigurator = builder
        .repeatUntil("Poll", async () => "x")
        .until(() => true)
        .maxIterations(10)
        .delay(500)
        .dependsOn("Init")
        .step("Finalize", async () => "done");

      expect(nextConfigurator).toBeInstanceOf(StepConfigurator);
    });
  });
});

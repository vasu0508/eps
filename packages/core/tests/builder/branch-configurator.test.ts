// Unit tests for the branch configurator

import { describe, it, expect } from "vitest";
import { createPipeline } from "../../src/builder/pipeline-builder.js";
import { BranchConfigurator } from "../../src/builder/branch-configurator.js";
import { StepConfigurator } from "../../src/builder/step-configurator.js";
import { ValidationError } from "../../src/errors.js";
import type { ExecutionContext } from "../../src/types.js";

describe("BranchConfigurator", () => {
  describe(".branch(name, discriminator) on PipelineBuilder", () => {
    it("returns a BranchConfigurator instance", () => {
      const builder = createPipeline<{ type: string }>("test");
      const configurator = builder.branch("Route", (ctx) => ctx.userContext.type);
      expect(configurator).toBeInstanceOf(BranchConfigurator);
    });

    it("throws ValidationError for empty branch name", () => {
      const builder = createPipeline("test");
      expect(() => builder.branch("", () => "x")).toThrow(ValidationError);
    });

    it("throws ValidationError for branch name > 128 chars", () => {
      const builder = createPipeline("test");
      const longName = "x".repeat(129);
      expect(() => builder.branch(longName, () => "x")).toThrow(ValidationError);
    });

    it("throws ValidationError for non-function discriminator", () => {
      const builder = createPipeline("test");
      expect(() =>
        builder.branch("Route", "not a function" as unknown as any)
      ).toThrow(ValidationError);
    });

    it("throws ValidationError for duplicate step name", () => {
      const builder = createPipeline("test");
      builder.step("Route", async () => "step");
      expect(() => builder.branch("Route", () => "x")).toThrow(ValidationError);
    });
  });

  describe(".when(value, handler)", () => {
    it("registers a branch handler and returns this for chaining", () => {
      const builder = createPipeline<{ method: string }>("test");
      const configurator = builder.branch("Pay", (ctx) => ctx.userContext.method);
      const result = configurator.when("credit", async () => "credit-result");
      expect(result).toBe(configurator); // fluent chaining
    });

    it("supports multiple .when() calls for different values", () => {
      const builder = createPipeline<{ method: string }>("test");
      const configurator = builder
        .branch("Pay", (ctx) => ctx.userContext.method)
        .when("credit", async () => "credit")
        .when("paypal", async () => "paypal")
        .when("crypto", async () => "crypto");
      expect(configurator).toBeInstanceOf(BranchConfigurator);
    });
  });

  describe(".otherwise(handler)", () => {
    it("registers a default handler and returns this for chaining", () => {
      const builder = createPipeline<{ method: string }>("test");
      const configurator = builder
        .branch("Pay", (ctx) => ctx.userContext.method)
        .when("credit", async () => "credit")
        .otherwise(async () => "default");
      expect(configurator).toBeInstanceOf(BranchConfigurator);
    });
  });

  describe("flow-through to builder", () => {
    it(".step() flows back to builder and returns a StepConfigurator", () => {
      const builder = createPipeline<{ type: string }>("test");
      const configurator = builder
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result")
        .otherwise(async () => "default")
        .step("Next", async () => "next-result");
      expect(configurator).toBeInstanceOf(StepConfigurator);
    });

    it(".execute() triggers pipeline execution", async () => {
      const result = await createPipeline<{ type: string }>("test")
        .withContext({ type: "a" })
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result")
        .when("b", async () => "b-result")
        .execute();
      expect(result.success).toBe(true);
      expect(result.getValue("Route")).toBe("a-result");
    });

    it(".validate() does not throw for valid branch configuration", () => {
      const pipeline = createPipeline<{ type: string }>("test")
        .withContext({ type: "a" })
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result");
      expect(() => pipeline.validate()).not.toThrow();
    });
  });

  describe("step configuration methods", () => {
    it(".dependsOn() adds dependencies to the branch step", async () => {
      const result = await createPipeline<{ type: string }>("test")
        .withContext({ type: "a" })
        .step("Prepare", async () => "prepared")
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result")
        .dependsOn("Prepare")
        .execute();
      expect(result.success).toBe(true);
    });

    it(".optional() marks the branch step as optional", async () => {
      // Branch with no match and no otherwise, but optional - should not fail pipeline
      const result = await createPipeline<{ type: string }>("test")
        .withContext({ type: "unknown" })
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result")
        .optional("fallback-value")
        .execute();
      expect(result.success).toBe(true);
    });

    it(".required() marks the branch step as required (default)", async () => {
      // Branch with no match and no otherwise on required step - should fail pipeline
      const result = await createPipeline<{ type: string }>("test")
        .withContext({ type: "unknown" })
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result")
        .required()
        .execute();
      expect(result.success).toBe(false);
    });

    it(".onlyIf() sets conditional execution for the branch step", async () => {
      const result = await createPipeline<{ type: string; runBranch: boolean }>("test")
        .withContext({ type: "a", runBranch: false })
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result")
        .onlyIf((ctx) => ctx.runBranch)
        .execute();
      expect(result.success).toBe(true);
      const stepResult = result.steps.get("Route");
      expect(stepResult?.status).toBe("skipped");
    });
  });

  describe("branch() chaining from BranchConfigurator", () => {
    it("allows chaining another .branch() from a BranchConfigurator", async () => {
      const result = await createPipeline<{ type: string; mode: string }>("test")
        .withContext({ type: "a", mode: "fast" })
        .branch("Route", (ctx) => ctx.userContext.type)
        .when("a", async () => "a-result")
        .branch("Mode", (ctx) => ctx.userContext.mode)
        .when("fast", async () => "fast-result")
        .execute();
      expect(result.success).toBe(true);
      expect(result.getValue("Route")).toBe("a-result");
      expect(result.getValue("Mode")).toBe("fast-result");
    });
  });

  describe("end-to-end branch execution", () => {
    it("selects the correct .when() handler based on discriminator", async () => {
      const result = await createPipeline<{ method: string }>("payment")
        .withContext({ method: "paypal" })
        .branch("Payment", (ctx) => ctx.userContext.method)
        .when("credit", async () => ({ gateway: "stripe" }))
        .when("paypal", async () => ({ gateway: "paypal-sdk" }))
        .when("crypto", async () => ({ gateway: "coinbase" }))
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("Payment")).toEqual({ gateway: "paypal-sdk" });
    });

    it("uses .otherwise() when no .when() matches", async () => {
      const result = await createPipeline<{ method: string }>("payment")
        .withContext({ method: "unknown-method" })
        .branch("Payment", (ctx) => ctx.userContext.method)
        .when("credit", async () => "credit")
        .when("paypal", async () => "paypal")
        .otherwise(async () => "default-handler")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("Payment")).toBe("default-handler");
    });

    it("fails with BranchNotMatchedError when no .when() matches and no .otherwise()", async () => {
      const result = await createPipeline<{ method: string }>("payment")
        .withContext({ method: "bitcoin" })
        .branch("Payment", (ctx) => ctx.userContext.method)
        .when("credit", async () => "credit")
        .when("paypal", async () => "paypal")
        .execute();

      expect(result.success).toBe(false);
      const error = result.getError("Payment");
      expect(error).toBeDefined();
      expect(error?.name).toBe("BranchNotMatchedError");
    });

    it("branch result is accessible to dependent steps", async () => {
      const result = await createPipeline<{ type: string }>("test")
        .withContext({ type: "hello" })
        .branch("Greet", (ctx) => ctx.userContext.type)
        .when("hello", async () => "Hello World!")
        .step("Process", async (ctx: ExecutionContext<{ type: string }>) => {
          const greeting = ctx.stepResults.get("Greet");
          return `Processed: ${greeting}`;
        })
        .dependsOn("Greet")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("Process")).toBe("Processed: Hello World!");
    });
  });
});

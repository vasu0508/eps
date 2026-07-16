// End-to-end integration tests for the full pipeline lifecycle
import { describe, it, expect } from "vitest";
import {
  createPipeline,
  InMemoryMetrics,
} from "../../src/index.js";

describe("Pipeline E2E", () => {
  describe("simple 3-step pipeline with dependencies", () => {
    it("executes steps in dependency order and collects results", async () => {
      const result = await createPipeline("order")
        .step("fetchUser", async () => ({ id: "user-1", name: "Alice" }))
        .step("validate", async (ctx) => {
          const user = ctx.stepResults.get("fetchUser") as { id: string; name: string };
          return { valid: true, userId: user.id };
        })
        .dependsOn("fetchUser")
        .step("process", async (ctx) => {
          const validation = ctx.stepResults.get("validate") as { valid: boolean; userId: string };
          return { processed: true, userId: validation.userId };
        })
        .dependsOn("validate")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("fetchUser")).toEqual({ id: "user-1", name: "Alice" });
      expect(result.getValue("validate")).toEqual({ valid: true, userId: "user-1" });
      expect(result.getValue("process")).toEqual({ processed: true, userId: "user-1" });
    });

    it("preserves correct execution order across dependencies", async () => {
      const executionOrder: string[] = [];

      const result = await createPipeline("sequence")
        .step("first", async () => {
          executionOrder.push("first");
          return 1;
        })
        .step("second", async () => {
          executionOrder.push("second");
          return 2;
        })
        .dependsOn("first")
        .step("third", async () => {
          executionOrder.push("third");
          return 3;
        })
        .dependsOn("second")
        .execute();

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(["first", "second", "third"]);
    });
  });

  describe("pipeline with retry, timeout, and fallback", () => {
    it("retries a flaky step and succeeds on retry", async () => {
      let attempts = 0;

      const result = await createPipeline("resilient")
        .step("flaky", async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("transient failure");
          }
          return "success-after-retries";
        })
        .retry(3, { backoff: "fixed", baseDelay: 100 })
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("flaky")).toBe("success-after-retries");
      expect(attempts).toBe(3);
    });

    it("falls back when retries are exhausted", async () => {
      const result = await createPipeline("fallback-test")
        .step("unreliable", async () => {
          throw new Error("always fails");
        })
        .retry(2, { backoff: "fixed", baseDelay: 100 })
        .fallback(async () => "fallback-result")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("unreliable")).toBe("fallback-result");
    });

    it("enforces timeout and fails the step", async () => {
      const result = await createPipeline("timeout-test")
        .step("slow", async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return "should-not-reach";
        })
        .timeout(50)
        .optional()
        .execute();

      expect(result.success).toBe(true); // optional step
      const stepResult = result.steps.get("slow");
      expect(stepResult?.status).toBe("failed");
    });
  });

  describe("pipeline with conditional steps (.onlyIf())", () => {
    it("executes conditional step when predicate is true", async () => {
      const result = await createPipeline<{ premium: boolean }>("conditional")
        .withContext({ premium: true })
        .step("basic", async () => "basic-data")
        .step("premiumFeature", async () => "premium-data")
        .onlyIf((ctx) => ctx.premium)
        .dependsOn("basic")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("basic")).toBe("basic-data");
      expect(result.getValue("premiumFeature")).toBe("premium-data");
    });

    it("skips conditional step when predicate is false", async () => {
      const result = await createPipeline<{ premium: boolean }>("conditional-skip")
        .withContext({ premium: false })
        .step("basic", async () => "basic-data")
        .step("premiumFeature", async () => "premium-data")
        .onlyIf((ctx) => ctx.premium)
        .dependsOn("basic")
        .step("final", async () => "final-data")
        .dependsOn("premiumFeature")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("basic")).toBe("basic-data");

      const premiumStep = result.steps.get("premiumFeature");
      expect(premiumStep?.status).toBe("skipped");
    });
  });

  describe("pipeline with branch evaluation", () => {
    it("routes to the correct branch handler", async () => {
      const result = await createPipeline<{ method: string }>("payment")
        .withContext({ method: "credit" })
        .branch("route", (ctx) => ctx.userContext.method)
        .when("credit", async () => "stripe-charge")
        .when("paypal", async () => "paypal-sdk")
        .otherwise(async () => "manual-process")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("route")).toBe("stripe-charge");
    });

    it("uses otherwise handler when no branch matches", async () => {
      const result = await createPipeline<{ method: string }>("payment-other")
        .withContext({ method: "bitcoin" })
        .branch("route", (ctx) => ctx.userContext.method)
        .when("credit", async () => "stripe")
        .when("paypal", async () => "paypal")
        .otherwise(async () => "manual-fallback")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("route")).toBe("manual-fallback");
    });

    it("fails with BranchNotMatchedError when no match and no otherwise", async () => {
      const result = await createPipeline<{ method: string }>("payment-no-match")
        .withContext({ method: "bitcoin" })
        .branch("route", (ctx) => ctx.userContext.method)
        .when("credit", async () => "stripe")
        .when("paypal", async () => "paypal")
        .optional()
        .execute();

      expect(result.success).toBe(true); // optional step
      const routeStep = result.steps.get("route");
      expect(routeStep?.status).toBe("failed");
    });
  });

  describe("pipeline with forEach fan-out", () => {
    it("processes each element and collects results in order", async () => {
      const result = await createPipeline<{ items: number[] }>("batch")
        .withContext({ items: [1, 2, 3, 4, 5] })
        .forEach("process", async (ctx) => {
          // The forEach executor passes each item as the userContext
          const item = ctx.userContext as unknown as number;
          return item * 2;
        })
        .from((ctx) => ctx.userContext.items)
        .withConcurrency(2)
        .execute();

      expect(result.success).toBe(true);
      const processResult = result.getValue<number[]>("process");
      expect(processResult).toHaveLength(5);
      expect(processResult).toEqual([2, 4, 6, 8, 10]);
    });

    it("handles empty collection with immediate success", async () => {
      const result = await createPipeline<{ items: number[] }>("batch-empty")
        .withContext({ items: [] })
        .forEach("process", async (ctx) => {
          return (ctx.userContext as unknown as number) * 2;
        })
        .from((ctx) => ctx.userContext.items)
        .execute();

      expect(result.success).toBe(true);
      const processResult = result.getValue<unknown[]>("process");
      expect(processResult).toEqual([]);
    });
  });

  describe("pipeline with repeatUntil polling", () => {
    it("repeats until predicate is satisfied", async () => {
      let count = 0;

      const result = await createPipeline("poll")
        .repeatUntil("check", async () => {
          count++;
          return { done: count >= 3, count };
        })
        .until((r: any) => r.done)
        .maxIterations(10)
        .delay(10)
        .execute();

      expect(result.success).toBe(true);
      const checkResult = result.getValue<{ done: boolean; count: number }>("check");
      expect(checkResult?.done).toBe(true);
      expect(checkResult?.count).toBe(3);
      expect(count).toBe(3);
    });

    it("fails with MaxIterationsExhaustedError when limit reached", async () => {
      let count = 0;

      const result = await createPipeline("poll-exhausted")
        .repeatUntil("check", async () => {
          count++;
          return { done: false, count };
        })
        .until((r: any) => r.done)
        .maxIterations(3)
        .delay(5)
        .optional()
        .execute();

      expect(result.success).toBe(true); // optional
      const stepResult = result.steps.get("check");
      expect(stepResult?.status).toBe("failed");
      expect(count).toBe(3);
    });
  });

  describe("pipeline cancellation via abort signal", () => {
    it("cancels pipeline when abort signal fires mid-execution", async () => {
      const controller = new AbortController();

      const result = await createPipeline("cancellable")
        .step("fast", async () => {
          return "done-fast";
        })
        .step("slow", async () => {
          // Trigger abort after short delay
          setTimeout(() => controller.abort(), 10);
          await new Promise((resolve) => setTimeout(resolve, 500));
          return "should-not-reach";
        })
        .dependsOn("fast")
        .execute({ signal: controller.signal });

      expect(result.success).toBe(false);
      // fast step should have completed before abort
      expect(result.getValue("fast")).toBe("done-fast");
    });

    it("rejects immediately if signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await createPipeline("already-aborted")
        .step("never", async () => "should-not-execute")
        .execute({ signal: controller.signal });

      expect(result.success).toBe(false);
      const stepResult = result.steps.get("never");
      expect(stepResult?.status).toBe("skipped");
    });
  });

  describe("observability integration (logger, metrics)", () => {
    it("pipeline executes with metrics collector configured", async () => {
      const metrics = new InMemoryMetrics();

      const result = await createPipeline("observable")
        .withMetrics(metrics)
        .step("stepA", async () => "a-result")
        .step("stepB", async () => "b-result")
        .dependsOn("stepA")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("stepA")).toBe("a-result");
      expect(result.getValue("stepB")).toBe("b-result");
    });

    it("logger does not crash the pipeline if it throws", async () => {
      const faultyLogger = {
        debug: () => { throw new Error("logger crash"); },
        info: () => { throw new Error("logger crash"); },
        warn: () => { throw new Error("logger crash"); },
        error: () => { throw new Error("logger crash"); },
      };

      const result = await createPipeline("faulty-logger")
        .withLogger(faultyLogger)
        .step("resilient", async () => "still-works")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("resilient")).toBe("still-works");
    });
  });

  describe("pipeline result serialization", () => {
    it("produces valid JSON via toJSON()", async () => {
      const result = await createPipeline("serializable")
        .step("first", async () => ({ data: "hello" }))
        .step("second", async () => 42)
        .dependsOn("first")
        .execute();

      expect(result.success).toBe(true);

      // Serialize the full result
      const json = result.toJSON();
      const stringified = JSON.stringify(json);
      const parsed = JSON.parse(stringified);

      // Verify core fields survived round-trip
      expect(parsed.success).toBe(true);
      expect(parsed.executionId).toBe(result.executionId);
      expect(parsed.correlationId).toBe(result.correlationId);
      expect(parsed.duration).toBeGreaterThanOrEqual(0);
      expect(parsed.report).toBeDefined();
      expect(parsed.report.executionId).toBe(result.executionId);
      expect(parsed.report.status).toBe("success");
    });

    it("serializes the execution report with ISO timestamps", async () => {
      const result = await createPipeline("report-test")
        .step("only", async () => "value")
        .execute({ correlationId: "custom-corr-123" });

      const report = result.report.toJSON();

      expect(report.correlationId).toBe("custom-corr-123");
      // ISO 8601 format check
      expect(report.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(report.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(report.duration).toBeGreaterThanOrEqual(0);
      expect(report.graph).toHaveProperty("only");
    });
  });

  describe("error propagation and failure cascade", () => {
    it("required step failure causes pipeline failure", async () => {
      const result = await createPipeline("failure-cascade")
        .step("pass", async () => "ok")
        .step("fail", async () => {
          throw new Error("critical failure");
        })
        .required()
        .dependsOn("pass")
        .step("dependent", async () => "should-be-skipped")
        .dependsOn("fail")
        .execute();

      expect(result.success).toBe(false);
      expect(result.getValue("pass")).toBe("ok");
      expect(result.getError("fail")).toBeDefined();
      expect(result.getError("fail")?.message).toBe("critical failure");

      const dependentStep = result.steps.get("dependent");
      expect(dependentStep?.status).toBe("skipped");
    });

    it("cascades failure through transitive dependencies", async () => {
      const result = await createPipeline("transitive-cascade")
        .step("root", async () => {
          throw new Error("root failure");
        })
        .required()
        .step("child", async () => "child-value")
        .dependsOn("root")
        .step("grandchild", async () => "grandchild-value")
        .dependsOn("child")
        .execute();

      expect(result.success).toBe(false);
      expect(result.steps.get("root")?.status).toBe("failed");
      expect(result.steps.get("child")?.status).toBe("skipped");
      expect(result.steps.get("grandchild")?.status).toBe("skipped");
    });

    it("optional step failure does not cascade to pipeline failure", async () => {
      const result = await createPipeline("optional-fail")
        .step("required-step", async () => "ok")
        .step("optional-step", async () => {
          throw new Error("optional failure");
        })
        .optional()
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("required-step")).toBe("ok");
      expect(result.steps.get("optional-step")?.status).toBe("failed");
    });
  });

  describe("combined features", () => {
    it("retry + fallback + dependency chain works end-to-end", async () => {
      let primaryAttempts = 0;

      const result = await createPipeline("combo")
        .step("init", async () => "initialized")
        .step("unreliable", async () => {
          primaryAttempts++;
          throw new Error(`fail #${primaryAttempts}`);
        })
        .retry(2, { backoff: "fixed", baseDelay: 100 })
        .fallback(async () => "recovered-via-fallback")
        .dependsOn("init")
        .step("final", async (ctx) => {
          const prev = ctx.stepResults.get("unreliable");
          return `completed with: ${prev}`;
        })
        .dependsOn("unreliable")
        .execute();

      expect(result.success).toBe(true);
      expect(result.getValue("unreliable")).toBe("recovered-via-fallback");
      expect(result.getValue("final")).toBe("completed with: recovered-via-fallback");
      // retry(2) → shouldRetry cuts off at attempt >= count, so 2 total attempts before fallback
      expect(primaryAttempts).toBe(2);
    });

    it("conditional step + dependency ordering works together", async () => {
      const executionOrder: string[] = [];

      const result = await createPipeline<{ flag: boolean }>("cond-dep")
        .withContext({ flag: true })
        .step("a", async () => {
          executionOrder.push("a");
          return "a-result";
        })
        .step("b", async () => {
          executionOrder.push("b");
          return "b-result";
        })
        .onlyIf((ctx) => ctx.flag)
        .dependsOn("a")
        .step("c", async () => {
          executionOrder.push("c");
          return "c-result";
        })
        .dependsOn("b")
        .execute();

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(["a", "b", "c"]);
    });

    it("pipeline-level timeout aborts all running steps", async () => {
      const result = await createPipeline("pipeline-timeout")
        .step("fast", async () => "quick")
        .step("very-slow", async (ctx) => {
          // Cooperatively check abort signal
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 5000);
            ctx.abortSignal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return "never";
        })
        .dependsOn("fast")
        .execute({ timeout: 100 });

      // Pipeline should fail due to timeout
      expect(result.success).toBe(false);
      expect(result.getValue("fast")).toBe("quick");
    }, 10000);
  });
});

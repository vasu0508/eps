// Unit tests for step scheduler
import { describe, it, expect, vi } from "vitest";
import { runScheduler } from "../../src/execution/step-scheduler.js";
import type { SchedulerOptions, SchedulerEvent } from "../../src/execution/step-scheduler.js";
import { buildExecutionGraph } from "../../src/graph/execution-graph.js";
import type { StepNode } from "../../src/types/graph.js";
import type { ExecutionContext } from "../../src/types.js";

/** Helper: create a minimal StepNode */
function makeNode(overrides: Partial<StepNode> & { name: string }): StepNode {
  return {
    handler: async () => `result-${overrides.name}`,
    policies: {},
    dependencies: [],
    isRequired: true,
    ...overrides,
  } as StepNode;
}

/** Helper: build a minimal execution context */
function makeContext(overrides?: Partial<ExecutionContext<unknown>>): ExecutionContext<unknown> {
  return {
    pipelineId: "test-pipeline",
    correlationId: "test-corr-id",
    stepResults: new Map(),
    userContext: {},
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { increment: vi.fn(), gauge: vi.fn(), histogram: vi.fn(), timing: vi.fn() },
    ...overrides,
  };
}

describe("Step Scheduler", () => {
  describe("basic execution", () => {
    it("executes a single step and succeeds", async () => {
      const node = makeNode({ name: "A", handler: async () => "hello" });
      const graph = buildExecutionGraph([node]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(result.stepResults.get("A")?.status).toBe("success");
      expect((result.stepResults.get("A") as any).value).toBe("hello");
    });

    it("executes multiple independent steps in parallel", async () => {
      const callOrder: string[] = [];
      const nodeA = makeNode({
        name: "A",
        handler: async () => { callOrder.push("A"); return "a"; },
      });
      const nodeB = makeNode({
        name: "B",
        handler: async () => { callOrder.push("B"); return "b"; },
      });
      const graph = buildExecutionGraph([nodeA, nodeB]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(result.stepResults.get("A")?.status).toBe("success");
      expect(result.stepResults.get("B")?.status).toBe("success");
    });

    it("respects dependency order", async () => {
      const callOrder: string[] = [];
      const nodeA = makeNode({
        name: "A",
        handler: async () => { callOrder.push("A"); return "a"; },
      });
      const nodeB = makeNode({
        name: "B",
        dependencies: ["A"],
        handler: async () => { callOrder.push("B"); return "b"; },
      });
      const graph = buildExecutionGraph([nodeA, nodeB]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(callOrder).toEqual(["A", "B"]);
    });

    it("executes a diamond dependency graph correctly", async () => {
      const callOrder: string[] = [];
      const nodes = [
        makeNode({ name: "A", handler: async () => { callOrder.push("A"); return "a"; } }),
        makeNode({ name: "B", dependencies: ["A"], handler: async () => { callOrder.push("B"); return "b"; } }),
        makeNode({ name: "C", dependencies: ["A"], handler: async () => { callOrder.push("C"); return "c"; } }),
        makeNode({ name: "D", dependencies: ["B", "C"], handler: async () => { callOrder.push("D"); return "d"; } }),
      ];
      const graph = buildExecutionGraph(nodes);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(callOrder.indexOf("A")).toBeLessThan(callOrder.indexOf("B"));
      expect(callOrder.indexOf("A")).toBeLessThan(callOrder.indexOf("C"));
      expect(callOrder.indexOf("B")).toBeLessThan(callOrder.indexOf("D"));
      expect(callOrder.indexOf("C")).toBeLessThan(callOrder.indexOf("D"));
    });
  });

  describe("required step failure", () => {
    it("aborts pipeline when required step fails", async () => {
      const nodeA = makeNode({
        name: "A",
        handler: async () => { throw new Error("boom"); },
        isRequired: true,
      });
      const nodeB = makeNode({
        name: "B",
        dependencies: ["A"],
        handler: async () => "b",
      });
      const graph = buildExecutionGraph([nodeA, nodeB]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(false);
      expect(result.stepResults.get("A")?.status).toBe("failed");
      // B should be skipped because dependency failed
      const bResult = result.stepResults.get("B");
      expect(bResult?.status).toBe("skipped");
      if (bResult?.status === "skipped") {
        expect(bResult.reason).toContain("dependency failed");
      }
    });

    it("skips transitive dependents of failed required step", async () => {
      const nodes = [
        makeNode({ name: "A", handler: async () => { throw new Error("fail"); }, isRequired: true }),
        makeNode({ name: "B", dependencies: ["A"], handler: async () => "b" }),
        makeNode({ name: "C", dependencies: ["B"], handler: async () => "c" }),
      ];
      const graph = buildExecutionGraph(nodes);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(false);
      expect(result.stepResults.get("B")?.status).toBe("skipped");
      expect(result.stepResults.get("C")?.status).toBe("skipped");
    });
  });

  describe("optional step failure", () => {
    it("continues pipeline when optional step fails with default value", async () => {
      const nodeA = makeNode({
        name: "A",
        handler: async () => { throw new Error("optional fail"); },
        isRequired: false,
        policies: { defaultValue: "fallback-value" },
      });
      const nodeB = makeNode({
        name: "B",
        dependencies: ["A"],
        handler: async () => "b",
      });
      const graph = buildExecutionGraph([nodeA, nodeB]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(result.stepResults.get("A")?.status).toBe("default");
      expect((result.stepResults.get("A") as any).value).toBe("fallback-value");
      expect(result.stepResults.get("B")?.status).toBe("success");
    });

    it("continues pipeline when optional step fails without default value", async () => {
      const nodeA = makeNode({
        name: "A",
        handler: async () => { throw new Error("optional fail"); },
        isRequired: false,
      });
      const nodeB = makeNode({
        name: "B",
        handler: async () => "b",
      });
      const graph = buildExecutionGraph([nodeA, nodeB]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(result.stepResults.get("A")?.status).toBe("failed");
      expect(result.stepResults.get("B")?.status).toBe("success");
    });
  });

  describe("conditional execution (.onlyIf())", () => {
    it("skips step when condition returns false", async () => {
      const node = makeNode({
        name: "A",
        handler: async () => "a",
        policies: { condition: () => false },
      });
      const graph = buildExecutionGraph([node]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(result.stepResults.get("A")?.status).toBe("skipped");
      if (result.stepResults.get("A")?.status === "skipped") {
        expect(result.stepResults.get("A")!.reason).toBe("condition not met");
      }
    });

    it("executes step when condition returns true", async () => {
      const node = makeNode({
        name: "A",
        handler: async () => "a",
        policies: { condition: () => true },
      });
      const graph = buildExecutionGraph([node]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(result.stepResults.get("A")?.status).toBe("success");
    });

    it("skipped conditional step allows dependents to proceed", async () => {
      const nodes = [
        makeNode({ name: "A", handler: async () => "a", policies: { condition: () => false } }),
        makeNode({ name: "B", dependencies: ["A"], handler: async () => "b" }),
      ];
      const graph = buildExecutionGraph(nodes);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(true);
      expect(result.stepResults.get("A")?.status).toBe("skipped");
      expect(result.stepResults.get("B")?.status).toBe("success");
    });

    it("marks step as failed when condition throws", async () => {
      const node = makeNode({
        name: "A",
        handler: async () => "a",
        policies: { condition: () => { throw new Error("condition error"); } },
        isRequired: true,
      });
      const graph = buildExecutionGraph([node]);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(false);
      expect(result.stepResults.get("A")?.status).toBe("failed");
    });

    it("passes userContext to the condition predicate", async () => {
      const predicateSpy = vi.fn().mockReturnValue(true);
      const node = makeNode({
        name: "A",
        handler: async () => "a",
        policies: { condition: predicateSpy },
      });
      const ctx = makeContext({ userContext: { flag: true } });
      const graph = buildExecutionGraph([node]);
      await runScheduler({ graph, context: ctx });

      expect(predicateSpy).toHaveBeenCalledWith({ flag: true });
    });
  });

  describe("concurrency control", () => {
    it("respects maxConcurrency limit", async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const makeSlowNode = (name: string) => makeNode({
        name,
        handler: async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise(r => setTimeout(r, 50));
          currentConcurrent--;
          return name;
        },
      });

      const nodes = [makeSlowNode("A"), makeSlowNode("B"), makeSlowNode("C"), makeSlowNode("D")];
      const graph = buildExecutionGraph(nodes);
      const result = await runScheduler({
        graph,
        context: makeContext(),
        maxConcurrency: 2,
      });

      expect(result.success).toBe(true);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("maxConcurrency=1 runs steps sequentially", async () => {
      const callOrder: string[] = [];
      const nodes = [
        makeNode({ name: "A", handler: async () => { callOrder.push("A-start"); await new Promise(r => setTimeout(r, 10)); callOrder.push("A-end"); return "a"; } }),
        makeNode({ name: "B", handler: async () => { callOrder.push("B-start"); await new Promise(r => setTimeout(r, 10)); callOrder.push("B-end"); return "b"; } }),
      ];
      const graph = buildExecutionGraph(nodes);
      await runScheduler({ graph, context: makeContext(), maxConcurrency: 1 });

      // With maxConcurrency=1, steps should not interleave
      const aEnd = callOrder.indexOf("A-end");
      const bStart = callOrder.indexOf("B-start");
      // One step should finish before the other starts (order may vary)
      expect(
        (aEnd < bStart) ||
        (callOrder.indexOf("B-end") < callOrder.indexOf("A-start"))
      ).toBe(true);
    });
  });

  describe("cancellation", () => {
    it("skips all steps when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort("pre-aborted");

      const node = makeNode({ name: "A", handler: async () => "a" });
      const graph = buildExecutionGraph([node]);
      const result = await runScheduler({
        graph,
        context: makeContext(),
        signal: controller.signal,
      });

      expect(result.success).toBe(false);
      expect(result.stepResults.get("A")?.status).toBe("skipped");
    });

    it("cancels pending steps when signal fires during execution", async () => {
      const controller = new AbortController();

      const nodes = [
        makeNode({
          name: "A",
          handler: async () => {
            // Abort while step A is running
            controller.abort("mid-execution abort");
            return "a";
          },
        }),
        makeNode({ name: "B", dependencies: ["A"], handler: async () => "b" }),
      ];
      const graph = buildExecutionGraph(nodes);
      const result = await runScheduler({
        graph,
        context: makeContext(),
        signal: controller.signal,
      });

      expect(result.success).toBe(false);
      // A may have completed (since it triggered the abort after its work was done)
      // B should be cancelled/skipped
      const bResult = result.stepResults.get("B");
      expect(bResult?.status === "skipped" || !bResult).toBe(true);
    });

    it("emits pipeline:aborted event on cancellation", async () => {
      const controller = new AbortController();
      controller.abort("test-abort");

      const node = makeNode({ name: "A", handler: async () => "a" });
      const graph = buildExecutionGraph([node]);
      const collectedEvents: SchedulerEvent[] = [];
      await runScheduler({
        graph,
        context: makeContext(),
        signal: controller.signal,
        onEvent: (e) => collectedEvents.push(e),
      });

      const abortEvent = collectedEvents.find(e => e.type === "pipeline:aborted");
      expect(abortEvent).toBeDefined();
    });
  });

  describe("event emission", () => {
    it("emits step:start, step:complete, and pipeline:complete events", async () => {
      const node = makeNode({ name: "A", handler: async () => "a" });
      const graph = buildExecutionGraph([node]);
      const collectedEvents: SchedulerEvent[] = [];
      await runScheduler({
        graph,
        context: makeContext(),
        onEvent: (e) => collectedEvents.push(e),
      });

      const types = collectedEvents.map(e => e.type);
      expect(types).toContain("step:start");
      expect(types).toContain("step:complete");
      expect(types).toContain("pipeline:complete");
    });

    it("emits step:skipped for conditional skip", async () => {
      const node = makeNode({
        name: "A",
        handler: async () => "a",
        policies: { condition: () => false },
      });
      const graph = buildExecutionGraph([node]);
      const collectedEvents: SchedulerEvent[] = [];
      await runScheduler({
        graph,
        context: makeContext(),
        onEvent: (e) => collectedEvents.push(e),
      });

      const skipEvent = collectedEvents.find(
        e => e.type === "step:skipped" && e.step === "A"
      );
      expect(skipEvent).toBeDefined();
      if (skipEvent?.type === "step:skipped") {
        expect(skipEvent.reason).toBe("condition not met");
      }
    });

    it("emits step:failed for failed required step", async () => {
      const node = makeNode({
        name: "A",
        handler: async () => { throw new Error("test"); },
        isRequired: true,
      });
      const graph = buildExecutionGraph([node]);
      const collectedEvents: SchedulerEvent[] = [];
      await runScheduler({
        graph,
        context: makeContext(),
        onEvent: (e) => collectedEvents.push(e),
      });

      const failEvent = collectedEvents.find(
        e => e.type === "step:failed" && e.step === "A"
      );
      expect(failEvent).toBeDefined();
    });
  });

  describe("unreachable steps", () => {
    it("marks unreachable steps as skipped when no progress can be made", async () => {
      // Create a scenario where B depends on A, but A fails (required)
      // C depends on B, so both B and C become unreachable/skipped
      const nodes = [
        makeNode({ name: "A", handler: async () => { throw new Error("fail"); }, isRequired: true }),
        makeNode({ name: "B", dependencies: ["A"], handler: async () => "b" }),
        makeNode({ name: "C", dependencies: ["B"], handler: async () => "c" }),
      ];
      const graph = buildExecutionGraph(nodes);
      const result = await runScheduler({ graph, context: makeContext() });

      expect(result.success).toBe(false);
      expect(result.stepResults.get("B")?.status).toBe("skipped");
      expect(result.stepResults.get("C")?.status).toBe("skipped");
    });
  });
});

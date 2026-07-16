import { describe, it, expect } from "vitest";
import { InMemoryMetrics } from "../../src/observability/metrics.js";

describe("InMemoryMetrics", () => {
  it("should record increment calls", () => {
    const metrics = new InMemoryMetrics();
    metrics.increment("step.retry", { pipeline: "test", step: "fetch" });

    const entries = metrics.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("increment");
    expect(entries[0].metric).toBe("step.retry");
    expect(entries[0].value).toBe(1);
    expect(entries[0].tags).toEqual({ pipeline: "test", step: "fetch" });
  });

  it("should record gauge calls with value", () => {
    const metrics = new InMemoryMetrics();
    metrics.gauge("pipeline.active_steps", 3, { pipeline: "order" });

    const entries = metrics.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("gauge");
    expect(entries[0].metric).toBe("pipeline.active_steps");
    expect(entries[0].value).toBe(3);
  });

  it("should record histogram calls with value", () => {
    const metrics = new InMemoryMetrics();
    metrics.histogram("step.duration", 150, { step: "billing" });

    const entries = metrics.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("histogram");
    expect(entries[0].metric).toBe("step.duration");
    expect(entries[0].value).toBe(150);
  });

  it("should record timing calls with duration", () => {
    const metrics = new InMemoryMetrics();
    metrics.timing("step.execution_time", 250);

    const entries = metrics.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("timing");
    expect(entries[0].metric).toBe("step.execution_time");
    expect(entries[0].value).toBe(250);
  });

  it("should include a timestamp on each entry", () => {
    const metrics = new InMemoryMetrics();
    const before = Date.now();
    metrics.increment("test.metric");
    const after = Date.now();

    const entries = metrics.snapshot();
    expect(entries[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(entries[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("should accumulate multiple entries in order", () => {
    const metrics = new InMemoryMetrics();
    metrics.increment("a");
    metrics.gauge("b", 5);
    metrics.histogram("c", 10);
    metrics.timing("d", 20);

    const entries = metrics.snapshot();
    expect(entries).toHaveLength(4);
    expect(entries[0].metric).toBe("a");
    expect(entries[1].metric).toBe("b");
    expect(entries[2].metric).toBe("c");
    expect(entries[3].metric).toBe("d");
  });

  it("should handle tags being undefined", () => {
    const metrics = new InMemoryMetrics();
    metrics.increment("no.tags");

    const entries = metrics.snapshot();
    expect(entries[0].tags).toBeUndefined();
  });

  it("getMetrics should return same data as snapshot", () => {
    const metrics = new InMemoryMetrics();
    metrics.increment("x");
    metrics.gauge("y", 1);

    expect(metrics.getMetrics()).toEqual(metrics.snapshot());
  });

  it("snapshot should return a copy (not the internal array)", () => {
    const metrics = new InMemoryMetrics();
    metrics.increment("first");
    const snap1 = metrics.snapshot();
    metrics.increment("second");
    const snap2 = metrics.snapshot();

    expect(snap1).toHaveLength(1);
    expect(snap2).toHaveLength(2);
  });

  it("reset should clear all entries", () => {
    const metrics = new InMemoryMetrics();
    metrics.increment("a");
    metrics.gauge("b", 1);
    metrics.reset();

    expect(metrics.snapshot()).toHaveLength(0);
  });
});

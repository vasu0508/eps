import { describe, it, expect } from "vitest";
import { NoopTracer } from "../../src/observability/tracer.js";

describe("NoopTracer", () => {
  it("should return a Span from startSpan", () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("test-span");
    expect(span).toBeDefined();
    expect(typeof span.end).toBe("function");
    expect(typeof span.setAttribute).toBe("function");
    expect(typeof span.setStatus).toBe("function");
  });

  it("span.end should not throw", () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("op");
    expect(() => span.end()).not.toThrow();
  });

  it("span.setAttribute should not throw", () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("op");
    expect(() => span.setAttribute("key", "value")).not.toThrow();
    expect(() => span.setAttribute("count", 42)).not.toThrow();
    expect(() => span.setAttribute("flag", true)).not.toThrow();
  });

  it("span.setStatus should not throw", () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("op");
    expect(() => span.setStatus("ok")).not.toThrow();
    expect(() => span.setStatus("error", "something went wrong")).not.toThrow();
  });

  it("should accept SpanOptions without error", () => {
    const tracer = new NoopTracer();
    const parentSpan = tracer.startSpan("parent");
    const childSpan = tracer.startSpan("child", {
      attributes: { key: "value" },
      parent: parentSpan,
    });
    expect(childSpan).toBeDefined();
  });

  it("each startSpan call should return a new span instance", () => {
    const tracer = new NoopTracer();
    const span1 = tracer.startSpan("a");
    const span2 = tracer.startSpan("b");
    // Both are no-op spans but should be different objects
    expect(span1).not.toBe(span2);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { ConsoleLogger } from "../../src/observability/logger.js";
import { InMemoryMetrics } from "../../src/observability/metrics.js";
import { NoopTracer } from "../../src/observability/tracer.js";

/**
 * Property-based tests for Observability Layer
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6**
 */
describe("Observability — Property Tests", () => {
  // Arbitraries
  const logLevel = fc.constantFrom("debug", "info", "warn", "error") as fc.Arbitrary<
    "debug" | "info" | "warn" | "error"
  >;
  const arbitraryMessage = fc.string({ minLength: 1, maxLength: 200 });
  const arbitraryPrefix = fc.string({ minLength: 0, maxLength: 50 });
  const arbitraryMetricName = fc.string({ minLength: 1, maxLength: 100 });
  const arbitraryValue = fc.double({ min: -1e9, max: 1e9, noNaN: true });
  const arbitraryPositiveValue = fc.double({ min: 0, max: 1e9, noNaN: true });
  const arbitraryTags = fc.option(
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.string({ minLength: 0, maxLength: 50 }),
      { minKeys: 0, maxKeys: 5 }
    ),
    { nil: undefined }
  );
  const arbitraryMeta = fc.option(
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }),
      fc.oneof(fc.string(), fc.integer(), fc.boolean()),
      { minKeys: 0, maxKeys: 5 }
    ),
    { nil: undefined }
  );
  const arbitrarySpanName = fc.string({ minLength: 1, maxLength: 100 });
  const arbitraryAttributeKey = fc.string({ minLength: 1, maxLength: 30 });
  const arbitraryAttributeValue = fc.oneof(
    fc.string({ minLength: 0, maxLength: 50 }),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean()
  );

  describe("Property 19: Structured Logging — all log calls include timestamp and structured data", () => {
    let consoleSpy: Record<string, ReturnType<typeof vi.spyOn>>;

    beforeEach(() => {
      consoleSpy = {
        debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
        info: vi.spyOn(console, "info").mockImplementation(() => {}),
        warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
        error: vi.spyOn(console, "error").mockImplementation(() => {}),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("every log call includes an ISO timestamp", () => {
      fc.assert(
        fc.property(logLevel, arbitraryMessage, arbitraryMeta, (level, message, meta) => {
          // Reset spies
          Object.values(consoleSpy).forEach((spy) => spy.mockClear());

          const logger = new ConsoleLogger();
          logger[level](message, meta);

          const spy = consoleSpy[level];
          expect(spy).toHaveBeenCalledOnce();

          const output = spy.mock.calls[0][0] as string;
          // ISO 8601 timestamp pattern
          expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        })
      );
    });

    it("every log call includes the original message", () => {
      fc.assert(
        fc.property(logLevel, arbitraryMessage, arbitraryMeta, (level, message, meta) => {
          Object.values(consoleSpy).forEach((spy) => spy.mockClear());

          const logger = new ConsoleLogger();
          logger[level](message, meta);

          const spy = consoleSpy[level];
          const output = spy.mock.calls[0][0] as string;
          expect(output).toContain(message);
        })
      );
    });

    it("every log call includes the level in uppercase", () => {
      fc.assert(
        fc.property(logLevel, arbitraryMessage, (level, message) => {
          Object.values(consoleSpy).forEach((spy) => spy.mockClear());

          const logger = new ConsoleLogger();
          logger[level](message);

          const spy = consoleSpy[level];
          const output = spy.mock.calls[0][0] as string;
          expect(output).toContain(level.toUpperCase());
        })
      );
    });

    it("log calls route to the correct console method", () => {
      fc.assert(
        fc.property(logLevel, arbitraryMessage, (level, message) => {
          Object.values(consoleSpy).forEach((spy) => spy.mockClear());

          const logger = new ConsoleLogger();
          logger[level](message);

          // Only the target method should be called
          expect(consoleSpy[level]).toHaveBeenCalledOnce();
          for (const [key, spy] of Object.entries(consoleSpy)) {
            if (key !== level) {
              expect(spy).not.toHaveBeenCalled();
            }
          }
        })
      );
    });

    it("prefix is included in output when provided", () => {
      fc.assert(
        fc.property(
          arbitraryPrefix.filter((p) => p.length > 0),
          logLevel,
          arbitraryMessage,
          (prefix, level, message) => {
            Object.values(consoleSpy).forEach((spy) => spy.mockClear());

            const logger = new ConsoleLogger(prefix);
            logger[level](message);

            const spy = consoleSpy[level];
            const output = spy.mock.calls[0][0] as string;
            expect(output).toContain(`[${prefix}]`);
          }
        )
      );
    });

    it("metadata is included as JSON when provided with non-empty keys", () => {
      fc.assert(
        fc.property(
          logLevel,
          arbitraryMessage,
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            { minKeys: 1, maxKeys: 5 }
          ),
          (level, message, meta) => {
            Object.values(consoleSpy).forEach((spy) => spy.mockClear());

            const logger = new ConsoleLogger();
            logger[level](message, meta);

            const spy = consoleSpy[level];
            const output = spy.mock.calls[0][0] as string;
            // The output should contain the JSON-serialized meta
            expect(output).toContain(JSON.stringify(meta));
          }
        )
      );
    });
  });

  describe("Property 20: Metric Emission — metrics record correct values and tags", () => {
    it("increment always records value 1 with the given metric name", () => {
      fc.assert(
        fc.property(arbitraryMetricName, arbitraryTags, (metric, tags) => {
          const metrics = new InMemoryMetrics();
          metrics.increment(metric, tags);

          const entries = metrics.snapshot();
          expect(entries).toHaveLength(1);
          expect(entries[0].type).toBe("increment");
          expect(entries[0].metric).toBe(metric);
          expect(entries[0].value).toBe(1);
          expect(entries[0].tags).toEqual(tags);
        })
      );
    });

    it("gauge records the exact value and tags", () => {
      fc.assert(
        fc.property(arbitraryMetricName, arbitraryValue, arbitraryTags, (metric, value, tags) => {
          const metrics = new InMemoryMetrics();
          metrics.gauge(metric, value, tags);

          const entries = metrics.snapshot();
          expect(entries).toHaveLength(1);
          expect(entries[0].type).toBe("gauge");
          expect(entries[0].metric).toBe(metric);
          expect(entries[0].value).toBe(value);
          expect(entries[0].tags).toEqual(tags);
        })
      );
    });

    it("histogram records the exact value and tags", () => {
      fc.assert(
        fc.property(arbitraryMetricName, arbitraryValue, arbitraryTags, (metric, value, tags) => {
          const metrics = new InMemoryMetrics();
          metrics.histogram(metric, value, tags);

          const entries = metrics.snapshot();
          expect(entries).toHaveLength(1);
          expect(entries[0].type).toBe("histogram");
          expect(entries[0].metric).toBe(metric);
          expect(entries[0].value).toBe(value);
          expect(entries[0].tags).toEqual(tags);
        })
      );
    });

    it("timing records the exact duration and tags", () => {
      fc.assert(
        fc.property(
          arbitraryMetricName,
          arbitraryPositiveValue,
          arbitraryTags,
          (metric, duration, tags) => {
            const metrics = new InMemoryMetrics();
            metrics.timing(metric, duration, tags);

            const entries = metrics.snapshot();
            expect(entries).toHaveLength(1);
            expect(entries[0].type).toBe("timing");
            expect(entries[0].metric).toBe(metric);
            expect(entries[0].value).toBe(duration);
            expect(entries[0].tags).toEqual(tags);
          }
        )
      );
    });

    it("snapshot returns all recorded entries in insertion order", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              type: fc.constantFrom("increment", "gauge", "histogram", "timing") as fc.Arbitrary<
                "increment" | "gauge" | "histogram" | "timing"
              >,
              metric: arbitraryMetricName,
              value: arbitraryPositiveValue,
              tags: arbitraryTags,
            }),
            { minLength: 1, maxLength: 20 }
          ),
          (operations) => {
            const metrics = new InMemoryMetrics();

            for (const op of operations) {
              switch (op.type) {
                case "increment":
                  metrics.increment(op.metric, op.tags);
                  break;
                case "gauge":
                  metrics.gauge(op.metric, op.value, op.tags);
                  break;
                case "histogram":
                  metrics.histogram(op.metric, op.value, op.tags);
                  break;
                case "timing":
                  metrics.timing(op.metric, op.value, op.tags);
                  break;
              }
            }

            const entries = metrics.snapshot();
            expect(entries).toHaveLength(operations.length);

            // Verify order and metric names are preserved
            for (let i = 0; i < operations.length; i++) {
              expect(entries[i].type).toBe(operations[i].type);
              expect(entries[i].metric).toBe(operations[i].metric);
            }
          }
        )
      );
    });

    it("reset clears all entries so snapshot returns empty", () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryMetricName, { minLength: 1, maxLength: 10 }),
          (metricNames) => {
            const metrics = new InMemoryMetrics();

            // Record some metrics
            for (const name of metricNames) {
              metrics.increment(name);
            }
            expect(metrics.snapshot().length).toBe(metricNames.length);

            // Reset should clear everything
            metrics.reset();
            expect(metrics.snapshot()).toHaveLength(0);
          }
        )
      );
    });

    it("each metric entry includes a timestamp that is a valid number", () => {
      fc.assert(
        fc.property(arbitraryMetricName, arbitraryValue, (metric, value) => {
          const before = Date.now();
          const metrics = new InMemoryMetrics();
          metrics.gauge(metric, value);
          const after = Date.now();

          const entries = metrics.snapshot();
          expect(entries[0].timestamp).toBeGreaterThanOrEqual(before);
          expect(entries[0].timestamp).toBeLessThanOrEqual(after);
        })
      );
    });
  });

  describe("NoopTracer — startSpan returns Span with no-op methods that don't throw", () => {
    it("startSpan returns a span with all required methods for any name", () => {
      fc.assert(
        fc.property(arbitrarySpanName, (name) => {
          const tracer = new NoopTracer();
          const span = tracer.startSpan(name);

          expect(span).toBeDefined();
          expect(typeof span.end).toBe("function");
          expect(typeof span.setAttribute).toBe("function");
          expect(typeof span.setStatus).toBe("function");
        })
      );
    });

    it("span.end never throws for any span name", () => {
      fc.assert(
        fc.property(arbitrarySpanName, (name) => {
          const tracer = new NoopTracer();
          const span = tracer.startSpan(name);
          expect(() => span.end()).not.toThrow();
        })
      );
    });

    it("span.setAttribute never throws for any key-value combination", () => {
      fc.assert(
        fc.property(arbitrarySpanName, arbitraryAttributeKey, arbitraryAttributeValue, (name, key, value) => {
          const tracer = new NoopTracer();
          const span = tracer.startSpan(name);
          expect(() => span.setAttribute(key, value)).not.toThrow();
        })
      );
    });

    it("span.setStatus never throws for any status and message", () => {
      fc.assert(
        fc.property(
          arbitrarySpanName,
          fc.constantFrom("ok", "error") as fc.Arbitrary<"ok" | "error">,
          fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
          (name, status, message) => {
            const tracer = new NoopTracer();
            const span = tracer.startSpan(name);
            expect(() => span.setStatus(status, message)).not.toThrow();
          }
        )
      );
    });

    it("startSpan accepts arbitrary SpanOptions without throwing", () => {
      fc.assert(
        fc.property(
          arbitrarySpanName,
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            { minKeys: 0, maxKeys: 5 }
          ),
          (name, attributes) => {
            const tracer = new NoopTracer();
            const parentSpan = tracer.startSpan("parent");
            expect(() =>
              tracer.startSpan(name, { attributes, parent: parentSpan })
            ).not.toThrow();
          }
        )
      );
    });

    it("each startSpan call returns a distinct span object", () => {
      fc.assert(
        fc.property(
          arbitrarySpanName,
          arbitrarySpanName,
          (name1, name2) => {
            const tracer = new NoopTracer();
            const span1 = tracer.startSpan(name1);
            const span2 = tracer.startSpan(name2);
            expect(span1).not.toBe(span2);
          }
        )
      );
    });
  });
});

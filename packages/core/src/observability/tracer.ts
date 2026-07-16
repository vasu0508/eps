// No-op tracer implementation for @workflow/core observability

import type { Tracer, Span, SpanOptions } from "../types.js";

/**
 * A no-op Span that does nothing. Used as the default when no tracer is configured.
 */
class NoopSpan implements Span {
  end(): void {
    // no-op
  }

  setAttribute(_key: string, _value: string | number | boolean): void {
    // no-op
  }

  setStatus(_status: "ok" | "error", _message?: string): void {
    // no-op
  }
}

/**
 * A no-op Tracer that returns no-op Span objects.
 * This is the default tracer when no tracing is configured on the pipeline.
 */
export class NoopTracer implements Tracer {
  startSpan(_name: string, _options?: SpanOptions): Span {
    return new NoopSpan();
  }
}

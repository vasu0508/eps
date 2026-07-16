// In-memory metrics collector for @workflow/core observability

import type { MetricsCollector } from "../types.js";

/**
 * A metric entry recorded by InMemoryMetrics.
 */
export interface MetricEntry {
  readonly type: "increment" | "gauge" | "histogram" | "timing";
  readonly metric: string;
  readonly value: number;
  readonly tags?: Record<string, string>;
  readonly timestamp: number;
}

/**
 * An in-memory metrics collector that stores all metric calls for inspection.
 * Useful for testing that the correct metrics are emitted during pipeline execution.
 */
export class InMemoryMetrics implements MetricsCollector {
  private readonly entries: MetricEntry[] = [];

  increment(metric: string, tags?: Record<string, string>): void {
    this.entries.push({
      type: "increment",
      metric,
      value: 1,
      tags,
      timestamp: Date.now(),
    });
  }

  gauge(metric: string, value: number, tags?: Record<string, string>): void {
    this.entries.push({
      type: "gauge",
      metric,
      value,
      tags,
      timestamp: Date.now(),
    });
  }

  histogram(metric: string, value: number, tags?: Record<string, string>): void {
    this.entries.push({
      type: "histogram",
      metric,
      value,
      tags,
      timestamp: Date.now(),
    });
  }

  timing(metric: string, duration: number, tags?: Record<string, string>): void {
    this.entries.push({
      type: "timing",
      metric,
      value: duration,
      tags,
      timestamp: Date.now(),
    });
  }

  /**
   * Returns a snapshot of all collected metric entries.
   */
  snapshot(): readonly MetricEntry[] {
    return [...this.entries];
  }

  /**
   * Returns all collected metric entries (alias for snapshot).
   */
  getMetrics(): readonly MetricEntry[] {
    return this.snapshot();
  }

  /**
   * Resets all collected metrics.
   */
  reset(): void {
    this.entries.length = 0;
  }
}

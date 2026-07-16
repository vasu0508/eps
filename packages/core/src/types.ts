// Core shared types and interfaces for @workflow/core

/**
 * Logger interface for structured logging.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Metrics collector interface for pipeline observability.
 */
export interface MetricsCollector {
  increment(metric: string, tags?: Record<string, string>): void;
  gauge(metric: string, value: number, tags?: Record<string, string>): void;
  histogram(metric: string, value: number, tags?: Record<string, string>): void;
  timing(metric: string, duration: number, tags?: Record<string, string>): void;
}

/**
 * Span options for tracing.
 */
export interface SpanOptions {
  attributes?: Record<string, string | number | boolean>;
  parent?: Span;
}

/**
 * A trace span.
 */
export interface Span {
  end(): void;
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: "ok" | "error", message?: string): void;
}

/**
 * Tracer interface for distributed tracing.
 */
export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

/**
 * Execution context passed to step handlers.
 */
export interface ExecutionContext<TContext> {
  readonly pipelineId: string;
  readonly correlationId: string;
  readonly stepResults: ReadonlyMap<string, unknown>;
  readonly userContext: TContext;
  readonly abortSignal: AbortSignal;
  readonly logger: Logger;
  readonly metrics: MetricsCollector;
}

/**
 * Context-aware step handler that receives the full ExecutionContext.
 */
export type StepHandler<TContext, TResult> = (
  context: ExecutionContext<TContext>
) => Promise<TResult>;

/**
 * Pure step handler that receives mapped input instead of ExecutionContext.
 */
export type PureStepHandler<TInput, TResult> = (input: TInput) => Promise<TResult>;

/**
 * Result of a single step execution.
 */
export type StepResult<TResult> =
  | { status: "success"; value: TResult; duration: number; attempts: number }
  | { status: "fallback"; value: TResult; duration: number; fallbackIndex: number }
  | { status: "default"; value: TResult }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: Error; duration: number; attempts: number };

/**
 * Backoff strategy type for retry delay calculation.
 */
export type BackoffStrategy = "fixed" | "exponential" | "linear";

/**
 * Retry configuration options.
 */
export interface RetryOptions {
  backoff?: BackoffStrategy;
  baseDelay?: number;
  maxDelay?: number;
  retryOn?: (error: Error) => boolean;
}

/**
 * Retry policy interface used by the policy engine.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: BackoffStrategy;
  shouldRetry(error: Error, attempt: number): boolean;
  getDelay(attempt: number): number;
}

/**
 * Timeout policy that wraps step execution with a time limit.
 */
export interface TimeoutPolicy {
  readonly ms: number;
  wrap<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T>;
}

/**
 * Circuit breaker state.
 */
export type CircuitState = "closed" | "open" | "half-open";

/**
 * Circuit breaker configuration options.
 */
export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenMax?: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Circuit breaker interface.
 */
export interface CircuitBreaker {
  readonly state: CircuitState;
  execute<T>(fn: () => Promise<T>): Promise<T>;
  recordSuccess(): void;
  recordFailure(): void;
  reset(): void;
}

/**
 * Error transformer function type.
 */
export type ErrorTransformer = (error: Error) => Error;

/**
 * Policies attached to a step.
 */
export interface StepPolicies {
  retry?: RetryPolicy;
  fallbacks?: StepHandler<unknown, unknown>[];
  timeout?: TimeoutPolicy;
  circuitBreaker?: CircuitBreaker;
  defaultValue?: unknown;
  condition?: (context: unknown) => boolean;
  errorTransformer?: ErrorTransformer;
}

/**
 * Event emitted when a step completes.
 */
export interface StepCompleteEvent {
  stepName: string;
  duration: number;
  result: unknown;
}

/**
 * Event emitted when a step errors.
 */
export interface StepErrorEvent {
  stepName: string;
  duration: number;
  error: Error;
  attempt: number;
}

/**
 * Options for pipeline execution.
 */
export interface ExecutionOptions {
  correlationId?: string;
  timeout?: number;
  signal?: AbortSignal;
  maxConcurrency?: number;
  onStepComplete?: (event: StepCompleteEvent) => void;
  onStepError?: (event: StepErrorEvent) => void;
}

/**
 * Result of a pipeline execution.
 */
export interface PipelineResult<TContext> {
  readonly success: boolean;
  readonly executionId: string;
  readonly correlationId: string;
  readonly duration: number;
  readonly steps: ReadonlyMap<string, StepResult<unknown>>;
  readonly context: TContext;
  readonly report: ExecutionReport;

  getValue<T>(stepName: string): T | undefined;
  getError(stepName: string): Error | undefined;
  toJSON(): SerializedPipelineResult;
}

/**
 * Serialized pipeline result for JSON output.
 */
export interface SerializedPipelineResult {
  success: boolean;
  executionId: string;
  correlationId: string;
  duration: number;
  steps: Record<string, StepResult<unknown>>;
  report: SerializedExecutionReport;
}

/**
 * Serialized execution report for JSON output.
 */
export interface SerializedExecutionReport {
  executionId: string;
  correlationId: string;
  startTime: string;
  endTime: string;
  duration: number;
  status: "success" | "partial" | "failed";
  steps: StepReport[];
  graph: SerializedGraph;
}

/**
 * Serialized graph as adjacency structure.
 */
export interface SerializedGraph {
  [stepName: string]: string[];
}

/**
 * Serialized error representation.
 */
export interface SerializedError {
  name: string;
  message: string;
}

/**
 * Execution report for a pipeline run.
 */
export interface ExecutionReport {
  readonly executionId: string;
  readonly correlationId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly status: "success" | "partial" | "failed";
  readonly steps: StepReport[];
  readonly graph: SerializedGraph;

  toJSON(): SerializedExecutionReport;
}

/**
 * Report for a single step execution.
 */
export interface StepReport {
  readonly name: string;
  readonly status: "success" | "failed" | "skipped" | "fallback" | "default";
  readonly duration: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly attempts: number;
  readonly retryHistory: RetryAttempt[];
  readonly fallbackHistory: FallbackAttempt[];
  readonly error?: SerializedError;
  readonly circuitBreakerState?: CircuitState;
  readonly branchSelected?: unknown;
  readonly forEachReport?: ForEachReport;
  readonly repeatReport?: RepeatReport;
  readonly subPipelineReport?: ExecutionReport;
  readonly errorTransformations?: ErrorTransformation[];
}

/**
 * Record of a retry attempt.
 */
export interface RetryAttempt {
  readonly attempt: number;
  readonly duration: number;
  readonly error: SerializedError;
  readonly delay: number;
}

/**
 * Record of a fallback attempt.
 */
export interface FallbackAttempt {
  readonly index: number;
  readonly duration: number;
  readonly success: boolean;
  readonly error?: SerializedError;
}

/**
 * Report for forEach step execution.
 */
export interface ForEachReport {
  readonly totalElements: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly elementResults: ForEachElementReport[];
}

/**
 * Report for a single forEach element.
 */
export interface ForEachElementReport {
  readonly index: number;
  readonly status: "success" | "failed";
  readonly duration: number;
  readonly error?: SerializedError;
}

/**
 * Report for repeat/poll step execution.
 */
export interface RepeatReport {
  readonly iterations: RepeatIteration[];
  readonly finalIteration: number;
  readonly predicateSatisfied: boolean;
}

/**
 * Record of a single repeat iteration.
 */
export interface RepeatIteration {
  readonly iteration: number;
  readonly duration: number;
  readonly result: unknown;
  readonly predicateResult: boolean;
}

/**
 * Record of an error transformation.
 */
export interface ErrorTransformation {
  readonly originalError: SerializedError;
  readonly transformedError: SerializedError;
}

// @workflow/core - Zero-dependency TypeScript pipeline orchestration library

// Core types
export type {
  Logger,
  MetricsCollector,
  SpanOptions,
  Span,
  Tracer,
  ExecutionContext,
  StepHandler,
  PureStepHandler,
  StepResult,
  BackoffStrategy,
  RetryOptions,
  RetryPolicy,
  TimeoutPolicy,
  CircuitState,
  CircuitBreakerOptions,
  CircuitBreaker,
  ErrorTransformer,
  StepPolicies,
  StepCompleteEvent,
  StepErrorEvent,
  ExecutionOptions,
  PipelineResult,
  SerializedPipelineResult,
  SerializedExecutionReport,
  SerializedGraph,
  SerializedError,
  ExecutionReport,
  StepReport,
  RetryAttempt,
  FallbackAttempt,
  ForEachReport,
  ForEachElementReport,
  RepeatReport,
  RepeatIteration,
  ErrorTransformation,
} from "./types.js";

// Graph types
export type {
  ExecutionGraph,
  StepNode,
  ExecutionLayer,
  DependencyEdge,
  ValidationResult,
  SerializedGraphStructure,
} from "./types/graph.js";

// Branch types
export type {
  BranchDefinition,
  BranchHandler,
} from "./types/branch.js";

// ForEach types
export type {
  ForEachConfig,
  ForEachResult,
  ForEachElementError,
} from "./types/foreach.js";

// Repeat types
export type {
  RepeatConfig,
} from "./types/repeat.js";
// Note: RepeatReport and RepeatIteration are already exported from core types

// Input wiring types
export type {
  InputMapper,
  StepResultMap,
  InputWiringConfig,
} from "./types/input-wiring.js";

// Error transform types
export type {
  ErrorTransformConfig,
} from "./types/error-transform.js";
// Note: ErrorTransformer type is already exported from core types

// Execution graph
export { buildExecutionGraph } from "./graph/execution-graph.js";

// Input wiring
export { resolveInputWiring } from "./execution/input-wiring.js";

// Step executor
export { executeStep } from "./execution/step-executor.js";
export type { StepExecutionMetadata } from "./execution/step-executor.js";

// ForEach executor
export { executeForEach } from "./execution/foreach-executor.js";
export type { ForEachExecutionResult } from "./execution/foreach-executor.js";

// Repeat executor
export { executeRepeatUntil } from "./execution/repeat-executor.js";
export type { RepeatExecutionResult } from "./execution/repeat-executor.js";

// Branch evaluator
export { evaluateBranch } from "./execution/branch-evaluator.js";
export type { BranchEvaluationResult } from "./execution/branch-evaluator.js";

// Circuit breaker policy
export {
  createCircuitBreaker,
  clearCircuitBreakerRegistry,
  removeCircuitBreakerState,
} from "./policies/circuit-breaker.js";

// Retry policy
export { createRetryPolicy } from "./policies/retry-policy.js";

// Policy implementations
export { createTimeoutPolicy } from "./policies/timeout-policy.js";
export type { CreateTimeoutPolicyOptions } from "./policies/timeout-policy.js";

// Error transformer policy
export {
  applyErrorTransformation,
  applyErrorTransformationChain,
} from "./policies/error-transformer.js";

// Step scheduler
export { runScheduler } from "./execution/step-scheduler.js";
export type {
  SchedulerEvent,
  SchedulerOptions,
  SchedulerResult,
} from "./execution/step-scheduler.js";

// Sub-pipeline executor
export { isSubPipeline, executeSubPipeline } from "./execution/sub-pipeline-executor.js";
export type {
  ExecutablePipeline,
  SubPipelineResult,
  SubPipelineExecutionOptions,
} from "./execution/sub-pipeline-executor.js";

// Pipeline builder
export { createPipeline, PipelineBuilder } from "./builder/pipeline-builder.js";
export { StepConfigurator } from "./builder/step-configurator.js";
export type { StepDefinition, PipelineBuilderDelegate } from "./builder/step-configurator.js";
export { BranchConfigurator } from "./builder/branch-configurator.js";
export { ForEachConfigurator } from "./builder/foreach-configurator.js";
export { RepeatConfigurator } from "./builder/repeat-configurator.js";

// Observability
export { ConsoleLogger } from "./observability/logger.js";
export { InMemoryMetrics } from "./observability/metrics.js";
export type { MetricEntry } from "./observability/metrics.js";
export { NoopTracer } from "./observability/tracer.js";

// Error classes
export {
  CircularDependencyError,
  InvalidDependencyError,
  ValidationError,
  EmptyPipelineError,
  InvalidStepError,
  CancellationError,
  TimeoutError,
  CircuitOpenError,
  InputWiringError,
  BranchNotMatchedError,
  BranchDiscriminatorError,
  ForEachPartialError,
  ForEachMapperError,
  MaxIterationsExhaustedError,
  PredicateError,
  ErrorTransformResultError,
  RetryableError,
  PermanentError,
} from "./errors.js";

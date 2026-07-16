// Pipeline builder with fluent API for @workflow/core

import type {
  StepHandler,
  ExecutionOptions,
  ExecutionContext,
  PipelineResult,
  StepResult,
  Logger,
  MetricsCollector,
  Tracer,
  ExecutionReport,
  StepReport,
  SerializedPipelineResult,
  SerializedExecutionReport,
  SerializedGraph,
} from "../types.js";
import type { StepNode } from "../types/graph.js";
import { buildExecutionGraph } from "../graph/execution-graph.js";
import { runScheduler } from "../execution/step-scheduler.js";
import { createRetryPolicy } from "../policies/retry-policy.js";
import { createTimeoutPolicy } from "../policies/timeout-policy.js";
import { createCircuitBreaker } from "../policies/circuit-breaker.js";
import { applyErrorTransformationChain } from "../policies/error-transformer.js";
import {
  EmptyPipelineError,
  ValidationError,
  InvalidStepError,
} from "../errors.js";
import {
  StepConfigurator,
  createStepDefinition,
  type StepDefinition,
  type PipelineBuilderDelegate,
} from "./step-configurator.js";
import { ForEachConfigurator } from "./foreach-configurator.js";
import { RepeatConfigurator } from "./repeat-configurator.js";
import { BranchConfigurator } from "./branch-configurator.js";

/**
 * Factory function to create a new pipeline builder.
 *
 * @param name - Optional pipeline name for observability/debugging.
 * @returns A PipelineBuilder instance with fluent API.
 */
export function createPipeline<TContext = Record<string, unknown>>(
  name?: string
): PipelineBuilder<TContext> {
  return new PipelineBuilder<TContext>(name ?? "pipeline");
}

/**
 * PipelineBuilder accumulates step definitions and orchestrates execution.
 *
 * Usage:
 *   const result = await createPipeline<MyContext>("orderFlow")
 *     .withContext({ customerId: "123" })
 *     .step("FetchCustomer", handler)
 *       .required()
 *       .retry(2)
 *     .step("Billing", billingHandler)
 *       .dependsOn("FetchCustomer")
 *     .execute();
 */
export class PipelineBuilder<TContext> implements PipelineBuilderDelegate<TContext> {
  readonly pipelineName: string;
  private stepDefinitions: StepDefinition[] = [];
  private userContext: TContext | undefined;
  private logger: Logger | undefined;
  private metricsCollector: MetricsCollector | undefined;
  private tracerInstance: Tracer | undefined;

  constructor(name: string) {
    this.pipelineName = name;
  }

  /**
   * Set the user context to inject into all step handlers during execution.
   */
  withContext(context: TContext): this {
    this.userContext = context;
    return this;
  }

  /**
   * Set a structured logger for observability.
   */
  withLogger(logger: Logger): this {
    this.logger = logger;
    return this;
  }

  /**
   * Set a metrics collector for step duration/retry/failure metrics.
   */
  withMetrics(collector: MetricsCollector): this {
    this.metricsCollector = collector;
    return this;
  }

  /**
   * Set a tracer for distributed tracing spans.
   */
  withTracer(tracer: Tracer): this {
    this.tracerInstance = tracer;
    return this;
  }

  /**
   * Get the configured tracer (for observability layer use).
   */
  getTracer(): Tracer | undefined {
    return this.tracerInstance;
  }

  /**
   * Declare a new step in the pipeline.
   *
   * @param name - Unique step name (1-128 chars).
   * @param handler - Async handler function for the step.
   * @returns A StepConfigurator for chaining policy configuration.
   */
  step(name: string, handler: StepHandler<TContext, unknown>): StepConfigurator<TContext> {
    return this.addStep(name, handler);
  }

  /**
   * Declare a forEach (fan-out) step that executes the handler once per element
   * in a collection extracted by the mapper configured via `.from()`.
   *
   * @param name - Unique step name (1-128 chars).
   * @param handler - Async handler invoked once per element.
   * @returns A ForEachConfigurator for configuring the collection mapper, concurrency, etc.
   */
  forEach(name: string, handler: StepHandler<TContext, unknown>): ForEachConfigurator<TContext> {
    const configurator = this.addStep(name, handler);
    const definition = configurator.getDefinition();
    return new ForEachConfigurator<TContext>(definition, this);
  }

  /**
   * Declare a repeatUntil (polling) step that calls the handler repeatedly
   * until a predicate is satisfied or maxIterations is reached.
   *
   * @param name - Unique step name (1-128 chars).
   * @param handler - Async handler invoked on each iteration.
   * @returns A RepeatConfigurator for configuring the termination predicate, max iterations, delay, etc.
   */
  repeatUntil(name: string, handler: StepHandler<TContext, unknown>): RepeatConfigurator<TContext> {
    const configurator = this.addStep(name, handler);
    const definition = configurator.getDefinition();
    return new RepeatConfigurator<TContext>(definition, this);
  }

  /**
   * Declare a branch step with a discriminator function.
   * Returns a BranchConfigurator for registering .when() and .otherwise() handlers.
   *
   * @param name - Unique step name for the branch (1-128 chars).
   * @param discriminator - Function that returns the value to match against .when() clauses.
   * @returns A BranchConfigurator for chaining branch configuration.
   */
  branch(name: string, discriminator: (ctx: ExecutionContext<TContext>) => unknown): BranchConfigurator<TContext> {
    // Validate step name
    if (!name || name.length === 0) {
      throw new ValidationError([{ message: "Step name must be a non-empty string" }]);
    }
    if (name.length > 128) {
      throw new ValidationError([{ message: `Step name must be at most 128 characters, got ${name.length}` }]);
    }

    // Validate discriminator is a function
    if (typeof discriminator !== "function") {
      throw new ValidationError([{ message: `Branch "${name}" discriminator must be a function` }]);
    }

    // Check for duplicate step name
    if (this.stepDefinitions.some((s) => s.name === name)) {
      throw new ValidationError([{ message: `Duplicate step name "${name}"` }]);
    }

    // Create a placeholder handler - the branch evaluator will use the branchDefinition instead
    const placeholderHandler = (() => Promise.resolve(undefined)) as StepHandler<unknown, unknown>;
    const definition = createStepDefinition(name, placeholderHandler);
    this.stepDefinitions.push(definition);

    return new BranchConfigurator<TContext>(name, discriminator, this, definition);
  }

  /**
   * Internal method to add a step (implements PipelineBuilderDelegate).
   */
  addStep(name: string, handler: StepHandler<TContext, unknown>): StepConfigurator<TContext> {
    // Validate step name
    if (!name || name.length === 0) {
      throw new ValidationError([{ message: "Step name must be a non-empty string" }]);
    }
    if (name.length > 128) {
      throw new ValidationError([{ message: `Step name must be at most 128 characters, got ${name.length}` }]);
    }

    // Validate handler is a function
    if (typeof handler !== "function") {
      throw new ValidationError([{ message: `Step "${name}" handler must be a function` }]);
    }

    // Check for duplicate step name
    if (this.stepDefinitions.some((s) => s.name === name)) {
      throw new ValidationError([{ message: `Duplicate step name "${name}"` }]);
    }

    const definition = createStepDefinition(name, handler as StepHandler<unknown, unknown>);
    this.stepDefinitions.push(definition);

    return new StepConfigurator<TContext>(definition, this);
  }

  /**
   * Validate the pipeline configuration without executing.
   * Throws on invalid configuration (empty pipeline, cycles, invalid deps).
   */
  validate(): void {
    if (this.stepDefinitions.length === 0) {
      throw new EmptyPipelineError();
    }

    const nodes = this.buildStepNodes();
    // buildExecutionGraph validates deps and cycles, throws on error
    buildExecutionGraph(nodes);
  }

  /**
   * Validate, build the execution graph, and run the pipeline.
   *
   * @param options - Execution options (correlationId, timeout, signal, maxConcurrency).
   * @returns PipelineResult containing step results, report, and accessor methods.
   */
  async execute(options?: ExecutionOptions): Promise<PipelineResult<TContext>> {
    // Validate pipeline is non-empty
    if (this.stepDefinitions.length === 0) {
      throw new EmptyPipelineError();
    }

    // Validate maxConcurrency
    if (options?.maxConcurrency !== undefined) {
      if (
        !Number.isInteger(options.maxConcurrency) ||
        options.maxConcurrency < 1
      ) {
        throw new ValidationError([
          { message: `maxConcurrency must be an integer >= 1, got ${options.maxConcurrency}` },
        ]);
      }
    }

    // Check if signal is already aborted
    if (options?.signal?.aborted) {
      const executionId = crypto.randomUUID();
      const correlationId = options?.correlationId ?? crypto.randomUUID();
      const startTime = Date.now();

      // Build empty results for all steps as skipped
      const stepResultsMap = new Map<string, StepResult<unknown>>();
      for (const def of this.stepDefinitions) {
        stepResultsMap.set(def.name, { status: "skipped", reason: "pipeline aborted" });
      }

      return this.buildPipelineResult(
        executionId,
        correlationId,
        startTime,
        Date.now(),
        false,
        stepResultsMap
      );
    }

    // Build step nodes from definitions
    const nodes = this.buildStepNodes();

    // Build execution graph (validates deps, cycles)
    const graph = buildExecutionGraph(nodes);

    // Generate IDs
    const executionId = crypto.randomUUID();
    const correlationId = options?.correlationId ?? crypto.randomUUID();
    const startTime = Date.now();

    // Set up pipeline-level abort handling
    // Combine external signal and pipeline-level timeout into a single internal controller
    const pipelineAbortController = new AbortController();
    let pipelineTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

    // If options.signal is provided, pipe it into pipelineAbortController
    if (options?.signal) {
      options.signal.addEventListener("abort", () => {
        pipelineAbortController.abort(options.signal!.reason ?? "Pipeline aborted");
      }, { once: true });
    }

    // If pipeline-level timeout is configured, schedule abort
    if (options?.timeout !== undefined && options.timeout > 0) {
      pipelineTimeoutTimer = setTimeout(() => {
        pipelineAbortController.abort("Pipeline timeout exceeded");
      }, options.timeout);
    }

    // Build execution context
    const executionContext: ExecutionContext<unknown> = {
      pipelineId: executionId,
      correlationId,
      stepResults: new Map(),
      userContext: this.userContext ?? ({} as unknown),
      abortSignal: pipelineAbortController.signal,
      logger: this.logger ?? createNoopLogger(),
      metrics: this.metricsCollector ?? createNoopMetrics(),
    };

    // Run the scheduler
    const schedulerResult = await runScheduler({
      graph,
      context: executionContext,
      maxConcurrency: options?.maxConcurrency,
      signal: pipelineAbortController.signal,
    });

    // Clean up pipeline-level timeout timer
    if (pipelineTimeoutTimer !== undefined) {
      clearTimeout(pipelineTimeoutTimer);
    }

    const endTime = Date.now();

    return this.buildPipelineResult(
      executionId,
      correlationId,
      startTime,
      endTime,
      schedulerResult.success,
      schedulerResult.stepResults
    );
  }

  /**
   * Converts step definitions into StepNode[] for the execution graph.
   */
  private buildStepNodes(): StepNode[] {
    return this.stepDefinitions.map((def) => {
      // Build retry policy if configured
      let retryPolicy = undefined;
      if (def.retryCount !== undefined && def.retryCount > 0) {
        retryPolicy = createRetryPolicy(def.retryCount, def.retryOptions);
      }

      // Build timeout policy if configured
      let timeoutPolicy = undefined;
      if (def.timeoutMs !== undefined) {
        timeoutPolicy = createTimeoutPolicy({ ms: def.timeoutMs, stepName: def.name });
      }

      // Build circuit breaker if configured
      let circuitBreaker = undefined;
      if (def.circuitBreakerServiceName && def.circuitBreakerOptions) {
        circuitBreaker = createCircuitBreaker(
          def.circuitBreakerServiceName,
          def.circuitBreakerOptions
        );
      }

      // Build chained error transformer
      let errorTransformer = undefined;
      if (def.errorTransformers.length > 0) {
        if (def.errorTransformers.length === 1) {
          errorTransformer = def.errorTransformers[0];
        } else {
          // Chain multiple transforms: output of first is input to second
          const transformers = [...def.errorTransformers];
          errorTransformer = (error: Error): Error => {
            let current = error;
            for (const fn of transformers) {
              current = applyErrorTransformationChain(current, [fn]);
            }
            return current;
          };
        }
      }

      const node: StepNode = {
        name: def.name,
        handler: def.handler,
        dependencies: [...def.dependencies],
        isRequired: !def.isOptional,
        policies: {
          retry: retryPolicy,
          fallbacks: def.fallbacks.length > 0 ? def.fallbacks : undefined,
          timeout: timeoutPolicy,
          circuitBreaker,
          defaultValue: def.hasDefaultValue ? def.defaultValue : undefined,
          condition: def.condition,
          errorTransformer,
        },
        inputMapper: def.inputMapper,
        forEachConfig: def.forEachMapper
          ? {
              mapper: def.forEachMapper as (context: ExecutionContext<unknown>) => unknown[],
              maxConcurrency: def.forEachMaxConcurrency ?? Infinity,
            }
          : undefined,
        repeatConfig: def.repeatPredicate
          ? {
              predicate: def.repeatPredicate as (result: unknown) => boolean,
              maxIterations: def.repeatMaxIterations ?? 1,
              delay: def.repeatDelay ?? 0,
            }
          : undefined,
        branchDefinition: def.branchDefinition,
        errorTransformer,
      };

      return node;
    });
  }

  /**
   * Builds the final PipelineResult from scheduler output.
   */
  private buildPipelineResult(
    executionId: string,
    correlationId: string,
    startTime: number,
    endTime: number,
    success: boolean,
    stepResults: Map<string, StepResult<unknown>>
  ): PipelineResult<TContext> {
    const duration = endTime - startTime;
    const stepNames = new Set(this.stepDefinitions.map((d) => d.name));

    // Build execution report
    const stepReports: StepReport[] = [];
    for (const def of this.stepDefinitions) {
      const result = stepResults.get(def.name);
      if (result) {
        stepReports.push(buildStepReport(def.name, result, startTime));
      }
    }

    // Build serialized graph
    const serializedGraph: SerializedGraph = {};
    for (const def of this.stepDefinitions) {
      serializedGraph[def.name] = [...def.dependencies];
    }

    // Determine report status
    let reportStatus: "success" | "partial" | "failed" = "success";
    if (!success) {
      // Check if any steps succeeded
      const anySuccess = [...stepResults.values()].some(
        (r) => r.status === "success" || r.status === "fallback" || r.status === "default"
      );
      reportStatus = anySuccess ? "partial" : "failed";
    }

    const report: ExecutionReport = {
      executionId,
      correlationId,
      startTime,
      endTime,
      duration,
      status: reportStatus,
      steps: stepReports,
      graph: serializedGraph,
      toJSON(): SerializedExecutionReport {
        return {
          executionId,
          correlationId,
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          duration,
          status: reportStatus,
          steps: stepReports,
          graph: serializedGraph,
        };
      },
    };

    const result: PipelineResult<TContext> = {
      success,
      executionId,
      correlationId,
      duration,
      steps: stepResults,
      context: (this.userContext ?? {}) as TContext,
      report,

      getValue<T>(stepName: string): T | undefined {
        if (!stepNames.has(stepName)) {
          throw new InvalidStepError(stepName);
        }
        const stepResult = stepResults.get(stepName);
        if (!stepResult) return undefined;
        if (
          stepResult.status === "success" ||
          stepResult.status === "fallback" ||
          stepResult.status === "default"
        ) {
          return stepResult.value as T;
        }
        return undefined;
      },

      getError(stepName: string): Error | undefined {
        if (!stepNames.has(stepName)) {
          throw new InvalidStepError(stepName);
        }
        const stepResult = stepResults.get(stepName);
        if (!stepResult) return undefined;
        if (stepResult.status === "failed") {
          return stepResult.error;
        }
        return undefined;
      },

      toJSON(): SerializedPipelineResult {
        const stepsObj: Record<string, StepResult<unknown>> = {};
        for (const [name, r] of stepResults.entries()) {
          stepsObj[name] = r;
        }
        return {
          success,
          executionId,
          correlationId,
          duration,
          steps: stepsObj,
          report: report.toJSON(),
        };
      },
    };

    return result;
  }
}

/**
 * Builds a StepReport from a StepResult.
 */
function buildStepReport(
  name: string,
  result: StepResult<unknown>,
  _pipelineStartTime: number
): StepReport {
  const now = Date.now();

  switch (result.status) {
    case "success":
      return {
        name,
        status: "success",
        duration: result.duration,
        startTime: now - result.duration,
        endTime: now,
        attempts: result.attempts,
        retryHistory: [],
        fallbackHistory: [],
      };
    case "fallback":
      return {
        name,
        status: "fallback",
        duration: result.duration,
        startTime: now - result.duration,
        endTime: now,
        attempts: 0,
        retryHistory: [],
        fallbackHistory: [],
      };
    case "default":
      return {
        name,
        status: "default",
        duration: 0,
        startTime: now,
        endTime: now,
        attempts: 0,
        retryHistory: [],
        fallbackHistory: [],
      };
    case "skipped":
      return {
        name,
        status: "skipped",
        duration: 0,
        startTime: now,
        endTime: now,
        attempts: 0,
        retryHistory: [],
        fallbackHistory: [],
      };
    case "failed":
      return {
        name,
        status: "failed",
        duration: result.duration,
        startTime: now - result.duration,
        endTime: now,
        attempts: result.attempts,
        retryHistory: [],
        fallbackHistory: [],
        error: { name: result.error.name, message: result.error.message },
      };
  }
}

/**
 * Creates a no-op logger that discards all messages.
 */
function createNoopLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * Creates a no-op metrics collector.
 */
function createNoopMetrics(): MetricsCollector {
  const noop = () => {};
  return { increment: noop, gauge: noop, histogram: noop, timing: noop };
}

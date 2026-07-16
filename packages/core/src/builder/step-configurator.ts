// Step configurator with fluent API for configuring step policies

import type {
  StepHandler,
  RetryOptions,
  CircuitBreakerOptions,
  ErrorTransformer,
  ExecutionOptions,
  PipelineResult,
  ExecutionContext,
} from "../types.js";
import type { InputMapper } from "../types/input-wiring.js";
import type { BranchDefinition } from "../types/branch.js";
import { ValidationError } from "../errors.js";

/**
 * Internal representation of a step definition being built.
 */
export interface StepDefinition {
  name: string;
  handler: StepHandler<unknown, unknown>;
  dependencies: string[];
  isRequired: boolean;
  isOptional: boolean;
  retryCount?: number;
  retryOptions?: RetryOptions;
  fallbacks: StepHandler<unknown, unknown>[];
  timeoutMs?: number;
  circuitBreakerServiceName?: string;
  circuitBreakerOptions?: CircuitBreakerOptions;
  defaultValue?: unknown;
  hasDefaultValue: boolean;
  condition?: (context: unknown) => boolean;
  cancelSignal?: AbortSignal;
  inputMapper?: InputMapper<unknown>;
  forEachMapper?: (context: ExecutionContext<unknown>) => unknown[];
  forEachMaxConcurrency?: number;
  repeatPredicate?: (result: unknown) => boolean;
  repeatMaxIterations?: number;
  repeatDelay?: number;
  errorTransformers: ErrorTransformer[];
  branchDefinition?: BranchDefinition<unknown>;
}

/**
 * Creates a fresh StepDefinition with defaults.
 */
export function createStepDefinition(
  name: string,
  handler: StepHandler<unknown, unknown>
): StepDefinition {
  return {
    name,
    handler,
    dependencies: [],
    isRequired: true,
    isOptional: false,
    fallbacks: [],
    hasDefaultValue: false,
    errorTransformers: [],
  };
}

/**
 * Interface for PipelineBuilder methods that StepConfigurator delegates to.
 */
export interface PipelineBuilderDelegate<TContext> {
  addStep(name: string, handler: StepHandler<TContext, unknown>): StepConfigurator<TContext>;
  branch(name: string, discriminator: (ctx: ExecutionContext<TContext>) => unknown): unknown;
  execute(options?: ExecutionOptions): Promise<PipelineResult<TContext>>;
  validate(): void;
}

/**
 * StepConfigurator provides a fluent API for configuring an individual step's
 * policies. It flows back to the PipelineBuilder via .step(), .execute(), .validate().
 */
export class StepConfigurator<TContext> {
  private readonly definition: StepDefinition;
  private readonly builder: PipelineBuilderDelegate<TContext>;

  constructor(
    definition: StepDefinition,
    builder: PipelineBuilderDelegate<TContext>
  ) {
    this.definition = definition;
    this.builder = builder;
  }

  /**
   * Declare dependencies for this step.
   */
  dependsOn(...steps: string[]): this {
    this.definition.dependencies.push(...steps);
    return this;
  }

  /**
   * Configure retry policy for this step.
   * @param count - Number of retries (1-10). Total invocations = count + 1.
   */
  retry(count: number, options?: RetryOptions): this {
    if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
      throw new ValidationError(
        [{ message: `Retry count must be a finite non-negative integer, got ${count}` }]
      );
    }
    this.definition.retryCount = count;
    this.definition.retryOptions = options;
    return this;
  }

  /**
   * Configure timeout for this step.
   * @param ms - Timeout in milliseconds. Must be a finite positive number.
   */
  timeout(ms: number): this {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new ValidationError(
        [{ message: `Timeout must be a finite positive number, got ${ms}` }]
      );
    }
    this.definition.timeoutMs = ms;
    return this;
  }

  /**
   * Configure circuit breaker for this step.
   */
  circuitBreaker(serviceName: string, options: CircuitBreakerOptions): this {
    this.definition.circuitBreakerServiceName = serviceName;
    this.definition.circuitBreakerOptions = options;
    return this;
  }

  /**
   * Add a fallback handler (up to 5 allowed per step).
   */
  fallback(handler: StepHandler<TContext, unknown>): this {
    if (this.definition.fallbacks.length >= 5) {
      throw new ValidationError(
        [{ message: "Maximum of 5 fallback handlers per step exceeded" }]
      );
    }
    this.definition.fallbacks.push(handler as StepHandler<unknown, unknown>);
    return this;
  }

  /**
   * Set conditional execution predicate. Last call wins.
   */
  onlyIf(predicate: (context: TContext) => boolean): this {
    this.definition.condition = predicate as (context: unknown) => boolean;
    return this;
  }

  /**
   * Mark step as optional. Optionally provide a default value.
   */
  optional(defaultValue?: unknown): this {
    if (this.definition.isRequired && this.definition.isOptional) {
      throw new ValidationError(
        [{ message: `Step "${this.definition.name}" cannot be both required and optional` }]
      );
    }
    this.definition.isOptional = true;
    this.definition.isRequired = false;
    if (arguments.length > 0) {
      this.definition.defaultValue = defaultValue;
      this.definition.hasDefaultValue = true;
    }
    return this;
  }

  /**
   * Mark step as required (default). Throws if already marked optional.
   */
  required(): this {
    if (this.definition.isOptional) {
      throw new ValidationError(
        [{ message: `Step "${this.definition.name}" cannot be both required and optional` }]
      );
    }
    this.definition.isRequired = true;
    return this;
  }

  /**
   * Configure input wiring mapper for this step.
   */
  input<TInput>(mapper: (results: Record<string, unknown>) => TInput): this {
    this.definition.inputMapper = mapper as InputMapper<unknown>;
    return this;
  }

  /**
   * Configure error transformation. Multiple calls chain in declaration order.
   */
  mapError(transformer: ErrorTransformer): this {
    this.definition.errorTransformers.push(transformer);
    return this;
  }

  // --- Builder flow-through methods ---

  /**
   * Add a new step to the pipeline (flows back to builder).
   */
  step(name: string, handler: StepHandler<TContext, unknown>): StepConfigurator<TContext> {
    return this.builder.addStep(name, handler);
  }

  /**
   * Start a new branch step on the pipeline (flows back to builder).
   */
  branch(name: string, discriminator: (ctx: ExecutionContext<TContext>) => unknown): unknown {
    return this.builder.branch(name, discriminator);
  }

  /**
   * Validate and execute the pipeline.
   */
  execute(options?: ExecutionOptions): Promise<PipelineResult<TContext>> {
    return this.builder.execute(options);
  }

  /**
   * Validate the pipeline without executing.
   */
  validate(): void {
    return this.builder.validate();
  }

  /**
   * Get the internal step definition (used by PipelineBuilder).
   */
  getDefinition(): StepDefinition {
    return this.definition;
  }
}

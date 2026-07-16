// Repeat configurator with fluent API for configuring repeatUntil (polling) steps

import type {
  StepHandler,
  ExecutionOptions,
  PipelineResult,
} from "../types.js";
import { ValidationError } from "../errors.js";
import { StepConfigurator, type StepDefinition, type PipelineBuilderDelegate } from "./step-configurator.js";

/**
 * RepeatConfigurator provides a fluent API for configuring polling/repeat step execution.
 * It allows setting the termination predicate, max iterations, and delay between iterations.
 *
 * Usage:
 *   createPipeline<Ctx>()
 *     .step("Init", initHandler)
 *     .repeatUntil("Poll", pollHandler)
 *       .until(result => result.status === "done")
 *       .maxIterations(10)
 *       .delay(2000)
 *       .dependsOn("Init")
 *     .step("Finalize", finalizeHandler)
 *     .execute();
 */
export class RepeatConfigurator<TContext> {
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
   * Set the predicate that determines when to stop repeating.
   * The step repeats until this predicate returns true for the handler's result.
   */
  until(predicate: (result: unknown) => boolean): this {
    this.definition.repeatPredicate = predicate;
    return this;
  }

  /**
   * Set the maximum number of iterations (required for repeatUntil steps).
   * @param n - Maximum iterations (must be >= 1).
   */
  maxIterations(n: number): this {
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new ValidationError(
        [{ message: `maxIterations must be a finite integer >= 1, got ${n}` }]
      );
    }
    this.definition.repeatMaxIterations = n;
    return this;
  }

  /**
   * Set the delay in milliseconds between iterations.
   * The delay is NOT applied after the final iteration.
   * @param ms - Delay in milliseconds (must be >= 0).
   */
  delay(ms: number): this {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new ValidationError(
        [{ message: `Delay must be a finite non-negative number, got ${ms}` }]
      );
    }
    this.definition.repeatDelay = ms;
    return this;
  }

  /**
   * Declare dependencies for this repeat step.
   */
  dependsOn(...steps: string[]): this {
    this.definition.dependencies.push(...steps);
    return this;
  }

  /**
   * Set conditional execution predicate for this repeat step.
   */
  onlyIf(predicate: (context: TContext) => boolean): this {
    this.definition.condition = predicate as (context: unknown) => boolean;
    return this;
  }

  /**
   * Mark this repeat step as optional with an optional default value.
   */
  optional(defaultValue?: unknown): this {
    this.definition.isOptional = true;
    this.definition.isRequired = false;
    if (arguments.length > 0) {
      this.definition.defaultValue = defaultValue;
      this.definition.hasDefaultValue = true;
    }
    return this;
  }

  /**
   * Mark this repeat step as required (default behavior).
   */
  required(): this {
    this.definition.isRequired = true;
    this.definition.isOptional = false;
    return this;
  }

  /**
   * Configure timeout for this step (applies to each individual iteration).
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

  // --- Flow-through methods back to the PipelineBuilder ---

  /**
   * Add the next step to the pipeline.
   */
  step(name: string, handler: StepHandler<TContext, unknown>): StepConfigurator<TContext> {
    return this.builder.addStep(name, handler);
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
}

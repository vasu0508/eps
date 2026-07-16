// ForEach configurator with fluent API for configuring forEach (fan-out) steps

import type {
  StepHandler,
  ExecutionOptions,
  PipelineResult,
  ExecutionContext,
} from "../types.js";
import { StepConfigurator, type StepDefinition, type PipelineBuilderDelegate } from "./step-configurator.js";

/**
 * ForEachConfigurator provides a fluent API for configuring fan-out step execution.
 * It allows setting concurrency limits and other step policies, then chaining back
 * to the PipelineBuilder for further step declarations.
 *
 * Usage:
 *   createPipeline<Ctx>()
 *     .step("Fetch", handler)
 *     .forEach("Process", processHandler)
 *       .from(ctx => ctx.stepResults.get("Fetch") as Item[])
 *       .withConcurrency(3)
 *       .dependsOn("Fetch")
 *     .step("Finalize", finalizeHandler)
 *     .execute();
 */
export class ForEachConfigurator<TContext> {
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
   * Set the mapper that extracts the collection to iterate over.
   */
  from(mapper: (context: ExecutionContext<TContext>) => unknown[]): this {
    this.definition.forEachMapper = mapper as (context: ExecutionContext<unknown>) => unknown[];
    return this;
  }

  /**
   * Set the maximum number of concurrent element executions.
   * @param n - Maximum concurrency limit (must be >= 1).
   */
  withConcurrency(n: number): this {
    this.definition.forEachMaxConcurrency = n;
    return this;
  }

  /**
   * Declare dependencies for this forEach step.
   */
  dependsOn(...steps: string[]): this {
    this.definition.dependencies.push(...steps);
    return this;
  }

  /**
   * Set conditional execution predicate for this forEach step.
   */
  onlyIf(predicate: (context: TContext) => boolean): this {
    this.definition.condition = predicate as (context: unknown) => boolean;
    return this;
  }

  /**
   * Mark this forEach step as optional with an optional default value.
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
   * Mark this forEach step as required (default behavior).
   */
  required(): this {
    this.definition.isRequired = true;
    this.definition.isOptional = false;
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

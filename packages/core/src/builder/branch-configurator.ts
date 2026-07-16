// Branch configurator with fluent API for configuring branch steps

import type {
  StepHandler,
  ExecutionOptions,
  PipelineResult,
  ExecutionContext,
} from "../types.js";
import type { BranchHandler } from "../types/branch.js";
import { StepConfigurator, type StepDefinition, type PipelineBuilderDelegate } from "./step-configurator.js";

/**
 * BranchConfigurator provides a fluent API for configuring mutually exclusive
 * execution branches based on a discriminator value.
 *
 * Usage:
 *   createPipeline<Ctx>()
 *     .step("Validate", handler)
 *     .branch("Route", ctx => ctx.userContext.type)
 *       .when("a", handlerA)
 *       .when("b", handlerB)
 *       .otherwise(defaultHandler)
 *     .step("Next", nextHandler)
 *     .execute();
 */
export class BranchConfigurator<TContext> {
  private readonly branchName: string;
  private readonly discriminator: (ctx: ExecutionContext<TContext>) => unknown;
  private readonly branches: Map<unknown, BranchHandler> = new Map();
  private defaultBranch: BranchHandler | undefined;
  private readonly builder: PipelineBuilderDelegate<TContext>;
  private readonly definition: StepDefinition;

  constructor(
    name: string,
    discriminator: (ctx: ExecutionContext<TContext>) => unknown,
    builder: PipelineBuilderDelegate<TContext>,
    definition: StepDefinition
  ) {
    this.branchName = name;
    this.discriminator = discriminator;
    this.builder = builder;
    this.definition = definition;

    // Initialize the branch definition on the step definition
    this.syncBranchDefinition();
  }

  /**
   * Register a branch handler for a specific discriminator value.
   */
  when(value: unknown, handler: StepHandler<TContext, unknown>): this {
    this.branches.set(value, {
      handler: handler as StepHandler<unknown, unknown>,
    });
    this.syncBranchDefinition();
    return this;
  }

  /**
   * Register a default branch handler when no `.when()` value matches.
   */
  otherwise(handler: StepHandler<TContext, unknown>): this {
    this.defaultBranch = {
      handler: handler as StepHandler<unknown, unknown>,
    };
    this.syncBranchDefinition();
    return this;
  }

  /**
   * Declare dependencies for the branch step.
   */
  dependsOn(...steps: string[]): this {
    this.definition.dependencies.push(...steps);
    return this;
  }

  /**
   * Set conditional execution predicate for the branch step.
   */
  onlyIf(predicate: (context: TContext) => boolean): this {
    this.definition.condition = predicate as (context: unknown) => boolean;
    return this;
  }

  /**
   * Mark the branch step as optional with an optional default value.
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
   * Mark the branch step as required.
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
   * Start a new branch step on the pipeline.
   */
  branch(name: string, discriminator: (ctx: ExecutionContext<TContext>) => unknown): BranchConfigurator<TContext> {
    // We go through the builder to register the step properly with validation
    const placeholderHandler = (() => Promise.resolve(undefined)) as unknown as StepHandler<TContext, unknown>;
    const configurator = this.builder.addStep(name, placeholderHandler);
    const stepDef = configurator.getDefinition();

    return new BranchConfigurator<TContext>(name, discriminator, this.builder, stepDef);
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
   * Syncs the current branch state to the step definition's branchDefinition.
   */
  private syncBranchDefinition(): void {
    this.definition.branchDefinition = {
      name: this.branchName,
      discriminator: this.discriminator as (context: ExecutionContext<unknown>) => unknown,
      branches: new Map(this.branches),
      defaultBranch: this.defaultBranch,
    };
  }
}

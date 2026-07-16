// Error classes for @workflow/core

import type { ForEachElementError } from "./types/foreach.js";

/**
 * Thrown when a circular dependency is detected in the execution graph.
 */
export class CircularDependencyError extends Error {
  readonly steps: string[];

  constructor(steps: string[]) {
    super(`Circular dependency detected among steps: ${steps.join(" -> ")}`);
    this.name = "CircularDependencyError";
    this.steps = steps;
  }
}

/**
 * Thrown when a step references a dependency that does not exist.
 */
export class InvalidDependencyError extends Error {
  readonly stepName: string;
  readonly dependencyName: string;

  constructor(stepName: string, dependencyName: string) {
    super(
      `Step "${stepName}" depends on "${dependencyName}" which does not exist in the pipeline`
    );
    this.name = "InvalidDependencyError";
    this.stepName = stepName;
    this.dependencyName = dependencyName;
  }
}

/**
 * Thrown when pipeline configuration has validation errors.
 */
export class ValidationError extends Error {
  readonly errors: Array<{ message: string }>;

  constructor(errors: Array<{ message: string }>) {
    const messages = errors.map((e) => e.message).join("; ");
    super(`Validation failed: ${messages}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

/**
 * Thrown when a pipeline has no steps defined.
 */
export class EmptyPipelineError extends Error {
  constructor() {
    super("Pipeline must have at least one step defined");
    this.name = "EmptyPipelineError";
  }
}

/**
 * Thrown when referencing a step name that doesn't exist.
 */
export class InvalidStepError extends Error {
  readonly stepName: string;

  constructor(stepName: string) {
    super(`Step "${stepName}" does not exist in the pipeline`);
    this.name = "InvalidStepError";
    this.stepName = stepName;
  }
}

/**
 * Thrown when a pipeline or step is cancelled via AbortSignal.
 */
export class CancellationError extends Error {
  constructor(message?: string) {
    super(message ?? "Operation was cancelled");
    this.name = "CancellationError";
  }
}

/**
 * Thrown when a step exceeds its configured timeout.
 */
export class TimeoutError extends Error {
  readonly ms: number;
  readonly stepName?: string;

  constructor(ms: number, stepName?: string) {
    const stepPart = stepName ? ` for step "${stepName}"` : "";
    super(`Timeout of ${ms}ms exceeded${stepPart}`);
    this.name = "TimeoutError";
    this.ms = ms;
    this.stepName = stepName;
  }
}

/**
 * Thrown when a circuit breaker is open and rejects execution.
 */
export class CircuitOpenError extends Error {
  readonly serviceName: string;
  readonly remainingMs: number;

  constructor(serviceName: string, remainingMs: number) {
    super(
      `Circuit breaker is open for "${serviceName}". Retry in ${remainingMs}ms`
    );
    this.name = "CircuitOpenError";
    this.serviceName = serviceName;
    this.remainingMs = remainingMs;
  }
}

/**
 * Thrown when input wiring fails (e.g., mapper references undefined step result).
 */
export class InputWiringError extends Error {
  readonly stepName: string;
  readonly referencedStep: string | null;

  constructor(
    stepName: string,
    referencedStep: string | null,
    message?: string
  ) {
    const detail = referencedStep
      ? `referenced step "${referencedStep}" has no result`
      : message ?? "input mapper failed";
    super(`Input wiring failed for step "${stepName}": ${detail}`);
    this.name = "InputWiringError";
    this.stepName = stepName;
    this.referencedStep = referencedStep;
  }
}

/**
 * Thrown when a branch discriminator returns a value that matches no handler
 * and no otherwise handler is defined.
 */
export class BranchNotMatchedError extends Error {
  readonly branchName: string;
  readonly discriminatorValue: unknown;

  constructor(branchName: string, discriminatorValue: unknown) {
    super(
      `Branch "${branchName}" has no handler for discriminator value: ${String(discriminatorValue)}`
    );
    this.name = "BranchNotMatchedError";
    this.branchName = branchName;
    this.discriminatorValue = discriminatorValue;
  }
}

/**
 * Thrown when the branch discriminator function throws during evaluation.
 */
export class BranchDiscriminatorError extends Error {
  readonly branchName: string;
  readonly originalError: Error;

  constructor(branchName: string, originalError: Error) {
    super(
      `Branch "${branchName}" discriminator threw an error: ${originalError.message}`
    );
    this.name = "BranchDiscriminatorError";
    this.branchName = branchName;
    this.originalError = originalError;
  }
}

/**
 * Thrown when a forEach step has partial failures.
 */
export class ForEachPartialError extends Error {
  readonly errors: ForEachElementError[];
  readonly results: unknown[];

  constructor(errors: ForEachElementError[], results: unknown[]) {
    super(
      `ForEach step had ${errors.length} element failure(s) out of ${results.length} total`
    );
    this.name = "ForEachPartialError";
    this.errors = errors;
    this.results = results;
  }
}

/**
 * Thrown when the forEach mapper fails or returns a non-array.
 */
export class ForEachMapperError extends Error {
  readonly originalError: Error | string;

  constructor(originalError: Error | string) {
    const message =
      originalError instanceof Error
        ? originalError.message
        : originalError;
    super(`ForEach mapper failed: ${message}`);
    this.name = "ForEachMapperError";
    this.originalError = originalError;
  }
}

/**
 * Thrown when repeatUntil exhausts all iterations without the predicate returning true.
 */
export class MaxIterationsExhaustedError extends Error {
  readonly maxIterations: number;
  readonly lastResult: unknown;

  constructor(maxIterations: number, lastResult?: unknown) {
    super(
      `Maximum iterations (${maxIterations}) exhausted without predicate satisfaction`
    );
    this.name = "MaxIterationsExhaustedError";
    this.maxIterations = maxIterations;
    this.lastResult = lastResult;
  }
}

/**
 * Thrown when the repeatUntil predicate function throws.
 */
export class PredicateError extends Error {
  readonly originalError: Error;

  constructor(originalError: Error) {
    super(`Predicate evaluation failed: ${originalError.message}`);
    this.name = "PredicateError";
    this.originalError = originalError;
  }
}

/**
 * Thrown when an error transformer returns a non-Error value.
 */
export class ErrorTransformResultError extends Error {
  constructor(message?: string) {
    super(message ?? "mapError must return an Error instance");
    this.name = "ErrorTransformResultError";
  }
}

/**
 * A retryable error wrapping an original error. Signals the retry policy to retry.
 */
export class RetryableError extends Error {
  readonly retryable = true as const;
  readonly originalError: Error;

  constructor(original: Error, message?: string) {
    super(message ?? original.message);
    this.name = "RetryableError";
    this.originalError = original;
  }
}

/**
 * A permanent error wrapping an original error. Signals the retry policy to not retry.
 */
export class PermanentError extends Error {
  readonly permanent = true as const;
  readonly originalError: Error;

  constructor(original: Error, message?: string) {
    super(message ?? original.message);
    this.name = "PermanentError";
    this.originalError = original;
  }
}

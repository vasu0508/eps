import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
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
} from "../src/errors.js";

/**
 * Property 17: Configuration Validation Eagerness (partial)
 * Validates: Requirements 13.1, 13.4, 13.5, 13.6
 *
 * Verify all error classes extend Error, have correct `name` property, and serialize properly.
 */
describe("Error classes - Property 17: Configuration Validation Eagerness (partial)", () => {
  // All error class constructors with their arbitrary generators
  const errorFactories = [
    {
      name: "CircularDependencyError",
      arb: fc.array(fc.string({ minLength: 1 }), { minLength: 1 }),
      create: (steps: string[]) => new CircularDependencyError(steps),
    },
    {
      name: "InvalidDependencyError",
      arb: fc.tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 })),
      create: ([stepName, depName]: [string, string]) =>
        new InvalidDependencyError(stepName, depName),
    },
    {
      name: "ValidationError",
      arb: fc.array(fc.record({ message: fc.string() }), { minLength: 1 }),
      create: (errors: Array<{ message: string }>) =>
        new ValidationError(errors),
    },
    {
      name: "EmptyPipelineError",
      arb: fc.constant(undefined),
      create: () => new EmptyPipelineError(),
    },
    {
      name: "InvalidStepError",
      arb: fc.string({ minLength: 1 }),
      create: (stepName: string) => new InvalidStepError(stepName),
    },
    {
      name: "CancellationError",
      arb: fc.option(fc.string()),
      create: (message: string | null) =>
        new CancellationError(message ?? undefined),
    },
    {
      name: "TimeoutError",
      arb: fc.tuple(
        fc.nat({ max: 600000 }),
        fc.option(fc.string({ minLength: 1 }))
      ),
      create: ([ms, stepName]: [number, string | null]) =>
        new TimeoutError(ms, stepName ?? undefined),
    },
    {
      name: "CircuitOpenError",
      arb: fc.tuple(fc.string({ minLength: 1 }), fc.nat({ max: 600000 })),
      create: ([serviceName, remainingMs]: [string, number]) =>
        new CircuitOpenError(serviceName, remainingMs),
    },
    {
      name: "InputWiringError",
      arb: fc.tuple(
        fc.string({ minLength: 1 }),
        fc.option(fc.string({ minLength: 1 })),
        fc.option(fc.string())
      ),
      create: ([stepName, refStep, message]: [
        string,
        string | null,
        string | null,
      ]) => new InputWiringError(stepName, refStep, message ?? undefined),
    },
    {
      name: "BranchNotMatchedError",
      arb: fc.tuple(fc.string({ minLength: 1 }), fc.string()),
      create: ([branchName, discValue]: [string, string]) =>
        new BranchNotMatchedError(branchName, discValue),
    },
    {
      name: "BranchDiscriminatorError",
      arb: fc.tuple(fc.string({ minLength: 1 }), fc.string()),
      create: ([branchName, errorMsg]: [string, string]) =>
        new BranchDiscriminatorError(branchName, new Error(errorMsg)),
    },
    {
      name: "ForEachPartialError",
      arb: fc.tuple(
        fc.array(
          fc.record({
            index: fc.nat(),
            element: fc.string(),
            error: fc.string().map((msg) => new Error(msg)),
          }),
          { minLength: 1 }
        ),
        fc.array(fc.string())
      ),
      create: ([errors, results]: [
        Array<{ index: number; element: unknown; error: Error }>,
        unknown[],
      ]) => new ForEachPartialError(errors, results),
    },
    {
      name: "ForEachMapperError",
      arb: fc.oneof(
        fc.string().map((msg) => new Error(msg) as Error | string),
        fc.string().map((s) => s as Error | string)
      ),
      create: (original: Error | string) => new ForEachMapperError(original),
    },
    {
      name: "MaxIterationsExhaustedError",
      arb: fc.tuple(fc.integer({ min: 1, max: 10000 }), fc.option(fc.string())),
      create: ([maxIter, lastResult]: [number, string | null]) =>
        new MaxIterationsExhaustedError(maxIter, lastResult ?? undefined),
    },
    {
      name: "PredicateError",
      arb: fc.string(),
      create: (msg: string) => new PredicateError(new Error(msg)),
    },
    {
      name: "ErrorTransformResultError",
      arb: fc.option(fc.string()),
      create: (message: string | null) =>
        new ErrorTransformResultError(message ?? undefined),
    },
    {
      name: "RetryableError",
      arb: fc.tuple(fc.string(), fc.option(fc.string())),
      create: ([errMsg, message]: [string, string | null]) =>
        new RetryableError(new Error(errMsg), message ?? undefined),
    },
    {
      name: "PermanentError",
      arb: fc.tuple(fc.string(), fc.option(fc.string())),
      create: ([errMsg, message]: [string, string | null]) =>
        new PermanentError(new Error(errMsg), message ?? undefined),
    },
  ] as const;

  describe("All error classes extend Error", () => {
    for (const factory of errorFactories) {
      it(`${factory.name} instanceof Error`, () => {
        fc.assert(
          fc.property(factory.arb as fc.Arbitrary<unknown>, (input) => {
            const error = (factory.create as (input: unknown) => Error)(input);
            expect(error).toBeInstanceOf(Error);
          })
        );
      });
    }
  });

  describe("All error classes have correct name property", () => {
    for (const factory of errorFactories) {
      it(`${factory.name} has name === "${factory.name}"`, () => {
        fc.assert(
          fc.property(factory.arb as fc.Arbitrary<unknown>, (input) => {
            const error = (factory.create as (input: unknown) => Error)(input);
            expect(error.name).toBe(factory.name);
          })
        );
      });
    }
  });

  describe("All error classes serialize properly (message accessible, stack exists)", () => {
    for (const factory of errorFactories) {
      it(`${factory.name} has accessible message and stack trace`, () => {
        fc.assert(
          fc.property(factory.arb as fc.Arbitrary<unknown>, (input) => {
            const error = (factory.create as (input: unknown) => Error)(input);
            // message is accessible as a string property
            expect(typeof error.message).toBe("string");
            // stack trace exists and is non-empty
            expect(typeof error.stack).toBe("string");
            expect(error.stack!.length).toBeGreaterThan(0);
          })
        );
      });
    }
  });

  describe("Error-specific properties are accessible", () => {
    it("CircularDependencyError.steps contains the steps array", () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1 }), { minLength: 1 }),
          (steps) => {
            const error = new CircularDependencyError(steps);
            expect(error.steps).toEqual(steps);
          }
        )
      );
    });

    it("InvalidDependencyError has stepName and dependencyName", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (stepName, depName) => {
            const error = new InvalidDependencyError(stepName, depName);
            expect(error.stepName).toBe(stepName);
            expect(error.dependencyName).toBe(depName);
          }
        )
      );
    });

    it("ValidationError.errors contains the error array", () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ message: fc.string() }), { minLength: 1 }),
          (errors) => {
            const error = new ValidationError(errors);
            expect(error.errors).toEqual(errors);
          }
        )
      );
    });

    it("InvalidStepError.stepName matches input", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), (stepName) => {
          const error = new InvalidStepError(stepName);
          expect(error.stepName).toBe(stepName);
        })
      );
    });

    it("TimeoutError.ms and TimeoutError.stepName match inputs", () => {
      fc.assert(
        fc.property(
          fc.nat({ max: 600000 }),
          fc.option(fc.string({ minLength: 1 })),
          (ms, stepName) => {
            const error = new TimeoutError(ms, stepName ?? undefined);
            expect(error.ms).toBe(ms);
            expect(error.stepName).toBe(stepName ?? undefined);
          }
        )
      );
    });

    it("CircuitOpenError has serviceName and remainingMs", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.nat({ max: 600000 }),
          (serviceName, remainingMs) => {
            const error = new CircuitOpenError(serviceName, remainingMs);
            expect(error.serviceName).toBe(serviceName);
            expect(error.remainingMs).toBe(remainingMs);
          }
        )
      );
    });

    it("InputWiringError has stepName and referencedStep", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.option(fc.string({ minLength: 1 })),
          (stepName, refStep) => {
            const error = new InputWiringError(stepName, refStep);
            expect(error.stepName).toBe(stepName);
            expect(error.referencedStep).toBe(refStep);
          }
        )
      );
    });

    it("BranchNotMatchedError has branchName and discriminatorValue", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string(),
          (branchName, discValue) => {
            const error = new BranchNotMatchedError(branchName, discValue);
            expect(error.branchName).toBe(branchName);
            expect(error.discriminatorValue).toBe(discValue);
          }
        )
      );
    });

    it("BranchDiscriminatorError has branchName and originalError", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string(),
          (branchName, errorMsg) => {
            const original = new Error(errorMsg);
            const error = new BranchDiscriminatorError(branchName, original);
            expect(error.branchName).toBe(branchName);
            expect(error.originalError).toBe(original);
          }
        )
      );
    });

    it("ForEachPartialError has errors and results", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              index: fc.nat(),
              element: fc.string(),
              error: fc.string().map((msg) => new Error(msg)),
            }),
            { minLength: 1 }
          ),
          fc.array(fc.string()),
          (errors, results) => {
            const error = new ForEachPartialError(errors, results);
            expect(error.errors).toEqual(errors);
            expect(error.results).toEqual(results);
          }
        )
      );
    });

    it("ForEachMapperError.originalError matches input", () => {
      fc.assert(
        fc.property(fc.string(), (msg) => {
          const original = new Error(msg);
          const error = new ForEachMapperError(original);
          expect(error.originalError).toBe(original);
        })
      );
    });

    it("ForEachMapperError accepts string as originalError", () => {
      fc.assert(
        fc.property(fc.string(), (msg) => {
          const error = new ForEachMapperError(msg);
          expect(error.originalError).toBe(msg);
        })
      );
    });

    it("MaxIterationsExhaustedError has maxIterations and lastResult", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000 }),
          fc.option(fc.string()),
          (maxIter, lastResult) => {
            const error = new MaxIterationsExhaustedError(
              maxIter,
              lastResult ?? undefined
            );
            expect(error.maxIterations).toBe(maxIter);
            expect(error.lastResult).toBe(lastResult ?? undefined);
          }
        )
      );
    });

    it("PredicateError.originalError matches input", () => {
      fc.assert(
        fc.property(fc.string(), (msg) => {
          const original = new Error(msg);
          const error = new PredicateError(original);
          expect(error.originalError).toBe(original);
        })
      );
    });

    it("RetryableError has retryable=true and originalError", () => {
      fc.assert(
        fc.property(fc.string(), fc.option(fc.string()), (errMsg, message) => {
          const original = new Error(errMsg);
          const error = new RetryableError(original, message ?? undefined);
          expect(error.retryable).toBe(true);
          expect(error.originalError).toBe(original);
        })
      );
    });

    it("PermanentError has permanent=true and originalError", () => {
      fc.assert(
        fc.property(fc.string(), fc.option(fc.string()), (errMsg, message) => {
          const original = new Error(errMsg);
          const error = new PermanentError(original, message ?? undefined);
          expect(error.permanent).toBe(true);
          expect(error.originalError).toBe(original);
        })
      );
    });
  });
});

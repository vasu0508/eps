import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createPipeline } from "../../src/builder/pipeline-builder.js";
import {
  ValidationError,
  EmptyPipelineError,
} from "../../src/errors.js";

/**
 * Property-based tests for Pipeline Builder validation
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.2, 9.4, 9.5, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6**
 */
describe("Pipeline Builder — Property Tests", () => {
  // --- Arbitraries ---

  /** Valid step name: 1-128 printable characters */
  const validStepName = fc.string({ minLength: 1, maxLength: 128 }).filter(
    (s) => s.trim().length > 0
  );

  /** Invalid empty step name */
  const emptyStepName = fc.constant("");

  /** Step name exceeding 128 characters */
  const tooLongStepName = fc.string({ minLength: 129, maxLength: 256 });

  /** A valid async handler function */
  const validHandler = fc.constant(async () => "result");

  /** Non-function values (invalid handlers) */
  const invalidHandler = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(42),
    fc.constant("not a function"),
    fc.constant({}),
    fc.constant([]),
    fc.constant(true)
  );

  /** Valid timeout values: finite positive numbers */
  const validTimeout = fc.double({ min: 0.001, max: 1_000_000, noNaN: true }).filter(
    (v) => Number.isFinite(v) && v > 0
  );

  /** Invalid timeout values: non-positive, NaN, Infinity */
  const invalidTimeout = fc.oneof(
    fc.constant(0),
    fc.constant(-1),
    fc.constant(-100),
    fc.double({ min: -1_000_000, max: 0, noNaN: true }),
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(-Infinity)
  );

  /** Valid retry counts: non-negative integers */
  const validRetryCount = fc.integer({ min: 0, max: 10 });

  /** Invalid retry counts: negative, NaN, non-integer, Infinity */
  const invalidRetryCount = fc.oneof(
    fc.constant(-1),
    fc.integer({ min: -100, max: -1 }),
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(-Infinity),
    fc.constant(1.5),
    fc.constant(0.1),
    fc.double({ min: 0.01, max: 9.99, noNaN: true }).filter((v) => !Number.isInteger(v))
  );

  /** Pairs of distinct valid step names */
  const distinctStepNames = fc
    .tuple(validStepName, validStepName)
    .filter(([a, b]) => a !== b);

  describe("Property 17: Configuration Validation Eagerness — invalid config detected at build time", () => {
    it(".step() throws ValidationError for empty name", () => {
      fc.assert(
        fc.property(emptyStepName, validHandler, (name, handler) => {
          const builder = createPipeline("test");
          expect(() => builder.step(name, handler)).toThrow(ValidationError);
        })
      );
    });

    it(".step() throws ValidationError for name > 128 chars", () => {
      fc.assert(
        fc.property(tooLongStepName, validHandler, (name, handler) => {
          const builder = createPipeline("test");
          expect(() => builder.step(name, handler)).toThrow(ValidationError);
        })
      );
    });

    it(".step() throws ValidationError for non-function handler", () => {
      fc.assert(
        fc.property(validStepName, invalidHandler, (name, handler) => {
          const builder = createPipeline("test");
          expect(() => builder.step(name, handler as any)).toThrow(ValidationError);
        })
      );
    });

    it(".step() throws ValidationError for duplicate step name", () => {
      fc.assert(
        fc.property(validStepName, (name) => {
          const builder = createPipeline("test");
          builder.step(name, async () => 1);
          expect(() => builder.step(name, async () => 2)).toThrow(ValidationError);
        })
      );
    });

    it(".timeout() throws ValidationError for non-positive or non-finite values", () => {
      fc.assert(
        fc.property(invalidTimeout, (ms) => {
          const builder = createPipeline("test");
          expect(() => builder.step("step1", async () => 1).timeout(ms)).toThrow(
            ValidationError
          );
        })
      );
    });

    it(".timeout() accepts valid positive finite values", () => {
      fc.assert(
        fc.property(validTimeout, (ms) => {
          const builder = createPipeline("test");
          expect(() => builder.step("step1", async () => 1).timeout(ms)).not.toThrow();
        })
      );
    });

    it(".retry() throws ValidationError for non-integer or negative values", () => {
      fc.assert(
        fc.property(invalidRetryCount, (count) => {
          const builder = createPipeline("test");
          expect(() => builder.step("step1", async () => 1).retry(count)).toThrow(
            ValidationError
          );
        })
      );
    });

    it(".retry() accepts valid non-negative integer values", () => {
      fc.assert(
        fc.property(validRetryCount, (count) => {
          const builder = createPipeline("test");
          expect(() => builder.step("step1", async () => 1).retry(count)).not.toThrow();
        })
      );
    });

    it(".validate() throws EmptyPipelineError for empty pipeline", () => {
      const builder = createPipeline("test");
      expect(() => builder.validate()).toThrow(EmptyPipelineError);
    });

    it(".validate() throws for cycles in dependency graph", () => {
      fc.assert(
        fc.property(distinctStepNames, ([a, b]) => {
          const builder = createPipeline("test");
          builder.step(a, async () => 1).dependsOn(b);
          builder.step(b, async () => 2).dependsOn(a);
          expect(() => builder.validate()).toThrow();
        })
      );
    });

    it(".validate() throws for invalid (non-existent) dependency references", () => {
      fc.assert(
        fc.property(
          validStepName,
          validStepName.filter((s) => s !== "existingStep"),
          (stepName, missingDep) => {
            // Ensure stepName and missingDep are different
            if (stepName === missingDep) return;

            const builder = createPipeline("test");
            builder.step(stepName, async () => 1).dependsOn(missingDep);
            expect(() => builder.validate()).toThrow();
          }
        )
      );
    });

    it(".optional() then .required() on same step throws ValidationError", () => {
      fc.assert(
        fc.property(validStepName, (name) => {
          const builder = createPipeline("test");
          const configurator = builder.step(name, async () => 1).optional();
          expect(() => configurator.required()).toThrow(ValidationError);
        })
      );
    });
  });

  describe("Property 15: Step Naming Uniqueness — no duplicates allowed", () => {
    it("adding two steps with the same name always throws ValidationError", () => {
      fc.assert(
        fc.property(validStepName, (name) => {
          const builder = createPipeline("test");
          builder.step(name, async () => "first");
          expect(() => builder.step(name, async () => "second")).toThrow(
            ValidationError
          );
        })
      );
    });

    it("adding two steps with distinct names always succeeds", () => {
      fc.assert(
        fc.property(distinctStepNames, ([nameA, nameB]) => {
          const builder = createPipeline("test");
          expect(() => {
            builder.step(nameA, async () => "first");
            builder.step(nameB, async () => "second");
          }).not.toThrow();
        })
      );
    });

    it("step names are case-sensitive (different case means different step)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 64 }).filter(
            (s) => s.trim().length > 0 && s.toLowerCase() !== s.toUpperCase()
          ),
          (name) => {
            const lower = name.toLowerCase();
            const upper = name.toUpperCase();
            if (lower === upper) return; // skip if case doesn't change the string

            const builder = createPipeline("test");
            expect(() => {
              builder.step(lower, async () => "a");
              builder.step(upper, async () => "b");
            }).not.toThrow();
          }
        )
      );
    });
  });

  describe("Property 16: Required vs Optional Semantics — required steps fail pipeline, optional don't", () => {
    it("when a required step fails, pipeline.success === false", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => {
              throw new Error("required step failure");
            })
            .required()
            .execute();

          expect(result.success).toBe(false);
        })
      );
    });

    it("when an optional step fails (no required failures), pipeline.success === true", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => {
              throw new Error("optional step failure");
            })
            .optional()
            .execute();

          expect(result.success).toBe(true);
        })
      );
    });

    it("when optional step has defaultValue, result.getValue(step) === defaultValue", async () => {
      await fc.assert(
        fc.asyncProperty(
          validStepName,
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.constant([]),
            fc.constant({})
          ),
          async (name, defaultValue) => {
            const result = await createPipeline("test")
              .step(name, async () => {
                throw new Error("fails");
              })
              .optional(defaultValue)
              .execute();

            expect(result.success).toBe(true);
            expect(result.getValue(name)).toEqual(defaultValue);
          }
        )
      );
    });

    it("steps are required by default (failure causes pipeline.success === false)", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          // No explicit .required() call - default behavior
          const result = await createPipeline("test")
            .step(name, async () => {
              throw new Error("default required step failure");
            })
            .execute();

          expect(result.success).toBe(false);
        })
      );
    });

    it("optional step failure with no default produces undefined value and failed status", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => {
              throw new Error("optional fail no default");
            })
            .optional()
            .execute();

          expect(result.success).toBe(true);
          // getValue returns undefined for failed steps
          expect(result.getValue(name)).toBeUndefined();
          const stepResult = result.steps.get(name);
          expect(stepResult).toBeDefined();
          // Status should indicate failure/default path
          expect(
            stepResult!.status === "failed" || stepResult!.status === "default"
          ).toBe(true);
        })
      );
    });

    it("when all required steps succeed, success is true regardless of optional failures", async () => {
      await fc.assert(
        fc.asyncProperty(distinctStepNames, async ([reqName, optName]) => {
          const result = await createPipeline("test")
            .step(reqName, async () => "required-ok")
            .required()
            .step(optName, async () => {
              throw new Error("optional failure");
            })
            .optional()
            .execute();

          expect(result.success).toBe(true);
          expect(result.getValue(reqName)).toBe("required-ok");
        })
      );
    });
  });
});

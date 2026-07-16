import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createPipeline } from "../../src/builder/pipeline-builder.js";
import { InvalidStepError } from "../../src/errors.js";

/**
 * Property-based tests for Pipeline Result
 *
 * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6**
 */

// --- Arbitraries ---

/** Valid step name: 1-20 chars for fast tests */
const validStepName = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/** Pairs of distinct valid step names */
const distinctStepNames = fc
  .uniqueArray(validStepName, { minLength: 2, maxLength: 5 })
  .filter((names) => new Set(names).size === names.length);

/** Correlation ID: non-empty string */
const correlationId = fc.uuid();

describe("Pipeline Result — Property Tests", () => {
  describe("Property 13: Pipeline Result Completeness — result contains all step outcomes", () => {
    /**
     * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6**
     *
     * For any pipeline with N steps (some required, some optional, some failing),
     * the result.steps map has an entry for every step. Every step has a recognized status.
     */
    it("result.steps has an entry for every declared step regardless of success/failure", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
          fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
          async (names, shouldFail, isOptional) => {
            const builder = createPipeline("test");

            for (let i = 0; i < names.length; i++) {
              const fail = shouldFail[i % shouldFail.length];
              const optional = isOptional[i % isOptional.length];

              const handler = fail
                ? async () => { throw new Error(`step ${i} failed`); }
                : async () => `result-${i}`;

              const step = builder.step(names[i], handler);
              if (optional) {
                step.optional();
              } else {
                step.required();
              }
            }

            const result = await builder.execute();

            // Every declared step should be present in the steps map
            for (const name of names) {
              const stepResult = result.steps.get(name);
              expect(stepResult).toBeDefined();
              // Every step result has a valid status
              expect([
                "success",
                "fallback",
                "default",
                "skipped",
                "failed",
              ]).toContain(stepResult!.status);
            }

            // The steps map size equals the number of declared steps
            expect(result.steps.size).toBe(names.length);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("all required steps succeed implies success === true", async () => {
      await fc.assert(
        fc.asyncProperty(distinctStepNames, async (names) => {
          const builder = createPipeline("test");

          for (let i = 0; i < names.length; i++) {
            builder.step(names[i], async () => `value-${i}`).required();
          }

          const result = await builder.execute();
          expect(result.success).toBe(true);

          // All steps should have success status
          for (const name of names) {
            const stepResult = result.steps.get(name);
            expect(stepResult!.status).toBe("success");
          }
        }),
        { numRuns: 30 }
      );
    });

    it("a required step failure causes success === false", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.integer({ min: 0, max: 4 }),
          async (names, failIndex) => {
            const idx = failIndex % names.length;
            const builder = createPipeline("test");

            for (let i = 0; i < names.length; i++) {
              const handler =
                i === idx
                  ? async () => { throw new Error("required failure"); }
                  : async () => `value-${i}`;
              builder.step(names[i], handler).required();
            }

            const result = await builder.execute();
            expect(result.success).toBe(false);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("optional step failures never cause success === false when all required steps pass", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames.filter((names) => names.length >= 2),
          async (names) => {
            const builder = createPipeline("test");

            // First step required and succeeds
            builder.step(names[0], async () => "ok").required();

            // Remaining steps are optional and fail
            for (let i = 1; i < names.length; i++) {
              builder
                .step(names[i], async () => { throw new Error("optional fail"); })
                .optional();
            }

            const result = await builder.execute();
            expect(result.success).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Property 33: Pipeline Result Serialization — toJSON produces serializable output", () => {
    /**
     * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6**
     *
     * result.toJSON() returns a plain object.
     * JSON.stringify(result.toJSON()) succeeds without throwing.
     * The serialized result preserves success, correlationId, executionId, and duration.
     * result.report.toJSON() produces ISO timestamp strings for startTime/endTime.
     */
    it("result.toJSON() produces a JSON-serializable plain object", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
          async (names, shouldFail) => {
            const builder = createPipeline("test");

            for (let i = 0; i < names.length; i++) {
              const fail = shouldFail[i % shouldFail.length];
              const handler = fail
                ? async () => { throw new Error(`fail-${i}`); }
                : async () => `value-${i}`;
              builder.step(names[i], handler).optional();
            }

            const result = await builder.execute();
            const json = result.toJSON();

            // toJSON returns a plain object
            expect(json).toBeDefined();
            expect(typeof json).toBe("object");
            expect(json).not.toBeNull();

            // JSON.stringify succeeds without throwing
            const serialized = JSON.stringify(json);
            expect(typeof serialized).toBe("string");
            expect(serialized.length).toBeGreaterThan(0);

            // Round-trip: parse back and verify key fields
            const parsed = JSON.parse(serialized);
            expect(parsed.success).toBe(result.success);
            expect(parsed.executionId).toBe(result.executionId);
            expect(parsed.correlationId).toBe(result.correlationId);
            expect(parsed.duration).toBe(result.duration);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("result.report.toJSON() produces ISO timestamp strings for startTime/endTime", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => "value")
            .execute();

          const reportJson = result.report.toJSON();

          // startTime and endTime should be ISO 8601 strings
          expect(typeof reportJson.startTime).toBe("string");
          expect(typeof reportJson.endTime).toBe("string");

          // Verify they are valid ISO date strings
          const startDate = new Date(reportJson.startTime);
          const endDate = new Date(reportJson.endTime);
          expect(startDate.toISOString()).toBe(reportJson.startTime);
          expect(endDate.toISOString()).toBe(reportJson.endTime);

          // endTime >= startTime
          expect(endDate.getTime()).toBeGreaterThanOrEqual(startDate.getTime());

          // Duration should be consistent
          expect(reportJson.duration).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 30 }
      );
    });

    it("correlationId is preserved when provided in options", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, correlationId, async (name, corrId) => {
          const result = await createPipeline("test")
            .step(name, async () => "value")
            .execute({ correlationId: corrId });

          expect(result.correlationId).toBe(corrId);

          const json = result.toJSON();
          expect(json.correlationId).toBe(corrId);
        }),
        { numRuns: 30 }
      );
    });

    it("correlationId is auto-generated (non-empty string) when not provided", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => "value")
            .execute();

          expect(result.correlationId).toBeDefined();
          expect(typeof result.correlationId).toBe("string");
          expect(result.correlationId.length).toBeGreaterThan(0);
        }),
        { numRuns: 20 }
      );
    });

    it("executionId is always a non-empty string unique per execution", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const pipeline = createPipeline("test").step(name, async () => "value");

          const result1 = await pipeline.execute();
          const result2 = await pipeline.execute();

          // Each result has a non-empty executionId
          expect(result1.executionId).toBeDefined();
          expect(typeof result1.executionId).toBe("string");
          expect(result1.executionId.length).toBeGreaterThan(0);

          expect(result2.executionId).toBeDefined();
          expect(typeof result2.executionId).toBe("string");
          expect(result2.executionId.length).toBeGreaterThan(0);

          // executionIds should be unique across executions
          expect(result1.executionId).not.toBe(result2.executionId);
        }),
        { numRuns: 20 }
      );
    });

    it("serialized report includes the graph as adjacency structure", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames.filter((n) => n.length >= 2),
          async (names) => {
            const builder = createPipeline("test");
            builder.step(names[0], async () => "a");
            for (let i = 1; i < names.length; i++) {
              builder.step(names[i], async () => `v${i}`).dependsOn(names[0]);
            }

            const result = await builder.execute();
            const reportJson = result.report.toJSON();

            // Graph should be present as an object
            expect(reportJson.graph).toBeDefined();
            expect(typeof reportJson.graph).toBe("object");

            // First step has no dependencies
            expect(reportJson.graph[names[0]]).toEqual([]);

            // Other steps depend on the first step
            for (let i = 1; i < names.length; i++) {
              expect(reportJson.graph[names[i]]).toContain(names[0]);
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("getValue — retrieves step values or throws for non-existent steps", () => {
    /**
     * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6**
     */
    it("getValue returns the step's value for successful steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          validStepName,
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.constant([1, 2, 3]),
            fc.constant({ key: "value" })
          ),
          async (name, value) => {
            const result = await createPipeline("test")
              .step(name, async () => value)
              .execute();

            expect(result.getValue(name)).toEqual(value);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("getValue throws InvalidStepError for non-existent step names", async () => {
      await fc.assert(
        fc.asyncProperty(
          validStepName,
          validStepName.filter((s) => s !== "existing"),
          async (existingName, nonExistentName) => {
            // Ensure they are different
            if (existingName === nonExistentName) return;

            const result = await createPipeline("test")
              .step(existingName, async () => "value")
              .execute();

            expect(() => result.getValue(nonExistentName)).toThrow(InvalidStepError);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("getValue returns undefined for failed steps", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => { throw new Error("fails"); })
            .optional()
            .execute();

          expect(result.getValue(name)).toBeUndefined();
        }),
        { numRuns: 20 }
      );
    });
  });

  describe("getError — retrieves step errors or undefined for successful steps", () => {
    /**
     * **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6**
     */
    it("getError returns the Error for failed steps", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, fc.string({ minLength: 1 }), async (name, msg) => {
          const result = await createPipeline("test")
            .step(name, async () => { throw new Error(msg); })
            .optional()
            .execute();

          const error = result.getError(name);
          expect(error).toBeDefined();
          expect(error).toBeInstanceOf(Error);
          expect(error!.message).toBe(msg);
        }),
        { numRuns: 30 }
      );
    });

    it("getError returns undefined for successful steps", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => "value")
            .execute();

          expect(result.getError(name)).toBeUndefined();
        }),
        { numRuns: 20 }
      );
    });

    it("getError throws InvalidStepError for non-existent step names", async () => {
      await fc.assert(
        fc.asyncProperty(
          validStepName,
          validStepName.filter((s) => s !== "existing"),
          async (existingName, nonExistentName) => {
            if (existingName === nonExistentName) return;

            const result = await createPipeline("test")
              .step(existingName, async () => "value")
              .execute();

            expect(() => result.getError(nonExistentName)).toThrow(InvalidStepError);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("correlationId — provided or auto-generated", () => {
    /**
     * **Validates: Requirements 12.3**
     */
    it("when correlationId is provided, result.correlationId matches exactly", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, correlationId, async (name, corrId) => {
          const result = await createPipeline("test")
            .step(name, async () => "v")
            .execute({ correlationId: corrId });

          expect(result.correlationId).toBe(corrId);
        }),
        { numRuns: 30 }
      );
    });

    it("when correlationId is not provided, it is auto-generated as a non-empty string", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("test")
            .step(name, async () => "v")
            .execute();

          expect(result.correlationId).toBeDefined();
          expect(typeof result.correlationId).toBe("string");
          expect(result.correlationId.length).toBeGreaterThan(0);
        }),
        { numRuns: 20 }
      );
    });

    it("auto-generated correlationIds are unique across pipeline executions", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const pipeline = createPipeline("test").step(name, async () => "v");

          const r1 = await pipeline.execute();
          const r2 = await pipeline.execute();

          expect(r1.correlationId).not.toBe(r2.correlationId);
        }),
        { numRuns: 20 }
      );
    });
  });
});

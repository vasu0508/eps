import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createPipeline } from "../../src/builder/pipeline-builder.js";

/**
 * Property-based integration tests for full pipeline scenarios.
 *
 * **Validates: Requirements 1.1-1.7, 2.1-2.3, 7.1-7.9, 12.1-12.6**
 */

// --- Arbitraries ---

/** Valid step name: 1-20 chars, starting with a letter, alphanumeric + underscore/hyphen */
const validStepName = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/** Array of 2-5 unique valid step names */
const distinctStepNames = fc
  .uniqueArray(validStepName, { minLength: 2, maxLength: 5 })
  .filter((names) => new Set(names).size === names.length);

/** Arbitrary deterministic return value */
const deterministicValue = fc.oneof(
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.constant([1, 2, 3]),
  fc.constant({ key: "value" })
);

describe("Pipeline Scenarios — Property Tests (Integration)", () => {
  describe("Property 1: Pipeline Success Determinism — same input always produces same outcome", () => {
    /**
     * For any pipeline configuration with deterministic handlers, executing twice
     * produces identical success/failure outcomes and identical step values.
     *
     * **Validates: Requirements 1.1-1.7, 2.1-2.3, 7.1-7.9, 12.1-12.6**
     */
    it("deterministic pipeline produces identical success/failure on repeated execution", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.array(deterministicValue, { minLength: 2, maxLength: 5 }),
          async (names, values) => {
            // Build a deterministic pipeline (all steps succeed with fixed values)
            const buildPipeline = () => {
              const builder = createPipeline("deterministic-test");
              for (let i = 0; i < names.length; i++) {
                const value = values[i % values.length];
                builder.step(names[i], async () => value).required();
              }
              return builder;
            };

            const result1 = await buildPipeline().execute();
            const result2 = await buildPipeline().execute();

            // Same success/failure outcome
            expect(result1.success).toBe(result2.success);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("deterministic pipeline produces identical step values on repeated execution", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.array(deterministicValue, { minLength: 2, maxLength: 5 }),
          async (names, values) => {
            const buildPipeline = () => {
              const builder = createPipeline("deterministic-values");
              for (let i = 0; i < names.length; i++) {
                const value = values[i % values.length];
                builder.step(names[i], async () => value).required();
              }
              return builder;
            };

            const result1 = await buildPipeline().execute();
            const result2 = await buildPipeline().execute();

            // Every step produces the same value
            for (const name of names) {
              expect(result1.getValue(name)).toEqual(result2.getValue(name));
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it("deterministic failing pipeline produces identical failure on repeated execution", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.integer({ min: 0, max: 4 }),
          async (names, failIdx) => {
            const idx = failIdx % names.length;

            const buildPipeline = () => {
              const builder = createPipeline("deterministic-fail");
              for (let i = 0; i < names.length; i++) {
                if (i === idx) {
                  builder
                    .step(names[i], async () => {
                      throw new Error("deterministic failure");
                    })
                    .required();
                } else {
                  builder.step(names[i], async () => `value-${i}`).required();
                }
              }
              return builder;
            };

            const result1 = await buildPipeline().execute();
            const result2 = await buildPipeline().execute();

            expect(result1.success).toBe(false);
            expect(result2.success).toBe(false);
            expect(result1.success).toBe(result2.success);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("determinism holds with conditional steps (.onlyIf)", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames.filter((n) => n.length >= 3),
          fc.boolean(),
          async (names, conditionValue) => {
            const buildPipeline = () => {
              return createPipeline<{ flag: boolean }>("deterministic-cond")
                .withContext({ flag: conditionValue })
                .step(names[0], async () => "base")
                .required()
                .step(names[1], async () => "conditional")
                .onlyIf((ctx) => ctx.flag)
                .dependsOn(names[0])
                .step(names[2], async () => "final")
                .dependsOn(names[1]);
            };

            const result1 = await buildPipeline().execute();
            const result2 = await buildPipeline().execute();

            expect(result1.success).toBe(result2.success);
            for (const name of names) {
              const step1 = result1.steps.get(name);
              const step2 = result2.steps.get(name);
              expect(step1?.status).toBe(step2?.status);
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("Property 2: Pipeline Result Consistency — success iff all required steps succeed", () => {
    /**
     * result.success === true if and only if all required steps have a non-"failed"
     * status (success, fallback, default, skipped).
     *
     * **Validates: Requirements 1.1-1.7, 2.1-2.3, 7.1-7.9, 12.1-12.6**
     */
    it("success === true when all required steps succeed", async () => {
      await fc.assert(
        fc.asyncProperty(distinctStepNames, async (names) => {
          const builder = createPipeline("all-required-pass");

          for (let i = 0; i < names.length; i++) {
            builder.step(names[i], async () => `value-${i}`).required();
          }

          const result = await builder.execute();
          expect(result.success).toBe(true);

          // Verify all required steps have non-failed status
          for (const name of names) {
            const stepResult = result.steps.get(name);
            expect(stepResult).toBeDefined();
            expect(stepResult!.status).not.toBe("failed");
          }
        }),
        { numRuns: 30 }
      );
    });

    it("success === false when any required step fails", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.integer({ min: 0, max: 4 }),
          async (names, failIdx) => {
            const idx = failIdx % names.length;
            const builder = createPipeline("one-required-fails");

            for (let i = 0; i < names.length; i++) {
              if (i === idx) {
                builder
                  .step(names[i], async () => {
                    throw new Error("required step failure");
                  })
                  .required();
              } else {
                builder.step(names[i], async () => `value-${i}`).required();
              }
            }

            const result = await builder.execute();
            expect(result.success).toBe(false);

            // The failing step must have "failed" status
            const failedStep = result.steps.get(names[idx]);
            expect(failedStep).toBeDefined();
            expect(failedStep!.status).toBe("failed");
          }
        ),
        { numRuns: 30 }
      );
    });

    it("success === true when optional steps fail but all required steps pass", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames.filter((n) => n.length >= 2),
          async (names) => {
            const builder = createPipeline("optional-fail-required-pass");

            // First step is required and succeeds
            builder.step(names[0], async () => "required-ok").required();

            // Remaining steps are optional and fail
            for (let i = 1; i < names.length; i++) {
              builder
                .step(names[i], async () => {
                  throw new Error("optional failure");
                })
                .optional();
            }

            const result = await builder.execute();
            expect(result.success).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });

    it("success reflects consistency: if success is true, no required step has 'failed' status", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
          fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
          async (names, shouldFail, isOptional) => {
            const builder = createPipeline("consistency-check");
            const requiredStepNames: string[] = [];

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
                requiredStepNames.push(names[i]);
              }
            }

            const result = await builder.execute();

            if (result.success) {
              // If success === true, no required step should have "failed" status
              for (const name of requiredStepNames) {
                const stepResult = result.steps.get(name);
                expect(stepResult).toBeDefined();
                expect(stepResult!.status).not.toBe("failed");
              }
            } else {
              // If success === false, at least one required step must have "failed" status
              // OR a required step was skipped due to dependency failure of another required step
              const hasRequiredFailure = requiredStepNames.some((name) => {
                const stepResult = result.steps.get(name);
                return stepResult?.status === "failed";
              });
              const hasRequiredSkipped = requiredStepNames.some((name) => {
                const stepResult = result.steps.get(name);
                return stepResult?.status === "skipped";
              });
              // Pipeline fails when a required step fails (which may cascade skips)
              expect(hasRequiredFailure || hasRequiredSkipped).toBe(true);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("steps default to required — unmarked steps that fail cause pipeline failure", async () => {
      await fc.assert(
        fc.asyncProperty(validStepName, async (name) => {
          const result = await createPipeline("default-required")
            .step(name, async () => {
              throw new Error("unmarked step failure");
            })
            .execute();

          expect(result.success).toBe(false);
        }),
        { numRuns: 20 }
      );
    });
  });

  describe("Property 13: Pipeline Result Completeness — verified at runtime", () => {
    /**
     * result.steps map size === number of declared steps, and every step has a valid status.
     *
     * **Validates: Requirements 1.1-1.7, 2.1-2.3, 7.1-7.9, 12.1-12.6**
     */
    it("result.steps contains exactly one entry per declared step", async () => {
      await fc.assert(
        fc.asyncProperty(distinctStepNames, async (names) => {
          const builder = createPipeline("completeness");

          for (let i = 0; i < names.length; i++) {
            builder.step(names[i], async () => `value-${i}`);
          }

          const result = await builder.execute();

          // Map size equals declared step count
          expect(result.steps.size).toBe(names.length);

          // Every declared step name is present
          for (const name of names) {
            expect(result.steps.has(name)).toBe(true);
          }
        }),
        { numRuns: 30 }
      );
    });

    it("every step has a valid status from the set of allowed statuses", async () => {
      const validStatuses = ["success", "fallback", "default", "skipped", "failed"];

      await fc.assert(
        fc.asyncProperty(
          distinctStepNames,
          fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
          fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
          async (names, shouldFail, isOptional) => {
            const builder = createPipeline("status-validity");

            for (let i = 0; i < names.length; i++) {
              const fail = shouldFail[i % shouldFail.length];
              const optional = isOptional[i % isOptional.length];

              const handler = fail
                ? async () => { throw new Error(`step ${i} failed`); }
                : async () => `result-${i}`;

              const step = builder.step(names[i], handler);
              if (optional) {
                step.optional();
              }
            }

            const result = await builder.execute();

            // Every step result has a valid status
            for (const [name, stepResult] of result.steps.entries()) {
              expect(validStatuses).toContain(stepResult.status);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("completeness holds with mixed required/optional/conditional steps", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames.filter((n) => n.length >= 3),
          fc.boolean(),
          fc.boolean(),
          async (names, conditionValue, firstOptional) => {
            const stepNames = names.slice(0, 3); // Use exactly 3 steps
            const builder = createPipeline<{ flag: boolean }>("completeness-mixed")
              .withContext({ flag: conditionValue });

            // First step: optionally required/optional
            const step1 = builder.step(stepNames[0], async () => "base");
            if (firstOptional) {
              step1.optional();
            } else {
              step1.required();
            }

            // Second step: conditional
            builder
              .step(stepNames[1], async () => "conditional-value")
              .onlyIf((ctx) => ctx.flag)
              .dependsOn(stepNames[0]);

            // Third step: depends on conditional (may be skipped via cascade)
            builder
              .step(stepNames[2], async () => "dependent-value")
              .dependsOn(stepNames[1]);

            const result = await builder.execute();

            // Regardless of outcome, all declared steps have entries
            expect(result.steps.size).toBe(stepNames.length);
            for (const name of stepNames) {
              const stepResult = result.steps.get(name);
              expect(stepResult).toBeDefined();
              expect(["success", "fallback", "default", "skipped", "failed"]).toContain(
                stepResult!.status
              );
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it("completeness holds when pipeline fails — all steps still have entries", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames.filter((n) => n.length >= 3),
          async (names) => {
            const stepNames = names.slice(0, 3); // Use exactly 3 steps
            const builder = createPipeline("completeness-failure");

            // First step succeeds
            builder.step(stepNames[0], async () => "ok").required();

            // Second step fails (required)
            builder
              .step(stepNames[1], async () => {
                throw new Error("failure");
              })
              .required()
              .dependsOn(stepNames[0]);

            // Third step depends on failed step (should be skipped)
            builder
              .step(stepNames[2], async () => "unreachable")
              .dependsOn(stepNames[1]);

            const result = await builder.execute();

            expect(result.success).toBe(false);
            expect(result.steps.size).toBe(stepNames.length);

            // All steps have entries with valid statuses
            for (const name of stepNames) {
              expect(result.steps.has(name)).toBe(true);
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it("completeness holds with abort signal — all steps present even if aborted early", async () => {
      await fc.assert(
        fc.asyncProperty(distinctStepNames, async (names) => {
          // Already-aborted signal: pipeline should finish immediately
          const controller = new AbortController();
          controller.abort();

          const builder = createPipeline("completeness-abort");
          for (const name of names) {
            builder.step(name, async () => `value-${name}`);
          }

          const result = await builder.execute({ signal: controller.signal });

          expect(result.success).toBe(false);
          // All steps must still have entries
          expect(result.steps.size).toBe(names.length);
          for (const name of names) {
            expect(result.steps.has(name)).toBe(true);
          }
        }),
        { numRuns: 20 }
      );
    });

    it("completeness holds with dependencies — both linear and diamond graphs", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctStepNames.filter((n) => n.length >= 4),
          async (names) => {
            // Diamond graph: A -> B, A -> C, B -> D, C -> D
            const builder = createPipeline("completeness-diamond");
            builder.step(names[0], async () => "a");
            builder.step(names[1], async () => "b").dependsOn(names[0]);
            builder.step(names[2], async () => "c").dependsOn(names[0]);
            builder.step(names[3], async () => "d").dependsOn(names[1], names[2]);

            const result = await builder.execute();

            expect(result.steps.size).toBe(4);
            for (let i = 0; i < 4; i++) {
              expect(result.steps.has(names[i])).toBe(true);
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});

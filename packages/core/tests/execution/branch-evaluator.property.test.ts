import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { evaluateBranch } from "../../src/execution/branch-evaluator.js";
import type { ExecutionContext } from "../../src/types.js";
import type { BranchDefinition, BranchHandler } from "../../src/types/branch.js";
import {
  BranchNotMatchedError,
  BranchDiscriminatorError,
} from "../../src/errors.js";

/**
 * Property-based tests for Branch Evaluator
 *
 * **Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8**
 */

// --- Helpers ---

function createContext(
  overrides: Partial<ExecutionContext<unknown>> = {}
): ExecutionContext<unknown> {
  return {
    pipelineId: "test-pipeline",
    correlationId: "test-correlation",
    stepResults: new Map(),
    userContext: {},
    abortSignal: new AbortController().signal,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    metrics: {
      increment: () => {},
      gauge: () => {},
      histogram: () => {},
      timing: () => {},
    },
    ...overrides,
  };
}

/**
 * Arbitrary for generating distinct branch keys (strings).
 * Returns an array of 2-10 unique string keys.
 */
const distinctBranchKeys = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
    minLength: 2,
    maxLength: 10,
  });

/**
 * Arbitrary for generating discriminator values of various primitive types.
 */
const discriminatorValue = fc.oneof(
  fc.string({ minLength: 0, maxLength: 20 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined)
);

describe("Branch Evaluator — Property Tests", () => {
  describe("Property 23: Branch Mutual Exclusivity — exactly one handler executes per evaluation", () => {
    /**
     * **Validates: Requirements 15.2, 15.3**
     *
     * For any set of N branches with distinct keys and any discriminator value
     * matching one of them, exactly one handler is invoked. We count all handler
     * invocations across all branches and verify the count is exactly 1.
     */
    it("exactly one handler executes when discriminator matches one branch", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctBranchKeys,
          fc.nat(),
          async (keys, seedIndex) => {
            // Pick one key as the match target
            const matchIndex = seedIndex % keys.length;
            const matchKey = keys[matchIndex];

            // Track invocation count per branch
            const invocations: number[] = new Array(keys.length).fill(0);

            const branches = new Map<unknown, BranchHandler>();
            for (let i = 0; i < keys.length; i++) {
              const idx = i;
              branches.set(keys[i], {
                handler: async () => {
                  invocations[idx]++;
                  return `result-${idx}`;
                },
              });
            }

            const definition: BranchDefinition<unknown> = {
              name: "mutualExclusivity",
              discriminator: () => matchKey,
              branches,
            };

            const context = createContext();
            await evaluateBranch(definition, context);

            // Exactly one handler was invoked total
            const totalInvocations = invocations.reduce((a, b) => a + b, 0);
            expect(totalInvocations).toBe(1);

            // The correct branch was the one invoked
            expect(invocations[matchIndex]).toBe(1);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("otherwise handler counts as exactly one invocation when no branch matches", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctBranchKeys,
          async (keys) => {
            let otherwiseInvocations = 0;
            const branchInvocations: number[] = new Array(keys.length).fill(0);

            const branches = new Map<unknown, BranchHandler>();
            for (let i = 0; i < keys.length; i++) {
              const idx = i;
              branches.set(keys[i], {
                handler: async () => {
                  branchInvocations[idx]++;
                  return `result-${idx}`;
                },
              });
            }

            const definition: BranchDefinition<unknown> = {
              name: "mutualExclusivityOtherwise",
              discriminator: () => "__no_match_value__",
              branches,
              defaultBranch: {
                handler: async () => {
                  otherwiseInvocations++;
                  return "default-result";
                },
              },
            };

            const context = createContext();
            await evaluateBranch(definition, context);

            // No branch handler was invoked
            const totalBranchInvocations = branchInvocations.reduce((a, b) => a + b, 0);
            expect(totalBranchInvocations).toBe(0);

            // Exactly one otherwise invocation
            expect(otherwiseInvocations).toBe(1);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Property 24: Branch Discriminator Error Isolation — discriminator failure isolated", () => {
    /**
     * **Validates: Requirements 15.6**
     *
     * When the discriminator throws any Error, a BranchDiscriminatorError is thrown
     * wrapping the original. The original error is preserved in `.originalError`.
     * No branch handler is invoked.
     */
    it("discriminator errors are wrapped in BranchDiscriminatorError with original preserved", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (branchName, errorMessage) => {
            const originalError = new Error(errorMessage);
            let handlerInvoked = false;

            const definition: BranchDefinition<unknown> = {
              name: branchName,
              discriminator: () => {
                throw originalError;
              },
              branches: new Map([
                [
                  "any",
                  {
                    handler: async () => {
                      handlerInvoked = true;
                      return "should-not-reach";
                    },
                  },
                ],
              ]),
            };

            const context = createContext();

            try {
              await evaluateBranch(definition, context);
              // Should not reach here
              expect.fail("Expected BranchDiscriminatorError to be thrown");
            } catch (err: unknown) {
              expect(err).toBeInstanceOf(BranchDiscriminatorError);
              const bdError = err as BranchDiscriminatorError;
              expect(bdError.branchName).toBe(branchName);
              expect(bdError.originalError).toBe(originalError);
              expect(bdError.originalError.message).toBe(errorMessage);
            }

            // No handler was invoked
            expect(handlerInvoked).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("non-Error throws from discriminator are wrapped in an Error inside BranchDiscriminatorError", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.oneof(
            fc.string({ minLength: 1, maxLength: 30 }),
            fc.integer(),
            fc.constant(null)
          ),
          async (branchName, thrownValue) => {
            const definition: BranchDefinition<unknown> = {
              name: branchName,
              discriminator: () => {
                throw thrownValue;
              },
              branches: new Map(),
            };

            const context = createContext();

            try {
              await evaluateBranch(definition, context);
              expect.fail("Expected BranchDiscriminatorError to be thrown");
            } catch (err: unknown) {
              expect(err).toBeInstanceOf(BranchDiscriminatorError);
              const bdError = err as BranchDiscriminatorError;
              expect(bdError.branchName).toBe(branchName);
              // The original should be wrapped in an Error
              expect(bdError.originalError).toBeInstanceOf(Error);
              expect(bdError.originalError.message).toBe(String(thrownValue));
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Strict equality matching — value matching uses ===", () => {
    /**
     * **Validates: Requirements 15.3, 15.5**
     *
     * The branch evaluator uses strict equality (===) to match discriminator
     * values against .when() keys. Values that are loosely equal but not strictly
     * equal should NOT match (e.g., string "1" vs number 1).
     */
    it("string vs number: loosely equal values do not match under strict equality", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: -1000, max: 1000 }),
          async (numValue) => {
            const strValue = String(numValue);
            let handlerInvoked = false;

            // Register branch with string key, discriminator returns number
            const definition: BranchDefinition<unknown> = {
              name: "strictEquality",
              discriminator: () => numValue,
              branches: new Map([
                [
                  strValue,
                  {
                    handler: async () => {
                      handlerInvoked = true;
                      return "matched";
                    },
                  },
                ],
              ]),
            };

            const context = createContext();

            // Should throw BranchNotMatchedError since string !== number
            try {
              await evaluateBranch(definition, context);
              expect.fail("Expected BranchNotMatchedError");
            } catch (err: unknown) {
              expect(err).toBeInstanceOf(BranchNotMatchedError);
              const bnmError = err as BranchNotMatchedError;
              expect(bnmError.discriminatorValue).toBe(numValue);
            }

            expect(handlerInvoked).toBe(false);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("exact same type and value always matches the correct branch", async () => {
      await fc.assert(
        fc.asyncProperty(
          discriminatorValue,
          async (value) => {
            let matchedHandlerCalled = false;

            const branches = new Map<unknown, BranchHandler>();
            branches.set(value, {
              handler: async () => {
                matchedHandlerCalled = true;
                return "matched";
              },
            });

            const definition: BranchDefinition<unknown> = {
              name: "exactMatch",
              discriminator: () => value,
              branches,
            };

            const context = createContext();
            const result = await evaluateBranch(definition, context);

            expect(matchedHandlerCalled).toBe(true);
            expect(result.value).toBe("matched");
            expect(result.branchSelected).toBe(value);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Otherwise branch — default handler executes when no match", () => {
    /**
     * **Validates: Requirements 15.4**
     *
     * When the discriminator value doesn't match any .when() key but an
     * otherwise handler exists, exactly the otherwise handler executes.
     */
    it("otherwise handler executes when discriminator matches no branch key", async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctBranchKeys,
          discriminatorValue,
          async (keys, unmatchedValue) => {
            // Ensure the unmatched value isn't in the keys array
            if (keys.includes(unmatchedValue as string)) return;

            let otherwiseCalled = false;
            const branchCalls: boolean[] = new Array(keys.length).fill(false);

            const branches = new Map<unknown, BranchHandler>();
            for (let i = 0; i < keys.length; i++) {
              const idx = i;
              branches.set(keys[i], {
                handler: async () => {
                  branchCalls[idx] = true;
                  return `branch-${idx}`;
                },
              });
            }

            const definition: BranchDefinition<unknown> = {
              name: "otherwiseTest",
              discriminator: () => unmatchedValue,
              branches,
              defaultBranch: {
                handler: async () => {
                  otherwiseCalled = true;
                  return "otherwise-result";
                },
              },
            };

            const context = createContext();
            const result = await evaluateBranch(definition, context);

            // Otherwise was called
            expect(otherwiseCalled).toBe(true);

            // No branch handler was called
            expect(branchCalls.every((c) => c === false)).toBe(true);

            // Result value is from otherwise
            expect(result.value).toBe("otherwise-result");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("BranchNotMatchedError — thrown when no match and no otherwise", () => {
    /**
     * **Validates: Requirements 15.5**
     *
     * When no match and no otherwise, BranchNotMatchedError is thrown
     * containing the branch name and discriminator value.
     */
    it("BranchNotMatchedError contains branch name and discriminator value", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 30 }),
          distinctBranchKeys,
          discriminatorValue,
          async (branchName, keys, unmatchedValue) => {
            // Ensure the unmatched value isn't in the keys array
            if (keys.includes(unmatchedValue as string)) return;

            const branches = new Map<unknown, BranchHandler>();
            for (const key of keys) {
              branches.set(key, {
                handler: async () => `result-${key}`,
              });
            }

            const definition: BranchDefinition<unknown> = {
              name: branchName,
              discriminator: () => unmatchedValue,
              branches,
              // No defaultBranch
            };

            const context = createContext();

            try {
              await evaluateBranch(definition, context);
              expect.fail("Expected BranchNotMatchedError");
            } catch (err: unknown) {
              expect(err).toBeInstanceOf(BranchNotMatchedError);
              const bnmError = err as BranchNotMatchedError;
              expect(bnmError.branchName).toBe(branchName);
              expect(bnmError.discriminatorValue).toBe(unmatchedValue);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

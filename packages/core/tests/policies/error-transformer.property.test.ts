import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  applyErrorTransformation,
  applyErrorTransformationChain,
} from "../../src/policies/error-transformer.js";
import { ErrorTransformResultError } from "../../src/errors.js";

/**
 * Property-based tests for Error Transformer
 *
 * **Validates: Requirements 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7**
 */
describe("Error Transformer — Property Tests", () => {
  // Arbitraries
  const arbError = fc.string({ minLength: 1 }).map((msg) => new Error(msg));

  const arbErrorTransformer = fc
    .string({ minLength: 1 })
    .map((msg) => (_err: Error) => new Error(msg));

  const arbTaggedTransformer = fc
    .string({ minLength: 1 })
    .map((tag) => (err: Error) => new Error(`${tag}:${err.message}`));

  const arbThrowingTransformerError = fc
    .string({ minLength: 1 })
    .map((msg) => (_err: Error): Error => {
      throw new Error(msg);
    });

  const arbThrowingTransformerNonError = fc
    .string({ minLength: 1 })
    .map((msg) => (_err: Error): Error => {
      throw msg; // throws a non-Error value
    });

  const arbNonErrorReturningTransformer = fc
    .string({ minLength: 1 })
    .map((msg) => (_err: Error) => msg as unknown as Error);

  describe("Property 31: Error Transformation Order — transforms applied in declaration order", () => {
    it("a chain of N transforms is applied in declaration order, output of transform[i] is input to transform[i+1]", () => {
      fc.assert(
        fc.property(
          arbError,
          fc.array(arbTaggedTransformer, { minLength: 1, maxLength: 10 }),
          (originalError, transformers) => {
            const result = applyErrorTransformationChain(
              originalError,
              transformers
            );

            // Manually simulate the chain to verify order
            let expected = originalError;
            for (const t of transformers) {
              expected = t(expected);
            }

            expect(result.message).toBe(expected.message);
          }
        )
      );
    });

    it("order matters: reversing the chain produces different results for non-commutative transforms", () => {
      fc.assert(
        fc.property(
          arbError,
          fc.tuple(
            fc.constant((err: Error) => new Error(`A:${err.message}`)),
            fc.constant((err: Error) => new Error(`B:${err.message}`))
          ),
          (originalError, [t1, t2]) => {
            const forward = applyErrorTransformationChain(originalError, [
              t1,
              t2,
            ]);
            const reversed = applyErrorTransformationChain(originalError, [
              t2,
              t1,
            ]);

            // For non-commutative transforms, order matters
            // forward: B:A:msg vs reversed: A:B:msg
            expect(forward.message).toBe(`B:A:${originalError.message}`);
            expect(reversed.message).toBe(`A:B:${originalError.message}`);
            expect(forward.message).not.toBe(reversed.message);
          }
        )
      );
    });

    it("single transform in chain produces same result as applyErrorTransformation directly", () => {
      fc.assert(
        fc.property(arbError, arbErrorTransformer, (error, transformer) => {
          const chainResult = applyErrorTransformationChain(error, [
            transformer,
          ]);
          const directResult = applyErrorTransformation(error, transformer);

          expect(chainResult.message).toBe(directResult.message);
          expect(chainResult.constructor).toBe(directResult.constructor);
        })
      );
    });
  });

  describe("Property 32: Error Transformation Fault Tolerance — applyErrorTransformationChain never throws", () => {
    it("if a transform throws an Error, that Error replaces the original", () => {
      fc.assert(
        fc.property(
          arbError,
          arbThrowingTransformerError,
          (originalError, throwingTransformer) => {
            const result = applyErrorTransformation(
              originalError,
              throwingTransformer
            );

            // The thrown Error replaces the original
            expect(result).toBeInstanceOf(Error);
            expect(result).not.toBe(originalError);
          }
        )
      );
    });

    it("if a transform throws a non-Error value, it is wrapped in ErrorTransformResultError", () => {
      fc.assert(
        fc.property(
          arbError,
          arbThrowingTransformerNonError,
          (originalError, throwingTransformer) => {
            const result = applyErrorTransformation(
              originalError,
              throwingTransformer
            );

            expect(result).toBeInstanceOf(ErrorTransformResultError);
            expect(result.message).toContain(
              "mapError threw a non-Error value"
            );
          }
        )
      );
    });

    it("if a transform returns a non-Error value, it is wrapped in ErrorTransformResultError", () => {
      fc.assert(
        fc.property(
          arbError,
          arbNonErrorReturningTransformer,
          (originalError, badTransformer) => {
            const result = applyErrorTransformation(
              originalError,
              badTransformer
            );

            expect(result).toBeInstanceOf(ErrorTransformResultError);
            expect(result.message).toBe(
              "mapError must return an Error instance"
            );
          }
        )
      );
    });

    it("applyErrorTransformationChain never throws regardless of transformer behavior", () => {
      // Mix of well-behaved, throwing, and non-Error-returning transformers
      const arbMixedTransformer = fc.oneof(
        arbErrorTransformer,
        arbThrowingTransformerError,
        arbThrowingTransformerNonError,
        arbNonErrorReturningTransformer
      );

      fc.assert(
        fc.property(
          arbError,
          fc.array(arbMixedTransformer, { minLength: 0, maxLength: 10 }),
          (originalError, transformers) => {
            // Must not throw — always returns an Error
            const result = applyErrorTransformationChain(
              originalError,
              transformers
            );
            expect(result).toBeInstanceOf(Error);
          }
        )
      );
    });

    it("the result is always an Error instance even when all transforms misbehave", () => {
      const arbBadTransformer = fc.oneof(
        arbThrowingTransformerNonError,
        arbNonErrorReturningTransformer
      );

      fc.assert(
        fc.property(
          arbError,
          fc.array(arbBadTransformer, { minLength: 1, maxLength: 5 }),
          (originalError, transformers) => {
            const result = applyErrorTransformationChain(
              originalError,
              transformers
            );
            expect(result).toBeInstanceOf(Error);
          }
        )
      );
    });
  });

  describe("Identity properties", () => {
    it("applyErrorTransformationChain(error, undefined) === error", () => {
      fc.assert(
        fc.property(arbError, (error) => {
          const result = applyErrorTransformationChain(error, undefined);
          expect(result).toBe(error);
        })
      );
    });

    it("applyErrorTransformationChain(error, []) === error", () => {
      fc.assert(
        fc.property(arbError, (error) => {
          const result = applyErrorTransformationChain(error, []);
          expect(result).toBe(error);
        })
      );
    });

    it("applyErrorTransformation(error, undefined) === error", () => {
      fc.assert(
        fc.property(arbError, (error) => {
          const result = applyErrorTransformation(error, undefined);
          expect(result).toBe(error);
        })
      );
    });
  });
});

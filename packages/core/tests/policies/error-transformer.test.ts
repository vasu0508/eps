import { describe, it, expect } from "vitest";
import {
  applyErrorTransformation,
  applyErrorTransformationChain,
} from "../../src/policies/error-transformer.js";
import { ErrorTransformResultError } from "../../src/errors.js";

describe("applyErrorTransformation", () => {
  it("returns original error when transformer is undefined", () => {
    const error = new Error("original");
    const result = applyErrorTransformation(error, undefined);
    expect(result).toBe(error);
  });

  it("returns transformed error when transformer returns an Error", () => {
    const original = new Error("original");
    const transformed = new TypeError("transformed");
    const transformer = () => transformed;

    const result = applyErrorTransformation(original, transformer);
    expect(result).toBe(transformed);
  });

  it("wraps non-Error return in ErrorTransformResultError", () => {
    const original = new Error("original");
    const transformer = () => "not an error" as unknown as Error;

    const result = applyErrorTransformation(original, transformer);
    expect(result).toBeInstanceOf(ErrorTransformResultError);
    expect(result.message).toBe("mapError must return an Error instance");
  });

  it("uses thrown Error as replacement when transformer throws an Error", () => {
    const original = new Error("original");
    const thrownError = new RangeError("thrown");
    const transformer = () => {
      throw thrownError;
    };

    const result = applyErrorTransformation(original, transformer);
    expect(result).toBe(thrownError);
  });

  it("wraps thrown non-Error value in ErrorTransformResultError", () => {
    const original = new Error("original");
    const transformer = () => {
      throw "a string";
    };

    const result = applyErrorTransformation(original, transformer);
    expect(result).toBeInstanceOf(ErrorTransformResultError);
    expect(result.message).toContain("mapError threw a non-Error value");
  });

  it("passes the original error to the transformer function", () => {
    const original = new Error("original");
    let receivedError: Error | undefined;
    const transformer = (err: Error) => {
      receivedError = err;
      return new Error("new");
    };

    applyErrorTransformation(original, transformer);
    expect(receivedError).toBe(original);
  });

  it("handles transformer returning null as non-Error", () => {
    const original = new Error("original");
    const transformer = () => null as unknown as Error;

    const result = applyErrorTransformation(original, transformer);
    expect(result).toBeInstanceOf(ErrorTransformResultError);
  });

  it("handles transformer returning undefined as non-Error", () => {
    const original = new Error("original");
    const transformer = () => undefined as unknown as Error;

    const result = applyErrorTransformation(original, transformer);
    expect(result).toBeInstanceOf(ErrorTransformResultError);
  });
});

describe("applyErrorTransformationChain", () => {
  it("returns original error when transformers is undefined", () => {
    const error = new Error("original");
    const result = applyErrorTransformationChain(error, undefined);
    expect(result).toBe(error);
  });

  it("returns original error when transformers is empty array", () => {
    const error = new Error("original");
    const result = applyErrorTransformationChain(error, []);
    expect(result).toBe(error);
  });

  it("applies single transformer in chain", () => {
    const original = new Error("original");
    const transformed = new TypeError("transformed");
    const transformer = () => transformed;

    const result = applyErrorTransformationChain(original, [transformer]);
    expect(result).toBe(transformed);
  });

  it("chains multiple transforms in declaration order", () => {
    const original = new Error("original");
    const calls: string[] = [];

    const transform1 = (err: Error) => {
      calls.push(`t1:${err.message}`);
      return new Error("after-t1");
    };
    const transform2 = (err: Error) => {
      calls.push(`t2:${err.message}`);
      return new Error("after-t2");
    };
    const transform3 = (err: Error) => {
      calls.push(`t3:${err.message}`);
      return new Error("after-t3");
    };

    const result = applyErrorTransformationChain(original, [
      transform1,
      transform2,
      transform3,
    ]);

    expect(calls).toEqual([
      "t1:original",
      "t2:after-t1",
      "t3:after-t2",
    ]);
    expect(result.message).toBe("after-t3");
  });

  it("chain stops applying correctly when a transformer returns non-Error", () => {
    const original = new Error("original");

    const transform1 = () => "not an error" as unknown as Error;
    const transform2 = (err: Error) => new Error(`wrapped:${err.message}`);

    const result = applyErrorTransformationChain(original, [
      transform1,
      transform2,
    ]);

    // transform1 returns non-Error -> becomes ErrorTransformResultError
    // transform2 receives that ErrorTransformResultError and wraps it
    expect(result.message).toBe(
      "wrapped:mapError must return an Error instance"
    );
  });

  it("chain continues when transformer throws, using thrown error as input to next", () => {
    const original = new Error("original");
    const thrownError = new RangeError("thrown");

    const transform1 = () => {
      throw thrownError;
    };
    const transform2 = (err: Error) => new Error(`after:${err.message}`);

    const result = applyErrorTransformationChain(original, [
      transform1,
      transform2,
    ]);

    // transform1 throws -> thrownError becomes current error
    // transform2 receives thrownError
    expect(result.message).toBe("after:thrown");
  });
});

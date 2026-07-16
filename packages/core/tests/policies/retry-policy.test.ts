import { describe, it, expect } from "vitest";
import { createRetryPolicy } from "../../src/policies/retry-policy.js";

describe("createRetryPolicy", () => {
  describe("creation and defaults", () => {
    it("creates a policy with default fixed backoff and 1000ms baseDelay", () => {
      const policy = createRetryPolicy(3);
      expect(policy.maxAttempts).toBe(3);
      expect(policy.backoff).toBe("fixed");
      expect(policy.getDelay(1)).toBe(1000);
      expect(policy.getDelay(2)).toBe(1000);
      expect(policy.getDelay(3)).toBe(1000);
    });

    it("uses provided backoff strategy", () => {
      const policy = createRetryPolicy(2, { backoff: "exponential", baseDelay: 200 });
      expect(policy.backoff).toBe("exponential");
    });

    it("throws for count < 1", () => {
      expect(() => createRetryPolicy(0)).toThrow(RangeError);
    });

    it("throws for count > 10", () => {
      expect(() => createRetryPolicy(11)).toThrow(RangeError);
    });

    it("throws for non-integer count", () => {
      expect(() => createRetryPolicy(2.5)).toThrow(RangeError);
    });

    it("throws for baseDelay < 100", () => {
      expect(() => createRetryPolicy(1, { baseDelay: 50 })).toThrow(RangeError);
    });

    it("throws for baseDelay > 60000", () => {
      expect(() => createRetryPolicy(1, { baseDelay: 70000 })).toThrow(RangeError);
    });
  });

  describe("shouldRetry", () => {
    it("returns true when attempt < maxAttempts", () => {
      const policy = createRetryPolicy(3);
      expect(policy.shouldRetry(new Error("fail"), 1)).toBe(true);
      expect(policy.shouldRetry(new Error("fail"), 2)).toBe(true);
    });

    it("returns false when attempt >= maxAttempts (retries exhausted)", () => {
      const policy = createRetryPolicy(3);
      expect(policy.shouldRetry(new Error("fail"), 3)).toBe(false);
      expect(policy.shouldRetry(new Error("fail"), 4)).toBe(false);
    });

    it("returns false when retryOn predicate rejects the error", () => {
      const policy = createRetryPolicy(3, {
        retryOn: (err) => err.message === "transient",
      });
      expect(policy.shouldRetry(new Error("transient"), 1)).toBe(true);
      expect(policy.shouldRetry(new Error("permanent"), 1)).toBe(false);
    });

    it("returns true when retryOn predicate accepts the error", () => {
      const policy = createRetryPolicy(3, {
        retryOn: (err) => err.message.includes("retry"),
      });
      expect(policy.shouldRetry(new Error("please retry"), 1)).toBe(true);
    });
  });

  describe("getDelay - fixed backoff", () => {
    it("returns baseDelay for all attempts", () => {
      const policy = createRetryPolicy(5, { backoff: "fixed", baseDelay: 500 });
      expect(policy.getDelay(1)).toBe(500);
      expect(policy.getDelay(2)).toBe(500);
      expect(policy.getDelay(3)).toBe(500);
      expect(policy.getDelay(5)).toBe(500);
    });
  });

  describe("getDelay - exponential backoff", () => {
    it("calculates baseDelay * 2^(attempt-1)", () => {
      const policy = createRetryPolicy(5, {
        backoff: "exponential",
        baseDelay: 100,
        maxDelay: 30000,
      });
      expect(policy.getDelay(1)).toBe(100); // 100 * 2^0
      expect(policy.getDelay(2)).toBe(200); // 100 * 2^1
      expect(policy.getDelay(3)).toBe(400); // 100 * 2^2
      expect(policy.getDelay(4)).toBe(800); // 100 * 2^3
      expect(policy.getDelay(5)).toBe(1600); // 100 * 2^4
    });

    it("caps at maxDelay", () => {
      const policy = createRetryPolicy(10, {
        backoff: "exponential",
        baseDelay: 1000,
        maxDelay: 5000,
      });
      expect(policy.getDelay(1)).toBe(1000); // 1000 * 2^0
      expect(policy.getDelay(2)).toBe(2000); // 1000 * 2^1
      expect(policy.getDelay(3)).toBe(4000); // 1000 * 2^2
      expect(policy.getDelay(4)).toBe(5000); // capped at maxDelay
      expect(policy.getDelay(5)).toBe(5000); // capped at maxDelay
    });

    it("uses default maxDelay of 30000 when not specified", () => {
      const policy = createRetryPolicy(10, {
        backoff: "exponential",
        baseDelay: 10000,
      });
      // 10000 * 2^0 = 10000
      expect(policy.getDelay(1)).toBe(10000);
      // 10000 * 2^1 = 20000
      expect(policy.getDelay(2)).toBe(20000);
      // 10000 * 2^2 = 40000 → capped at 30000
      expect(policy.getDelay(3)).toBe(30000);
    });
  });

  describe("getDelay - linear backoff", () => {
    it("calculates baseDelay * attempt", () => {
      const policy = createRetryPolicy(5, {
        backoff: "linear",
        baseDelay: 200,
        maxDelay: 30000,
      });
      expect(policy.getDelay(1)).toBe(200); // 200 * 1
      expect(policy.getDelay(2)).toBe(400); // 200 * 2
      expect(policy.getDelay(3)).toBe(600); // 200 * 3
      expect(policy.getDelay(4)).toBe(800); // 200 * 4
      expect(policy.getDelay(5)).toBe(1000); // 200 * 5
    });

    it("caps at maxDelay", () => {
      const policy = createRetryPolicy(10, {
        backoff: "linear",
        baseDelay: 5000,
        maxDelay: 15000,
      });
      expect(policy.getDelay(1)).toBe(5000); // 5000 * 1
      expect(policy.getDelay(2)).toBe(10000); // 5000 * 2
      expect(policy.getDelay(3)).toBe(15000); // 5000 * 3 = 15000 = maxDelay
      expect(policy.getDelay(4)).toBe(15000); // capped
    });

    it("uses default maxDelay of 30000 when not specified", () => {
      const policy = createRetryPolicy(10, {
        backoff: "linear",
        baseDelay: 10000,
      });
      expect(policy.getDelay(1)).toBe(10000); // 10000 * 1
      expect(policy.getDelay(2)).toBe(20000); // 10000 * 2
      expect(policy.getDelay(3)).toBe(30000); // 10000 * 3 = 30000 = maxDelay
      expect(policy.getDelay(4)).toBe(30000); // capped
    });
  });
});

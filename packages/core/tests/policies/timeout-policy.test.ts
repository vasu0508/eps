import { describe, it, expect } from "vitest";
import { createTimeoutPolicy } from "../../src/policies/timeout-policy.js";
import { TimeoutError, CancellationError } from "../../src/errors.js";

describe("TimeoutPolicy", () => {
  describe("basic behavior", () => {
    it("returns the result when fn resolves before timeout", async () => {
      const policy = createTimeoutPolicy({ ms: 1000 });
      const controller = new AbortController();

      const result = await policy.wrap(
        () => Promise.resolve("hello"),
        controller.signal
      );

      expect(result).toBe("hello");
    });

    it("rejects with TimeoutError when fn exceeds timeout", async () => {
      const policy = createTimeoutPolicy({ ms: 50 });
      const controller = new AbortController();

      const promise = policy.wrap(
        () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
        controller.signal
      );

      await expect(promise).rejects.toThrow(TimeoutError);
      await expect(promise).rejects.toMatchObject({ ms: 50 });
    });

    it("includes step name in TimeoutError when provided", async () => {
      const policy = createTimeoutPolicy({ ms: 50, stepName: "FetchUser" });
      const controller = new AbortController();

      const promise = policy.wrap(
        () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
        controller.signal
      );

      await expect(promise).rejects.toMatchObject({
        ms: 50,
        stepName: "FetchUser",
      });
    });

    it("propagates the error when fn rejects before timeout", async () => {
      const policy = createTimeoutPolicy({ ms: 1000 });
      const controller = new AbortController();

      const promise = policy.wrap(
        () => Promise.reject(new Error("upstream failure")),
        controller.signal
      );

      await expect(promise).rejects.toThrow("upstream failure");
    });

    it("clears the timer when fn resolves", async () => {
      const policy = createTimeoutPolicy({ ms: 50 });
      const controller = new AbortController();

      const result = await policy.wrap(
        () => Promise.resolve(42),
        controller.signal
      );

      expect(result).toBe(42);

      // Wait beyond the timeout to confirm no unhandled rejection
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  describe("abort signal integration", () => {
    it("rejects with CancellationError when signal is already aborted", async () => {
      const policy = createTimeoutPolicy({ ms: 1000 });
      const controller = new AbortController();
      controller.abort("pre-aborted");

      const promise = policy.wrap(
        () => new Promise((resolve) => setTimeout(() => resolve("value"), 100)),
        controller.signal
      );

      await expect(promise).rejects.toThrow(CancellationError);
    });

    it("rejects with CancellationError when signal is aborted during execution", async () => {
      const policy = createTimeoutPolicy({ ms: 5000 });
      const controller = new AbortController();

      const promise = policy.wrap(
        () => new Promise((resolve) => setTimeout(() => resolve("value"), 500)),
        controller.signal
      );

      // Abort after a short delay
      setTimeout(() => controller.abort("cancelled by user"), 50);

      await expect(promise).rejects.toThrow(CancellationError);
    });

    it("timeout fires before external abort when timeout is shorter", async () => {
      const policy = createTimeoutPolicy({ ms: 30 });
      const controller = new AbortController();

      const promise = policy.wrap(
        () => new Promise((resolve) => setTimeout(() => resolve("value"), 500)),
        controller.signal
      );

      // External abort after timeout would have already fired
      setTimeout(() => controller.abort(), 200);

      await expect(promise).rejects.toThrow(TimeoutError);
    });
  });

  describe("readonly ms property", () => {
    it("exposes the configured timeout duration", () => {
      const policy = createTimeoutPolicy({ ms: 3000 });
      expect(policy.ms).toBe(3000);
    });
  });
});

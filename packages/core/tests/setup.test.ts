import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

describe("project setup", () => {
  it("vitest is working", () => {
    expect(1 + 1).toBe(2);
  });

  it("fast-check is working", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(a + b).toBe(b + a);
      })
    );
  });
});

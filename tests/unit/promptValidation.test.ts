import { describe, expect, it } from "vitest";
import { parseStrictMenuChoice } from "../../src/cli/promptValidation";

describe("strict CLI menu validation", () => {
  it("accepts only empty input or an exact menu number", () => {
    expect(parseStrictMenuChoice("1", 2, 2)).toBe(1);
    expect(parseStrictMenuChoice("2", 2, 1)).toBe(2);
    expect(parseStrictMenuChoice("", 2, 2)).toBe(2);
    expect(parseStrictMenuChoice("   ", 2, 1)).toBe(1);
  });

  it("rejects mixed or out-of-range role menu input", () => {
    expect(parseStrictMenuChoice("1,2", 2, 2)).toBeNull();
    expect(parseStrictMenuChoice("12", 2, 2)).toBeNull();
    expect(parseStrictMenuChoice("foo", 2, 2)).toBeNull();
    expect(parseStrictMenuChoice("3", 2, 2)).toBeNull();
    expect(parseStrictMenuChoice("1foo", 2, 2)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  effectiveProjectLifecycleState,
  isValidProjectLifecycleState,
  PROJECT_LIFECYCLE_STATES,
} from "../../src/lib/projectLifecycle";

describe("projectLifecycle", () => {
  it("exposes the documented lifecycle states", () => {
    expect(PROJECT_LIFECYCLE_STATES).toEqual(["ACTIVE", "COMPLETE", "UNANNOTATED", "ANNOTATED", "ARCHIVED", "PUBLISHED"]);
  });

  it.each(PROJECT_LIFECYCLE_STATES)("accepts %s as a valid state", (state) => {
    expect(isValidProjectLifecycleState(state)).toBe(true);
  });

  it("rejects an unknown state string", () => {
    expect(isValidProjectLifecycleState("SOMETHING_ELSE")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidProjectLifecycleState(null)).toBe(false);
    expect(isValidProjectLifecycleState(undefined)).toBe(false);
    expect(isValidProjectLifecycleState(42)).toBe(false);
  });

  it("treats a null lifecycleState as ACTIVE - existing projects migrate with zero behavior change", () => {
    expect(effectiveProjectLifecycleState(null)).toBe("ACTIVE");
  });

  it("treats an unrecognized stored value as ACTIVE rather than throwing", () => {
    expect(effectiveProjectLifecycleState("garbage")).toBe("ACTIVE");
  });

  it("passes through a valid stored state unchanged", () => {
    expect(effectiveProjectLifecycleState("ARCHIVED")).toBe("ARCHIVED");
  });
});

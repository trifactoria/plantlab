import { describe, expect, it } from "vitest";
import {
  detectAutofocusSupport,
  lockAutofocus,
  restoreAutofocus,
  startAutofocus,
  type AutofocusDriver,
} from "../../src/lib/autofocus";
import type { CameraControl } from "../../src/lib/v4l2";

function control(overrides: Partial<CameraControl> & Pick<CameraControl, "id">): CameraControl {
  return {
    name: overrides.id,
    type: "bool",
    value: false,
    readOnly: false,
    inactive: false,
    ...overrides,
  };
}

function fakeDriver(initial: CameraControl[]) {
  let controls = initial;
  const calls: Array<{ control: string; value: string | number | boolean }> = [];

  const driver: AutofocusDriver = {
    listControls: async () => controls,
    setControl: async (id, value) => {
      calls.push({ control: id, value });
      controls = controls.map((existing) =>
        existing.id === id
          ? { ...existing, value }
          : existing.id === "focus_absolute" && id === "focus_automatic_continuous" && value === false
            ? { ...existing, inactive: false }
            : existing,
      );
    },
  };

  return { driver, calls, getControls: () => controls };
}

describe("detectAutofocusSupport", () => {
  it("reports unsupported when no continuous-autofocus control is reported", () => {
    const controls = [control({ id: "brightness", type: "int", value: 128 })];
    expect(detectAutofocusSupport(controls).supported).toBe(false);
  });

  it("reports unsupported when the control exists but is read-only", () => {
    const controls = [
      control({ id: "focus_automatic_continuous", type: "bool", value: true, readOnly: true }),
    ];
    expect(detectAutofocusSupport(controls).supported).toBe(false);
  });

  it("reports supported when a writable continuous-autofocus control is present", () => {
    const controls = [control({ id: "focus_automatic_continuous", type: "bool", value: false })];
    expect(detectAutofocusSupport(controls).supported).toBe(true);
  });
});

describe("startAutofocus / lockAutofocus", () => {
  it("records prior state and enables autofocus", async () => {
    const { driver, calls } = fakeDriver([
      control({ id: "focus_automatic_continuous", type: "bool", value: false }),
      control({ id: "focus_absolute", type: "int", value: 40, inactive: false }),
    ]);

    const result = await startAutofocus(driver);

    expect(result.previous).toEqual({ autofocusValue: false, manualFocusValue: 40 });
    expect(calls).toEqual([{ control: "focus_automatic_continuous", value: true }]);
  });

  it("throws a clear error when the camera does not support autofocus", async () => {
    const { driver } = fakeDriver([control({ id: "brightness", type: "int", value: 128 })]);

    await expect(startAutofocus(driver)).rejects.toThrow(/does not report/);
  });

  it("locks focus by disabling autofocus and returns the resulting manual value", async () => {
    const { driver, calls } = fakeDriver([
      control({ id: "focus_automatic_continuous", type: "bool", value: true }),
      control({ id: "focus_absolute", type: "int", value: 77, inactive: true }),
    ]);

    const result = await lockAutofocus(driver);

    expect(calls).toEqual([{ control: "focus_automatic_continuous", value: false }]);
    expect(result.manualFocusValue).toBe(77);
  });
});

describe("restoreAutofocus", () => {
  it("restores autofocus on, without touching manual focus, when it was on before", async () => {
    const { driver, calls } = fakeDriver([
      control({ id: "focus_automatic_continuous", type: "bool", value: false }),
      control({ id: "focus_absolute", type: "int", value: 10 }),
    ]);

    await restoreAutofocus(driver, { autofocusValue: true, manualFocusValue: null });

    expect(calls).toEqual([{ control: "focus_automatic_continuous", value: true }]);
  });

  it("restores autofocus off and the prior manual focus value when it was off before", async () => {
    const { driver, calls } = fakeDriver([
      control({ id: "focus_automatic_continuous", type: "bool", value: true }),
      control({ id: "focus_absolute", type: "int", value: 99 }),
    ]);

    await restoreAutofocus(driver, { autofocusValue: false, manualFocusValue: 33 });

    expect(calls).toEqual([
      { control: "focus_automatic_continuous", value: false },
      { control: "focus_absolute", value: 33 },
    ]);
  });

  it("is used to recover after a mid-sequence failure (autofocus-now failure restoration)", async () => {
    const { driver, calls } = fakeDriver([
      control({ id: "focus_automatic_continuous", type: "bool", value: false }),
      control({ id: "focus_absolute", type: "int", value: 12 }),
    ]);

    const started = await startAutofocus(driver);
    expect(started.previous.autofocusValue).toBe(false);
    expect(started.previous.manualFocusValue).toBe(12);

    // Simulate the lock phase failing after autofocus was already enabled -
    // the route/UI would call restoreAutofocus with the recorded previous state.
    await restoreAutofocus(driver, started.previous);

    expect(calls).toEqual([
      { control: "focus_automatic_continuous", value: true }, // start
      { control: "focus_automatic_continuous", value: false }, // restore
      { control: "focus_absolute", value: 12 }, // restore manual value
    ]);
  });
});

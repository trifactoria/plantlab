import { describe, expect, it } from "vitest";
import { lockCalibrationAutoModes, runAutoCalibration, type CalibrationDriver } from "../../src/lib/calibration";
import type { CameraControl, CameraFormat } from "../../src/lib/v4l2";

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

function fakeDriver(initialControls: CameraControl[], formats: CameraFormat[]) {
  let controls = initialControls;
  const calls: Array<{ control: string; value: string | number | boolean }> = [];

  const driver: CalibrationDriver = {
    listControls: async () => controls,
    listFormats: async () => formats,
    setControl: async (id, value) => {
      calls.push({ control: id, value });
      controls = controls.map((existing) => (existing.id === id ? { ...existing, value } : existing));
    },
  };

  return { driver, calls };
}

const noWait = async () => undefined;

describe("runAutoCalibration", () => {
  it("prefers MJPEG 1920x1080 when supported", async () => {
    const { driver } = fakeDriver(
      [],
      [
        {
          pixelFormat: "mjpg",
          description: "Motion-JPEG",
          resolutions: [
            { width: 1920, height: 1080, frameRates: [] },
            { width: 1280, height: 720, frameRates: [] },
          ],
        },
      ],
    );

    const result = await runAutoCalibration(driver, {
      currentFormat: "yuyv",
      currentWidth: 640,
      currentHeight: 480,
      wait: noWait,
    });

    expect(result.format).toBe("mjpg");
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.steps.find((step) => step.step === "format")?.applied).toBe(true);
  });

  it("preserves the current format/resolution when 1920x1080 MJPEG is unsupported", async () => {
    const { driver } = fakeDriver(
      [],
      [{ pixelFormat: "yuyv", description: "YUYV", resolutions: [{ width: 640, height: 480, frameRates: [] }] }],
    );

    const result = await runAutoCalibration(driver, {
      currentFormat: "yuyv",
      currentWidth: 640,
      currentHeight: 480,
      wait: noWait,
    });

    expect(result.format).toBe("yuyv");
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
    expect(result.steps.find((step) => step.step === "format")?.applied).toBe(false);
  });

  it("resets writable controls to their reported defaults, skipping read-only/inactive/already-default ones", async () => {
    const { driver, calls } = fakeDriver(
      [
        control({ id: "brightness", type: "int", value: 200, defaultValue: 128 }),
        control({ id: "contrast", type: "int", value: 50, defaultValue: 50 }), // already at default
        control({ id: "pan_absolute", type: "int", value: 10, defaultValue: 0, readOnly: true }),
        control({ id: "focus_absolute", type: "int", value: 5, defaultValue: 0, inactive: true }),
      ],
      [],
    );

    await runAutoCalibration(driver, {
      currentFormat: "mjpg",
      currentWidth: 1920,
      currentHeight: 1080,
      wait: noWait,
    });

    expect(calls).toEqual([{ control: "brightness", value: 128 }]);
  });

  it("only enables automatic modes this camera actually reports (uses only available controls)", async () => {
    const { driver, calls } = fakeDriver(
      [control({ id: "brightness", type: "int", value: 128, defaultValue: 128 })],
      [],
    );

    const result = await runAutoCalibration(driver, {
      currentFormat: "mjpg",
      currentWidth: 1920,
      currentHeight: 1080,
      wait: noWait,
    });

    // No AWB, auto-exposure, or autofocus controls exist - none should be touched.
    expect(calls).toEqual([]);
    expect(result.autoWhiteBalanceAvailable).toBe(false);
    expect(result.autoExposureAvailable).toBe(false);
    expect(result.focusLocked).toBe(false);
    expect(result.steps.find((step) => step.step === "auto-white-balance")?.applied).toBe(false);
    expect(result.steps.find((step) => step.step === "auto-exposure")?.applied).toBe(false);
    expect(result.steps.find((step) => step.step === "autofocus-enable")?.applied).toBe(false);
  });

  it("enables AWB, auto-exposure, and autofocus when reported, then locks focus after settling", async () => {
    const { driver, calls } = fakeDriver(
      [
        control({ id: "white_balance_automatic", type: "bool", value: false, defaultValue: false }),
        control({
          id: "exposure_auto",
          type: "menu",
          value: 1,
          defaultValue: 1,
          options: [
            { value: 1, label: "Manual Mode" },
            { value: 3, label: "Aperture Priority Mode" },
          ],
        }),
        control({ id: "focus_automatic_continuous", type: "bool", value: false, defaultValue: false }),
        control({ id: "focus_absolute", type: "int", value: 0, defaultValue: 0 }),
      ],
      [],
    );

    let waited = 0;
    const result = await runAutoCalibration(driver, {
      currentFormat: "mjpg",
      currentWidth: 1920,
      currentHeight: 1080,
      settleMs: 8_000,
      wait: async (ms) => {
        waited = ms;
      },
    });

    expect(waited).toBe(8_000);
    expect(calls.map((call) => call.control)).toEqual([
      "white_balance_automatic",
      "exposure_auto",
      "focus_automatic_continuous", // enable
      "focus_automatic_continuous", // disable to lock
    ]);
    expect(calls.at(-1)).toEqual({ control: "focus_automatic_continuous", value: false });
    expect(result.focusLocked).toBe(true);
    expect(result.autoWhiteBalanceAvailable).toBe(true);
    expect(result.autoExposureAvailable).toBe(true);
  });
});

describe("lockCalibrationAutoModes", () => {
  it("disables automatic white balance when asked to lock it", async () => {
    const { driver, calls } = fakeDriver(
      [control({ id: "white_balance_automatic", type: "bool", value: true })],
      [],
    );

    await lockCalibrationAutoModes(driver, { lockWhiteBalance: true, lockExposure: false });

    expect(calls).toEqual([{ control: "white_balance_automatic", value: false }]);
  });

  it("switches exposure to its Manual option when asked to lock it", async () => {
    const { driver, calls } = fakeDriver(
      [
        control({
          id: "exposure_auto",
          type: "menu",
          value: 3,
          options: [
            { value: 1, label: "Manual Mode" },
            { value: 3, label: "Aperture Priority Mode" },
          ],
        }),
      ],
      [],
    );

    await lockCalibrationAutoModes(driver, { lockWhiteBalance: false, lockExposure: true });

    expect(calls).toEqual([{ control: "exposure_auto", value: 1 }]);
  });

  it("leaves everything alone when the user chooses to leave both automatic", async () => {
    const { driver, calls } = fakeDriver(
      [control({ id: "white_balance_automatic", type: "bool", value: true })],
      [],
    );

    await lockCalibrationAutoModes(driver, { lockWhiteBalance: false, lockExposure: false });

    expect(calls).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileCalls: string[][] = [];
let failingControls = new Set<string>();

vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFileCalls.push(args);
    const setCtrlArg = args.find((arg) => arg.includes("="));
    const controlName = setCtrlArg?.split("=")[0];

    if (controlName && failingControls.has(controlName)) {
      callback(new Error("v4l2-ctl exited with code 1"), "", `${controlName}: Permission denied`);
      return;
    }

    callback(null, "", "");
  },
}));

const { applyCameraControls, parseControlsOutput } = await import("../../src/lib/v4l2");

const SAMPLE_OUTPUT = `
                     brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=128
white_balance_automatic 0x0098090c (boolean)   : default=1 value=1
     white_balance_temperature 0x0098091a (int)    : min=2800 max=6500 step=10 default=4600 value=4600 flags=inactive
                  exposure_auto 0x009a0901 (menu)   : min=0 max=3 default=3 value=3
                      0: Manual Mode
                      1: Auto Mode
                      3: Aperture Priority Mode
         exposure_time_absolute 0x009a0902 (int)    : min=3 max=2047 step=1 default=250 value=157 flags=inactive
    focus_absolute 0x009a090a (int)    : min=0 max=255 step=5 default=0 value=51 flags=inactive
    focus_automatic_continuous 0x009a090c (boolean)   : default=1 value=1
    pan_absolute 0x009a0908 (int)    : min=-201600 max=201600 step=3600 default=0 value=0 flags=read-only, volatile
`;

describe("parseControlsOutput", () => {
  const controls = parseControlsOutput(SAMPLE_OUTPUT);

  function find(id: string) {
    const control = controls.find((item) => item.id === id);
    if (!control) {
      throw new Error(`expected control ${id} to be parsed`);
    }
    return control;
  }

  it("parses ordinary writable controls as neither read-only nor inactive", () => {
    const brightness = find("brightness");
    expect(brightness.readOnly).toBe(false);
    expect(brightness.inactive).toBe(false);
    expect(brightness.value).toBe(128);
  });

  it("marks a control inactive (not read-only) when a related automatic mode drives it", () => {
    const whiteBalanceTemp = find("white_balance_temperature");
    expect(whiteBalanceTemp.inactive).toBe(true);
    expect(whiteBalanceTemp.readOnly).toBe(false);

    const exposureTime = find("exposure_time_absolute");
    expect(exposureTime.inactive).toBe(true);
    expect(exposureTime.readOnly).toBe(false);

    const focusAbsolute = find("focus_absolute");
    expect(focusAbsolute.inactive).toBe(true);
    expect(focusAbsolute.readOnly).toBe(false);
  });

  it("marks a control read-only (not inactive) when the driver reports it as permanently fixed", () => {
    const pan = find("pan_absolute");
    expect(pan.readOnly).toBe(true);
    expect(pan.inactive).toBe(false);
  });

  it("parses menu options for menu-type controls", () => {
    const exposureAuto = find("exposure_auto");
    expect(exposureAuto.type).toBe("menu");
    expect(exposureAuto.options).toEqual([
      { value: 0, label: "Manual Mode" },
      { value: 1, label: "Auto Mode" },
      { value: 3, label: "Aperture Priority Mode" },
    ]);
  });

  it("parses continuous autofocus as an ordinary writable boolean when not itself inactive", () => {
    const autofocus = find("focus_automatic_continuous");
    expect(autofocus.type).toBe("bool");
    expect(autofocus.value).toBe(true);
    expect(autofocus.readOnly).toBe(false);
    expect(autofocus.inactive).toBe(false);
  });
});

describe("applyCameraControls", () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    failingControls = new Set();
  });

  function controlNamesInOrder() {
    return execFileCalls
      .map((args) => args.find((arg) => arg.includes("="))?.split("=")[0])
      .filter((name): name is string => Boolean(name));
  }

  it("applies automatic-mode toggles before their dependent manual controls, regardless of JSON key order", async () => {
    await applyCameraControls("/dev/video0", {
      // Manual value listed first in the object - order must not matter.
      white_balance_temperature: 4370,
      white_balance_automatic: false,
      brightness: 128,
    });

    const order = controlNamesInOrder();
    expect(order.indexOf("white_balance_automatic")).toBeLessThan(order.indexOf("white_balance_temperature"));
  });

  it("does not abort the whole batch when one control is rejected (e.g. still inactive)", async () => {
    failingControls = new Set(["white_balance_temperature"]);

    const failures = await applyCameraControls("/dev/video0", {
      white_balance_automatic: true, // profile says auto is still on
      white_balance_temperature: 4370, // driver rejects this while auto is on
      brightness: 200,
    });

    // The rejected control is reported...
    expect(failures).toEqual([
      { control: "white_balance_temperature", error: expect.stringContaining("Permission denied") },
    ]);
    // ...but every other control in the batch was still attempted.
    expect(controlNamesInOrder()).toEqual(
      expect.arrayContaining(["white_balance_automatic", "white_balance_temperature", "brightness"]),
    );
  });

  it("resolves with no failures when every control applies cleanly", async () => {
    const failures = await applyCameraControls("/dev/video0", { brightness: 128 });
    expect(failures).toEqual([]);
  });
});

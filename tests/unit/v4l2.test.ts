import { describe, expect, it } from "vitest";
import { parseControlsOutput } from "../../src/lib/v4l2";

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

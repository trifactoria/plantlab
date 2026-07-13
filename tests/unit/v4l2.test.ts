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

const { applyCameraControls, capsIndicateVideoCapture, groupPhysicalCameras, parseCameraFormatsOutput, parseControlsOutput } = await import("../../src/lib/v4l2");

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

describe("parseCameraFormatsOutput", () => {
  it("preserves greenhouse-zero MJPG and YUYV format-resolution families from recorded output", () => {
    const formats = parseCameraFormatsOutput(`
ioctl: VIDIOC_ENUM_FMT
\tType: Video Capture

\t[0]: 'MJPG' (Motion-JPEG, compressed)
\t\tSize: Discrete 1920x1080
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 1280x720
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 800x600
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 640x480
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 640x360
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t[1]: 'YUYV' (YUYV 4:2:2)
\t\tSize: Discrete 1920x1080
\t\t\tInterval: Discrete 0.200s (5.000 fps)
\t\tSize: Discrete 1280x720
\t\t\tInterval: Discrete 0.100s (10.000 fps)
\t\tSize: Discrete 800x600
\t\t\tInterval: Discrete 0.050s (20.000 fps)
\t\tSize: Discrete 640x480
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 640x360
\t\t\tInterval: Discrete 0.033s (30.000 fps)
`);

    expect(formats.map((format) => format.pixelFormat)).toEqual(["mjpeg", "yuyv422"]);
    expect(formats[0].resolutions.map((resolution) => `${resolution.width}x${resolution.height}`)).toEqual([
      "1920x1080",
      "1280x720",
      "800x600",
      "640x480",
      "640x360",
    ]);
    expect(formats[0].resolutions[0].frameRates).toEqual(["30.000 fps"]);
    expect(formats[1].resolutions.map((resolution) => `${resolution.width}x${resolution.height}`)).toEqual([
      "1920x1080",
      "1280x720",
      "800x600",
      "640x480",
      "640x360",
    ]);
  });

  it("preserves bokchoy MJPG and YUYV format-resolution families from recorded output", () => {
    const formats = parseCameraFormatsOutput(`
\t[0]: 'MJPG' (Motion-JPEG, compressed)
\t\tSize: Discrete 1280x720
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 848x480
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 960x540
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t[1]: 'YUYV' (YUYV 4:2:2)
\t\tSize: Discrete 640x480
\t\t\tInterval: Discrete 0.033s (30.000 fps)
\t\tSize: Discrete 320x240
\t\t\tInterval: Discrete 0.033s (30.000 fps)
`);

    expect(formats).toMatchObject([
      {
        pixelFormat: "mjpeg",
        resolutions: [
          { width: 1280, height: 720, frameRates: ["30.000 fps"] },
          { width: 848, height: 480, frameRates: ["30.000 fps"] },
          { width: 960, height: 540, frameRates: ["30.000 fps"] },
        ],
      },
      {
        pixelFormat: "yuyv422",
        resolutions: [
          { width: 640, height: 480, frameRates: ["30.000 fps"] },
          { width: 320, height: 240, frameRates: ["30.000 fps"] },
        ],
      },
    ]);
  });

  it("normalizes JPEG aliases to mjpeg and YUYV to yuyv422", () => {
    const formats = parseCameraFormatsOutput(`
\t[0]: 'JPEG' (JPEG)
\t\tSize: Discrete 640x480
\t[1]: 'YUYV' (YUYV 4:2:2)
\t\tSize: Discrete 640x480
`);

    expect(formats.map((format) => format.pixelFormat)).toEqual(["mjpeg", "yuyv422"]);
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

describe("groupPhysicalCameras", () => {
  it("groups duplicate V4L2 nodes by stable ID and prefers the capture-capable node with formats", () => {
    const grouped = groupPhysicalCameras([
      {
        name: "Integrated Webcam",
        device: "/dev/video1",
        stableId: "usb:0c45:6a15:ABC",
        supportsCapture: false,
        formats: [],
      },
      {
        name: "Integrated Webcam",
        device: "/dev/video0",
        stableId: "usb:0c45:6a15:ABC",
        supportsCapture: true,
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].device).toBe("/dev/video0");
    expect(grouped[0].alternateDevices).toEqual([{ device: "/dev/video1", supportsCapture: false, reason: "not capture-capable" }]);
  });

  it("keeps identical duplicate-serial physical cameras separate when stable IDs include USB path", () => {
    const grouped = groupPhysicalCameras([
      {
        name: "webcam 1080P (1.3)",
        device: "/dev/video0",
        stableId: "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.3",
        supportsCapture: true,
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
      {
        name: "webcam 1080P (1.3)",
        device: "/dev/video1",
        stableId: "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.3",
        supportsCapture: false,
        formats: [],
      },
      {
        name: "webcam 1080P (1.2)",
        device: "/dev/video2",
        stableId: "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.2",
        supportsCapture: true,
        formats: [{ pixelFormat: "mjpeg", description: "Motion-JPEG", resolutions: [{ width: 1280, height: 720, frameRates: [] }] }],
      },
      {
        name: "webcam 1080P (1.2)",
        device: "/dev/video3",
        stableId: "usb:32e6:9221:202601081445001:path:platform-20980000.usb-usb-0:1.2",
        supportsCapture: false,
        formats: [],
      },
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ device: "/dev/video0", stableId: expect.stringContaining(":1.3") });
    expect(grouped[0].alternateDevices).toEqual([{ device: "/dev/video1", supportsCapture: false, reason: "not capture-capable" }]);
    expect(grouped[1]).toMatchObject({ device: "/dev/video2", stableId: expect.stringContaining(":1.2") });
    expect(grouped[1].alternateDevices).toEqual([{ device: "/dev/video3", supportsCapture: false, reason: "not capture-capable" }]);
  });
});

describe("capsIndicateVideoCapture", () => {
  // All three fixtures below are real `v4l2-ctl -d <device> --all` output
  // recorded from actual hardware (bokchoy's Integrated_Webcam_HD and
  // greenhouse-zero's Raspberry Pi ISP/codec devices), not hand-written -
  // this is the exact text that drove the real onboarding bugs being fixed.

  it("recognizes a real capture device (bokchoy /dev/video0)", () => {
    const output = [
      "Driver Info:",
      "\tDriver name      : uvcvideo",
      "\tCard type        : webcam 1080P: webcam 1080P",
      "\tBus info         : usb-20980000.usb-1.3",
      "\tDriver version   : 6.18.34",
      "\tCapabilities     : 0x84a00001",
      "\t\tVideo Capture",
      "\t\tMetadata Capture",
      "\t\tStreaming",
      "\t\tExtended Pix Format",
      "\t\tDevice Capabilities",
      "\tDevice Caps      : 0x04200001",
      "\t\tVideo Capture",
      "\t\tStreaming",
      "\t\tExtended Pix Format",
    ].join("\n");

    expect(capsIndicateVideoCapture(output)).toBe(true);
  });

  it("rejects a metadata-only node whose aggregate Capabilities block misleadingly lists Video Capture (bokchoy /dev/video1)", () => {
    const output = [
      "Driver Info:",
      "\tDriver name      : uvcvideo",
      "\tCard type        : Integrated_Webcam_HD: Integrate",
      "\tBus info         : usb-0000:00:14.0-5",
      "\tDriver version   : 7.0.6",
      "\tCapabilities     : 0x84a00001",
      "\t\tVideo Capture",
      "\t\tMetadata Capture",
      "\t\tStreaming",
      "\t\tExtended Pix Format",
      "\t\tDevice Capabilities",
      "\tDevice Caps      : 0x04a00000",
      "\t\tMetadata Capture",
      "\t\tStreaming",
      "\t\tExtended Pix Format",
    ].join("\n");

    expect(capsIndicateVideoCapture(output)).toBe(false);
  });

  it("rejects a memory-to-memory hardware codec device even though its format section header contains the literal substring 'Video Capture' (greenhouse-zero bcm2835-codec-decode)", () => {
    const output = [
      "Driver Info:",
      "\tDriver name      : bcm2835-codec",
      "\tCard type        : bcm2835-codec-decode",
      "\tBus info         : platform:bcm2835-codec",
      "\tDriver version   : 6.18.34",
      "\tCapabilities     : 0x84204000",
      "\t\tVideo Memory-to-Memory Multiplanar",
      "\t\tStreaming",
      "\t\tExtended Pix Format",
      "\t\tDevice Capabilities",
      "\tDevice Caps      : 0x04204000",
      "\t\tVideo Memory-to-Memory Multiplanar",
      "\t\tStreaming",
      "\t\tExtended Pix Format",
      "Priority: 2",
      "Format Video Capture Multiplanar:",
      "\tWidth/Height      : 32/32",
      "\tPixel Format      : 'YU12' (Planar YUV 4:2:0)",
    ].join("\n");

    expect(capsIndicateVideoCapture(output)).toBe(false);
  });

  it("returns false when neither a Device Caps nor Capabilities block is present", () => {
    expect(capsIndicateVideoCapture("Driver Info:\n\tDriver name      : nonsense\n")).toBe(false);
  });
});

import { AUTOFOCUS_CONTROL_ID, detectAutofocusSupport, MANUAL_FOCUS_CONTROL_ID } from "./autofocus";
import type { CameraControl, CameraFormat } from "./v4l2";

/**
 * These are standard V4L2/UVC control identifiers, not vendor-specific -
 * the same names are used across webcams from many manufacturers.
 */
export const AUTO_WHITE_BALANCE_CONTROL_ID = "white_balance_automatic";
export const MANUAL_WHITE_BALANCE_CONTROL_ID = "white_balance_temperature";
export const AUTO_EXPOSURE_CONTROL_ID = "exposure_auto";

export type CalibrationDriver = {
  listControls: () => Promise<CameraControl[]>;
  setControl: (control: string, value: string | number | boolean) => Promise<void>;
  listFormats: () => Promise<CameraFormat[]>;
};

export type CalibrationOptions = {
  currentFormat: string;
  currentWidth: number;
  currentHeight: number;
  /** Default 8000ms per the guided Auto Calibrate sequence. */
  settleMs?: number;
  /** Injectable so tests don't wait 8 real seconds. */
  wait?: (ms: number) => Promise<void>;
};

export type CalibrationStep = {
  step: string;
  applied: boolean;
  detail?: string;
};

export type CalibrationResult = {
  format: string;
  width: number;
  height: number;
  steps: CalibrationStep[];
  focusLocked: boolean;
  manualFocusValue: CameraControl["value"] | null;
  autoWhiteBalanceAvailable: boolean;
  autoExposureAvailable: boolean;
  controls: CameraControl[];
};

function findAutoMenuOption(control: CameraControl | undefined) {
  return control?.options?.find(
    (option) => /auto|priority/i.test(option.label) && !/manual/i.test(option.label),
  );
}

function findManualMenuOption(control: CameraControl | undefined) {
  return control?.options?.find((option) => /manual/i.test(option.label));
}

function defaultWait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the guided Auto Calibrate sequence using only controls this specific
 * camera actually reports. Does not capture any frames itself - the caller
 * is responsible for capturing non-gallery before/after preview frames
 * around this call, since frame capture and control changes both need the
 * shared camera lock and this function only touches controls/format
 * selection.
 */
export async function runAutoCalibration(
  driver: CalibrationDriver,
  options: CalibrationOptions,
): Promise<CalibrationResult> {
  const wait = options.wait ?? defaultWait;
  const steps: CalibrationStep[] = [];

  // 1. Prefer MJPEG 1920x1080 when supported, else preserve current format/resolution.
  const formats = await driver.listFormats();
  const mjpeg = formats.find((format) => format.pixelFormat === "mjpg" || format.pixelFormat === "mjpeg");
  const has1080p = mjpeg?.resolutions.some((resolution) => resolution.width === 1920 && resolution.height === 1080);
  const format = has1080p ? mjpeg!.pixelFormat : options.currentFormat;
  const width = has1080p ? 1920 : options.currentWidth;
  const height = has1080p ? 1080 : options.currentHeight;
  steps.push({
    step: "format",
    applied: Boolean(has1080p),
    detail: has1080p ? `${format} ${width}x${height}` : "kept current format/resolution (1920x1080 MJPEG unsupported)",
  });

  // 2. Reset supported writable controls to their reported defaults.
  let controls = await driver.listControls();
  for (const control of controls) {
    if (control.readOnly || control.inactive) {
      continue;
    }
    if (control.defaultValue === undefined || control.defaultValue === null) {
      continue;
    }
    if (control.value === control.defaultValue) {
      continue;
    }
    try {
      await driver.setControl(control.id, control.defaultValue as string | number | boolean);
    } catch {
      // Some controls reject their own reported default on certain drivers;
      // skip and continue calibrating rather than aborting the sequence.
    }
  }
  steps.push({ step: "reset-defaults", applied: true });

  // 3. Enable automatic white balance when supported.
  controls = await driver.listControls();
  const awbControl = controls.find(
    (control) => control.id === AUTO_WHITE_BALANCE_CONTROL_ID && control.type === "bool" && !control.readOnly,
  );
  if (awbControl) {
    await driver.setControl(AUTO_WHITE_BALANCE_CONTROL_ID, true);
  }
  steps.push({
    step: "auto-white-balance",
    applied: Boolean(awbControl),
    detail: awbControl ? undefined : "not reported by this camera",
  });

  // 4. Enable an automatic exposure mode when supported.
  controls = await driver.listControls();
  const exposureControl = controls.find(
    (control) => control.id === AUTO_EXPOSURE_CONTROL_ID && control.type === "menu" && !control.readOnly,
  );
  const autoExposureOption = findAutoMenuOption(exposureControl);
  if (exposureControl && autoExposureOption) {
    await driver.setControl(AUTO_EXPOSURE_CONTROL_ID, autoExposureOption.value);
  }
  steps.push({
    step: "auto-exposure",
    applied: Boolean(exposureControl && autoExposureOption),
    detail: autoExposureOption?.label ?? "not reported by this camera",
  });

  // 5. Enable autofocus when supported.
  controls = await driver.listControls();
  const autofocusSupport = detectAutofocusSupport(controls);
  if (autofocusSupport.supported) {
    await driver.setControl(AUTOFOCUS_CONTROL_ID, true);
  }
  steps.push({
    step: "autofocus-enable",
    applied: autofocusSupport.supported,
    detail: autofocusSupport.supported ? undefined : "not reported by this camera",
  });

  // 6. Settle.
  await wait(options.settleMs ?? 8_000);

  // 7. Lock focus by disabling autofocus, preserving the resulting manual value.
  let manualFocusValue: CameraControl["value"] | null = null;
  if (autofocusSupport.supported) {
    await driver.setControl(AUTOFOCUS_CONTROL_ID, false);
    controls = await driver.listControls();
    const manualFocusControl = controls.find((control) => control.id === MANUAL_FOCUS_CONTROL_ID);
    manualFocusValue = manualFocusControl?.value ?? null;
  } else {
    controls = await driver.listControls();
  }
  steps.push({
    step: "focus-lock",
    applied: autofocusSupport.supported,
    detail: manualFocusValue !== null ? `manual focus = ${manualFocusValue}` : undefined,
  });

  return {
    format,
    width,
    height,
    steps,
    focusLocked: autofocusSupport.supported,
    manualFocusValue,
    autoWhiteBalanceAvailable: Boolean(awbControl),
    autoExposureAvailable: Boolean(exposureControl && autoExposureOption),
    controls,
  };
}

/** Step 8: honor the user's choice to leave exposure/white balance automatic or lock them. */
export async function lockCalibrationAutoModes(
  driver: CalibrationDriver,
  choice: { lockWhiteBalance: boolean; lockExposure: boolean },
): Promise<CameraControl[]> {
  if (choice.lockWhiteBalance) {
    await driver.setControl(AUTO_WHITE_BALANCE_CONTROL_ID, false);
  }

  if (choice.lockExposure) {
    const controls = await driver.listControls();
    const exposureControl = controls.find((control) => control.id === AUTO_EXPOSURE_CONTROL_ID);
    const manualOption = findManualMenuOption(exposureControl);
    if (manualOption) {
      await driver.setControl(AUTO_EXPOSURE_CONTROL_ID, manualOption.value);
    }
  }

  return driver.listControls();
}

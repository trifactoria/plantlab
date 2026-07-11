import type { CameraControl } from "./v4l2";

/**
 * These are standard V4L2/UVC control identifiers (not vendor-specific) -
 * the same names appear across webcams from many manufacturers that expose
 * continuous autofocus over the Linux UVC driver.
 */
export const AUTOFOCUS_CONTROL_ID = "focus_automatic_continuous";
export const MANUAL_FOCUS_CONTROL_ID = "focus_absolute";

export type AutofocusDriver = {
  listControls: () => Promise<CameraControl[]>;
  setControl: (control: string, value: string | number | boolean) => Promise<void>;
};

export type AutofocusSupport = {
  supported: boolean;
  autofocusControl?: CameraControl;
  manualFocusControl?: CameraControl;
};

/** Whether this camera reports a writable continuous-autofocus control. */
export function detectAutofocusSupport(controls: CameraControl[]): AutofocusSupport {
  const autofocusControl = controls.find(
    (control) => control.id === AUTOFOCUS_CONTROL_ID && control.type === "bool" && !control.readOnly,
  );
  const manualFocusControl = controls.find((control) => control.id === MANUAL_FOCUS_CONTROL_ID);

  return { supported: Boolean(autofocusControl), autofocusControl, manualFocusControl };
}

export type AutofocusPreviousState = {
  autofocusValue: boolean;
  manualFocusValue: CameraControl["value"] | null;
};

export type AutofocusStartResult = {
  previous: AutofocusPreviousState;
  controls: CameraControl[];
};

/** Step 1-2: record prior state, then enable continuous autofocus. */
export async function startAutofocus(driver: AutofocusDriver): Promise<AutofocusStartResult> {
  const controls = await driver.listControls();
  const support = detectAutofocusSupport(controls);

  if (!support.supported || !support.autofocusControl) {
    throw new Error("This camera does not report a supported continuous-autofocus control.");
  }

  const previous: AutofocusPreviousState = {
    autofocusValue: Boolean(support.autofocusControl.value),
    manualFocusValue: support.manualFocusControl?.value ?? null,
  };

  await driver.setControl(AUTOFOCUS_CONTROL_ID, true);
  const reloaded = await driver.listControls();

  return { previous, controls: reloaded };
}

export type AutofocusLockResult = {
  controls: CameraControl[];
  manualFocusValue: CameraControl["value"] | null;
};

/** Step 5-7: disable autofocus to lock the resulting focus, then reload. */
export async function lockAutofocus(driver: AutofocusDriver): Promise<AutofocusLockResult> {
  await driver.setControl(AUTOFOCUS_CONTROL_ID, false);
  const controls = await driver.listControls();
  const manualFocusControl = controls.find((control) => control.id === MANUAL_FOCUS_CONTROL_ID);

  return { controls, manualFocusValue: manualFocusControl?.value ?? null };
}

/** Best-effort restoration of the autofocus/manual-focus state recorded before startAutofocus. */
export async function restoreAutofocus(
  driver: AutofocusDriver,
  previous: AutofocusPreviousState,
): Promise<CameraControl[]> {
  await driver.setControl(AUTOFOCUS_CONTROL_ID, previous.autofocusValue);

  if (!previous.autofocusValue && previous.manualFocusValue !== null && previous.manualFocusValue !== undefined) {
    await driver.setControl(MANUAL_FOCUS_CONTROL_ID, previous.manualFocusValue);
  }

  return driver.listControls();
}

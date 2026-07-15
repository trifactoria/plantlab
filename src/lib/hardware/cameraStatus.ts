export const CAMERA_STATUS_VALUES = ["available", "unavailable", "disabled", "retired", "node-offline"] as const;
export type CameraStatus = (typeof CAMERA_STATUS_VALUES)[number];

export type CameraStatusInput = {
  nodeOnline: boolean;
  cameraAvailable: boolean;
  cameraEnabled: boolean;
  cameraRetired: boolean;
  assignmentActive?: boolean | null;
  captureSourceActive?: boolean | null;
  currentEndpointAvailable?: boolean | null;
};

export type CameraStatusResult = {
  status: CameraStatus;
  usableForCapture: boolean;
  reason: string | null;
};

export function computeCameraStatus(input: CameraStatusInput): CameraStatusResult {
  if (input.cameraRetired) {
    return { status: "retired", usableForCapture: false, reason: "Camera is retired." };
  }
  if (!input.cameraEnabled) {
    return { status: "disabled", usableForCapture: false, reason: "Camera is disabled." };
  }
  if (!input.nodeOnline) {
    return { status: "node-offline", usableForCapture: false, reason: "Node is offline." };
  }
  if (input.captureSourceActive === false) {
    return { status: "unavailable", usableForCapture: false, reason: "Capture source is inactive." };
  }
  if (input.assignmentActive === false) {
    return { status: "unavailable", usableForCapture: false, reason: "Camera assignment is inactive." };
  }
  if (!input.cameraAvailable) {
    return { status: "unavailable", usableForCapture: false, reason: "Camera is not currently reported available." };
  }
  if (input.currentEndpointAvailable === false) {
    return { status: "unavailable", usableForCapture: false, reason: "No current available endpoint is reported." };
  }
  return { status: "available", usableForCapture: true, reason: null };
}

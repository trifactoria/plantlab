export function testCameraMockModeEnabled() {
  return process.env.PLANTLAB_TEST_LOCAL_CAMERA_UI === "1";
}

export function testCaptureMockModeEnabled() {
  return process.env.PLANTLAB_TEST_CAMERA_CAPTURE === "1";
}

export function testProjectCameraError() {
  return {
    error: "Test projects cannot access physical camera hardware.",
    status: 403,
  };
}

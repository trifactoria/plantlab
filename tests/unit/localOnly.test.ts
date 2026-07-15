import { afterEach, describe, expect, it, vi } from "vitest";
import { canDiscoverLocalCameraHardware, canManageFleetHardware, localCameraHardwareEnabled, productionLocalOnlyResponse } from "../../src/lib/localOnly";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localCameraHardwareEnabled", () => {
  it("is always enabled outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
    expect(localCameraHardwareEnabled()).toBe(true);

    vi.stubEnv("NODE_ENV", "test");
    expect(localCameraHardwareEnabled()).toBe(true);
  });

  it("is disabled by default in production - the safe default for anyone who deploys without configuring anything", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
    expect(localCameraHardwareEnabled()).toBe(false);
  });

  it("is enabled in production when PLANTLAB_LOCAL_CAMERA_ENABLED=1 - the documented production opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "1");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
    expect(localCameraHardwareEnabled()).toBe(true);
  });

  it("is enabled in production when the legacy PLANTLAB_TEST_LOCAL_CAMERA_UI=1 is set, for backward compatibility with existing test tooling", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "1");
    expect(localCameraHardwareEnabled()).toBe(true);
  });

  it('is not enabled by any other value than the literal string "1"', () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "true");
    expect(localCameraHardwareEnabled()).toBe(false);
  });
});

describe("fleet management capability", () => {
  it("is available even when local V4L discovery is disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");
    expect(canDiscoverLocalCameraHardware()).toBe(false);
    expect(canManageFleetHardware()).toBe(true);
  });
});

describe("productionLocalOnlyResponse", () => {
  it("returns null (not blocked) when camera hardware access is enabled", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(productionLocalOnlyResponse()).toBeNull();
  });

  it("returns a 403 JSON response when blocked", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");

    const response = productionLocalOnlyResponse();
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
    const payload = await response?.json();
    expect(payload.error).toContain("PLANTLAB_LOCAL_CAMERA_ENABLED");
  });
});

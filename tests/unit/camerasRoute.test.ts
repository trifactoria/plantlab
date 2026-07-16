import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as listLocalCameras } from "../../src/app/api/cameras/route";

describe("/api/cameras compatibility route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty list instead of a management-blocking error when local discovery is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLANTLAB_LOCAL_CAMERA_ENABLED", "");
    vi.stubEnv("PLANTLAB_TEST_LOCAL_CAMERA_UI", "");

    const response = await listLocalCameras();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cameras: [] });
  });
});

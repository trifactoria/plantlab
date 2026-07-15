import { expect, test } from "@playwright/test";
import { readNodeConfig, writeNodeConfig, writeNodeConfigRaw } from "../src/lib/operations/config";
import { cleanupVisualData, disconnectPrisma, mockCameraApis, seedVisualData } from "./helpers/devData";
import { goto } from "./helpers/navigation";

test.afterEach(async () => {
  await cleanupVisualData();
});

test.afterAll(async () => {
  await disconnectPrisma();
});

test("core CRUD screens render and open edit surfaces", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, "/");
  await expect(page.getByRole("link", { name: /PlantLab/ }).first()).toBeVisible();
  // The Projects tab is the default when no sensors are configured; the
  // existing project is listed there.
  await expect(page.getByRole("link", { name: "Playwright Radish Study" })).toBeVisible();

  // Project creation now happens in the New Project drawer rather than a
  // permanently-displayed form on the homepage.
  await page.getByTestId("new-project-button").click();
  const newProjectDrawer = page.getByRole("dialog", { name: "New Project" });
  await newProjectDrawer.getByLabel("Name").fill("Playwright Auto Folder Project");
  // Project creation selects a distributed CaptureSource, not a raw
  // /dev/video* path - no CaptureSource is configured in this fixture, so
  // "No camera" is the only real option and stays selected.
  await expect(page.getByTestId("capture-source-option-none")).toBeVisible();
  await expect(page.getByTestId("capture-source-option-none").locator('input[type="radio"]')).toBeChecked();
  await expect(newProjectDrawer.getByText("Create and use a PlantLab photo folder")).toBeVisible();
  await expect(newProjectDrawer.getByLabel("Planting date and time")).toBeVisible();
  await expect(newProjectDrawer.getByText("Planting date/time unknown")).toBeVisible();
  await expect(newProjectDrawer.getByLabel("Timezone")).toBeVisible();
  await expect(newProjectDrawer.getByLabel("Schedule anchor")).toBeVisible();
  await expect(newProjectDrawer.getByText(/Photos will be taken every 30 minutes/)).toBeVisible();
  await newProjectDrawer.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Playwright Auto Folder Project" })).toBeVisible();
  const createdProjectId = page.url().split("/").filter(Boolean).at(-1);
  if (createdProjectId) {
    await page.request.delete(`/api/projects/${createdProjectId}`);
  }

  const unknownPlantingResponse = await page.request.post("/api/projects", {
    data: {
      name: "Unknown Planting Project",
      description: "",
      gridWidth: 2,
      gridHeight: 2,
      photoIntervalMinutes: 30,
      captureStartAt: "2026-07-10T13:00:00.000Z",
      plantedAt: null,
      useDefaultPhotoDirectory: true,
      cameraDevice: "",
      cameraName: "",
    },
  });
  expect(unknownPlantingResponse.ok()).toBeTruthy();
  const unknownProject = await unknownPlantingResponse.json();
  expect(unknownProject.plantedAt).toBeNull();
  await page.request.delete(`/api/projects/${unknownProject.id}`);

  await goto(page, `/projects/${ids.projectId}`);
  await expect(page.getByRole("heading", { name: "Playwright Radish Study" })).toBeVisible();
  await expect(page.getByText("Planted")).toBeVisible();
  await expect(page.getByRole("link", { name: "Timeline" })).toBeVisible();
  await expect(page.getByText("June 2026")).toBeVisible();
  await expect(page.getByText("July 2026")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upload Photos" })).toBeVisible();

  await page.getByTestId("grid-cell-2-2").click();
  await expect(page.getByRole("heading", { name: "Create Plant" })).toBeVisible();
  await expect(page.getByText("Starting observation")).toBeVisible();
  await expect(page.getByLabel("Starting timestamp")).toBeVisible();
  await expect(page.getByPlaceholder("Or type a custom observation")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await goto(page, `/projects/${ids.projectId}/settings`);
  await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Settings" })).toBeVisible();
  // This fixture project has no camera (mode "none"), so the raw
  // Direct Local device picker stays hidden until that mode is chosen -
  // switch to it to confirm mockCameraApis' discovered camera still shows.
  await expect(page.getByRole("radio", { name: "No Camera" })).toBeChecked();
  await page.getByRole("radio", { name: "Direct Local" }).check();
  await expect(page.locator('select[name="cameraDevice"]')).toContainText("Mock USB Camera");
  await expect(page.getByLabel("Planting date and time")).toBeVisible();
  await expect(page.getByLabel("Timezone")).toBeVisible();
  await expect(page.getByLabel("Schedule anchor")).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/camera`);
  await expect(page.getByRole("heading", { name: "Camera Setup" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preview and Focus" })).toBeVisible();
  await expect(page.getByText("Preview is idle")).toBeVisible();
  await expect(page.getByRole("button", { name: "Autofocus Now" })).toBeVisible();
  await expect(page.getByText("Test project", { exact: true })).toBeVisible();
  await expect(page.getByText("Test projects cannot enable scheduled capture.")).toBeVisible();
  await expect(page.getByLabel("Input format")).toBeVisible();
  await expect(page.getByLabel("Resolution")).toBeVisible();
  await expect(page.getByLabel("Camera profile")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quick Calibration" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto Calibrate" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Capture Schedule" })).toBeVisible();
  await expect(page.getByText("Advanced Camera Controls")).toBeVisible();
  await page.getByText("Advanced Camera Controls").click();
  await expect(page.getByText("Exposure Auto")).toBeVisible();
  await expect(page.getByText("Inactive - a related automatic mode").first()).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/timeline`);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByText("First visible").first()).toBeVisible();
  await expect(page.getByText("First visible").first()).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/gallery/2026-07`);
  await expect(page.getByRole("heading", { name: "July 2026" })).toBeVisible();
  await expect(page.getByText("Friday, July 10, 2026")).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/gallery/2026-07/10`);
  await expect(page.getByRole("heading", { name: "Friday, July 10, 2026" })).toBeVisible();
  await expect(page.getByText("1 event")).toBeVisible();

  await goto(page, `/photos/${ids.photoId}`);
  await expect(page.getByRole("heading", { name: "Edit Photo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Linked Events" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quick Milestone Entry" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plant Crops" })).toBeVisible();
  await expect(page.getByText("Radish A").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Adjust Crop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Photo" }).click();
  await expect(page.getByRole("heading", { name: "Delete Photo" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("grid-cell-0-0").click();
  await expect(page.getByRole("heading", { name: "Add Event" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select crop from photo" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await goto(page, `/plants/${ids.plantId}`);
  await expect(page.getByRole("heading", { name: "Milestone Progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Visual History" })).toBeVisible();
  await expect(page.getByText("Frame 1 of 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit Plant" })).toBeVisible();
  await expect(page.getByText(/starting timestamp and observation are edited/)).toBeVisible();
  await expect(page.getByTestId("plant-timeline").getByText("Starting entry", { exact: true })).toBeVisible();

  await page.getByTestId("plant-timeline").getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByRole("heading", { name: /Edit Event|Origin Event/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("shelf camera mode picker preserves advertised format-resolution tuples", async ({ page }) => {
  await mockCameraApis(page);
  await page.route("**/api/capture-sources/*/formats**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        formats: [
          {
            pixelFormat: "mjpeg",
            description: "Motion-JPEG",
            resolutions: [
              { width: 3840, height: 2160, frameRates: ["15.000 fps"] },
              { width: 1920, height: 1080, frameRates: ["30.000 fps"] },
            ],
          },
          {
            pixelFormat: "yuyv422",
            description: "YUYV 4:2:2",
            resolutions: [{ width: 640, height: 480, frameRates: ["30.000 fps"] }],
          },
        ],
      }),
    });
  });
  const ids = await seedVisualData();
  await page.request.patch(`/api/capture-sources/${ids.captureSourceId}`, {
    data: {
      width: 640,
      height: 480,
      assignmentWidth: 640,
      assignmentHeight: 480,
      inputFormat: "yuyv422",
    },
  });

  await goto(page, `/capture-sources/${ids.captureSourceId}`);
  await expect(page.getByTestId("raw-resolution-select").locator("option", { hasText: "MJPEG - 1920x1080 - 30.000 fps" })).toHaveCount(1);
  const shelfModes = await page.getByTestId("raw-resolution-select").locator("option").allTextContents();

  expect(shelfModes).toContain("MJPEG - 1920x1080 - 30.000 fps");
  expect(shelfModes).toContain("YUYV - 640x480 - 30.000 fps");
  expect(shelfModes).not.toContain("MJPEG - 640x480 - 30.000 fps");
  await expect(page.getByTestId("preferred-mode-repair")).toContainText("Preferred verified mode is available: MJPEG - 3840x2160 - 15.000 fps");
});

test("shelf camera mode picker warns when capability inventory is missing instead of showing a fake verified fallback", async ({ page }) => {
  await mockCameraApis(page);
  await page.route("**/api/capture-sources/*/formats**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ formats: [] }),
    });
  });
  const ids = await seedVisualData();
  await page.request.patch(`/api/capture-sources/${ids.captureSourceId}`, {
    data: {
      width: 640,
      height: 480,
      assignmentWidth: 640,
      assignmentHeight: 480,
      inputFormat: "mjpeg",
    },
  });

  await goto(page, `/capture-sources/${ids.captureSourceId}`);

  await expect(page.getByTestId("missing-capability-warning")).toContainText("Camera capability data is unavailable.");
  await expect(page.getByRole("button", { name: "Refresh Inventory" })).toBeVisible();
  await expect(page.getByTestId("raw-resolution-select")).toBeDisabled();
  await expect(page.getByTestId("raw-resolution-select")).toContainText("Capability data unavailable");
  await expect(page.getByTestId("raw-resolution-select")).not.toContainText("MJPEG - 640x480");
  await expect(page.getByRole("button", { name: "Save Shelf Camera Settings" })).toBeDisabled();

  await page.getByRole("button", { name: "Use Unverified Fallback" }).click();
  await expect(page.getByTestId("raw-resolution-select")).toBeEnabled();
  await expect(page.getByTestId("raw-resolution-select")).toContainText("Unverified fallback - MJPEG - 640x480");
});

test("repeated grid entry remembers timestamp/tags and proposes the next name, scoped per project", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, `/projects/${ids.projectId}`);

  await page.getByTestId("grid-cell-2-0").click();
  await expect(page.getByRole("heading", { name: "Create Plant" })).toBeVisible();
  await page.getByLabel("Name").fill("TestSeq1");
  await page.getByLabel("Tags", { exact: true }).fill("batchA");
  await page.getByLabel("Tags", { exact: true }).press("Enter");
  await expect(page.getByText("batchA")).toBeVisible();
  await page.getByLabel("Starting timestamp").fill("2026-07-11T09:00");
  const savedTimestamp = await page.getByLabel("Starting timestamp").inputValue();

  await page.getByRole("button", { name: "Save and add next" }).click();

  await expect(page.getByRole("heading", { name: "Create Plant" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("TestSeq2");
  await expect(page.getByLabel("Starting timestamp")).toHaveValue(savedTimestamp);
  await expect(page.getByText("batchA")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  const isolationProjectResponse = await page.request.post("/api/projects", {
    data: {
      name: "Isolation Test Project",
      description: "",
      gridWidth: 1,
      gridHeight: 1,
      photoIntervalMinutes: 30,
      captureStartAt: "2026-07-10T13:00:00.000Z",
      plantedAt: null,
      useDefaultPhotoDirectory: true,
      cameraDevice: "",
      cameraName: "",
    },
  });
  const isolationProject = await isolationProjectResponse.json();

  await goto(page, `/projects/${isolationProject.id}`);
  await page.getByTestId("grid-cell-0-0").click();
  await expect(page.getByRole("heading", { name: "Create Plant" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("");
  await expect(page.getByText("batchA")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.request.delete(`/api/projects/${isolationProject.id}`);
});

test("photo upload and crop safety flows", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, `/projects/${ids.projectId}`);
  await page.getByLabel("Images").setInputFiles([
    {
      name: "phone-photo.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
        "base64",
      ),
    },
    {
      name: "unsupported.gif",
      mimeType: "image/gif",
      buffer: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    },
  ]);
  await page.getByRole("button", { name: "Upload Photos" }).click();
  await expect(page.getByText("phone-photo.jpg")).toBeVisible();
  await expect(page.getByText("from file date")).toBeVisible();
  await expect(page.getByText("Unsupported image format")).toBeVisible();

  const cropResponse = await page.request.get(`/api/events/${ids.eventId}/crop`);
  expect(cropResponse.ok()).toBeTruthy();
  expect(cropResponse.headers()["content-type"]).toContain("image/jpeg");

  const patchResponse = await page.request.patch(`/api/events/${ids.eventId}`, {
    data: {
      type: "Germinated",
      notes: "Crop removed with photo unlink.",
      timestamp: "2026-07-10T13:30:00.000Z",
      photoId: null,
    },
  });
  expect(patchResponse.ok()).toBeTruthy();
  const eventResponse = await page.request.get(`/api/events/${ids.eventId}`);
  const eventPayload = await eventResponse.json();
  expect(eventPayload.photoId).toBeNull();
  expect(eventPayload.cropX).toBeNull();

  await seedVisualData();
  const deletePhotoResponse = await page.request.delete(`/api/photos/${ids.photoId}`);
  expect(deletePhotoResponse.ok()).toBeTruthy();
  const unlinkedEventResponse = await page.request.get(`/api/events/${ids.eventId}`);
  const unlinkedEvent = await unlinkedEventResponse.json();
  expect(unlinkedEvent.photoId).toBeNull();
  expect(unlinkedEvent.cropX).toBeNull();
});

test("plant visual history: crop editor, scrubber, playback, and events", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  // Empty visual-history state for the plant with no saved crops yet.
  await goto(page, `/plants/${ids.secondPlantId}`);
  await expect(page.getByText("No visual history yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Choose a Project Photo" })).toBeVisible();

  // Set a new plant crop from the photo page, using the crop editor.
  await goto(page, `/photos/${ids.photoId}`);
  await page.getByLabel("Add plant crop").selectOption(ids.secondPlantId);
  await page.getByRole("button", { name: "Set Plant Crop" }).click();
  await expect(page.getByText("Set Initial Crop - Radish B")).toBeVisible();
  await expect(page.getByRole("button", { name: "Landscape 16:9" })).toBeVisible();

  const stage = page.getByTestId("crop-editor-stage");
  await stage.waitFor();
  await expect
    .poll(() => stage.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth > 0))
    .toBe(true);
  const box = await stage.boundingBox();
  if (!box) {
    throw new Error("crop editor stage did not render");
  }
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.35, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText(/Relative sharpness/)).toBeVisible();
  const previewRatio = await page.getByTestId("crop-preview-canvas").evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement;
    return element.width / element.height;
  });
  expect(previewRatio).toBeCloseTo(16 / 9, 1);

  await page.getByRole("button", { name: "Set initial crop" }).click();
  await expect(page.getByText("Initial crop set.")).toBeVisible();

  // Setting the initial crop creates a crop version, which automatically
  // applies to this and every later project photo - not just the one
  // frame it was drawn on.
  await goto(page, `/plants/${ids.secondPlantId}`);
  await expect(page.getByText("Frame 1 of 2")).toBeVisible();
  await expect
    .poll(async () =>
      page.getByTestId("visual-history-frame").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width / rect.height;
      }),
    )
    .toBeCloseTo(16 / 9, 1);

  // Radish A has three chronological frames with a real capture gap.
  await goto(page, `/plants/${ids.plantId}`);
  await expect(page.getByText("Frame 1 of 3")).toBeVisible();
  await expect
    .poll(async () =>
      page.getByTestId("visual-history-frame").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width / rect.height;
      }),
    )
    .toBeGreaterThan(1.4);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Frame 2 of 3")).toBeVisible();
  await expect(page.getByText("Events on this frame")).toBeVisible();
  await expect(page.getByText("First visible").first()).toBeVisible();

  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("Frame 1 of 3")).toBeVisible();

  // Dragging the scrubber near the right edge jumps to the last frame.
  const track = page.getByTestId("visual-history-track");
  const trackBox = await track.boundingBox();
  if (!trackBox) {
    throw new Error("visual history track did not render");
  }
  await page.mouse.click(trackBox.x + trackBox.width * 0.97, trackBox.y + trackBox.height / 2);
  await expect(page.getByText("Frame 3 of 3")).toBeVisible();
  await expect
    .poll(async () =>
      page.getByTestId("visual-history-frame").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width / rect.height;
      }),
    )
    .toBeLessThan(0.8);

  // Playback controls toggle without autoplaying by default.
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  // Add an event directly from the current frame.
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("Frame 2 of 3")).toBeVisible();
  await page.getByRole("button", { name: "Record Observation" }).click();
  const addEventForm = page.getByTestId("observation-form");
  await addEventForm.getByPlaceholder("Or type a custom observation").fill("Side shoot pinched");
  await addEventForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Side shoot pinched").first()).toBeVisible();
});

test("crop shape controls preserve preview proportions", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, `/photos/${ids.photoId}`);
  await page.getByRole("button", { name: "Adjust Crop" }).first().click();
  await expect(page.getByText("Set Initial Crop - Radish A")).toBeVisible();

  await page.getByRole("button", { name: "Portrait 9:16" }).click();
  await expect
    .poll(async () =>
      page.getByTestId("crop-preview-canvas").evaluate((canvas) => {
        const element = canvas as HTMLCanvasElement;
        return element.width / element.height;
      }),
    )
    .toBeCloseTo(9 / 16, 1);

  await page.getByRole("button", { name: "Square 1:1" }).click();
  await expect
    .poll(async () =>
      page.getByTestId("crop-preview-canvas").evaluate((canvas) => {
        const element = canvas as HTMLCanvasElement;
        return element.width / element.height;
      }),
    )
    .toBeCloseTo(1, 1);

  await page.getByRole("button", { name: "Free" }).click();
  await expect(page.getByText(/Existing saved crops keep/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("experiment milestones, comparison, and harvest result flows", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, `/photos/${ids.photoId}`);
  const quick = page.getByTestId("quick-milestone-entry").first();
  await quick.getByLabel("Plant").selectOption(ids.secondPlantId);
  await quick.getByRole("button", { name: "First visible" }).click();
  await expect(quick.getByText("Event saved.")).toBeVisible();
  await quick.getByRole("button", { name: /First visible/ }).click();
  await expect(quick.getByText(/already has this milestone/)).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/comparison`);
  await expect(page.getByRole("heading", { name: "Comparison" })).toBeVisible();
  await expect(page.getByText("Project planting date").first()).toBeVisible();
  await page.getByRole("link", { name: "First true leaf" }).click();
  await expect(page).toHaveURL(/sort=first_true_leaf/);

  await goto(page, `/projects/${ids.projectId}/settings`);
  await expect(page.getByRole("heading", { name: "Milestones" })).toBeVisible();
  const settings = page.getByTestId("project-milestone-settings");
  await settings.locator('input[value="First visible"]').fill("Visible sprout");
  await settings.getByRole("button", { name: "Save" }).first().click();
  await expect(settings.getByText("Milestone saved.")).toBeVisible();

  await goto(page, `/plants/${ids.plantId}`);
  await expect(page.getByText(/g\/day/)).toBeVisible();
  await page.getByLabel("Root weight grams").fill("20");
  await page.getByRole("button", { name: "Save Harvest Result" }).click();
  await expect(page.getByText("This plant has a harvest result without a Harvested event.")).toBeVisible();
  await page.getByRole("button", { name: "Save Anyway" }).click();
  await expect(page.getByText("Harvest result saved.")).toBeVisible();
});

test("guided project crop setup, legacy adoption, and visual-history sync", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, `/projects/${ids.projectId}`);
  await expect(page.getByRole("heading", { name: "Crop Setup" })).toBeVisible();
  await expect(page.getByText("0 of 2 plants configured")).toBeVisible();

  await page.getByRole("link", { name: "Configure Project Crops" }).first().click();
  await expect(page.getByRole("heading", { name: "Configure Project Crops" })).toBeVisible();
  await expect(page.getByTestId("crop-setup-progress")).toContainText("Plant 1 of 2");

  // Radish A (grid order first) has legacy PlantPhotoCrop rows but no crop
  // version yet - its exact existing crop should be prefilled so the user
  // can confirm without redrawing.
  await expect(page.getByText("Legacy crop only").first()).toBeVisible();
  await page.getByRole("button", { name: "Use This Existing Crop From This Frame Forward" }).click();

  // Advances automatically to Radish B, which has no crop history at all.
  await expect(page.getByTestId("crop-setup-progress")).toContainText("Plant 2 of 2");
  await expect(page.getByText("Not configured").first()).toBeVisible();

  const stage = page.getByTestId("crop-editor-stage");
  await stage.waitFor();
  await expect
    .poll(() => stage.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth > 0))
    .toBe(true);
  const box = await stage.boundingBox();
  if (!box) {
    throw new Error("crop editor stage did not render");
  }
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Set Initial Crop & Next" }).click();

  await expect(page.getByTestId("crop-setup-complete")).toBeVisible();
  await expect(page.getByText("2 of 2 plants configured")).toBeVisible();
  await expect(page.getByText(/automatically receives that crop/)).toBeVisible();

  await page.getByRole("link", { name: "Back to Project" }).click();
  await expect(page.getByText("2 of 2 plants configured")).toBeVisible();

  await page.getByRole("button", { name: "Sync Visual Histories" }).click();
  await expect(page.getByText("Visual histories synchronized")).toBeVisible();
  await expect(page.getByText("2 configured")).toBeVisible();
  await expect(page.getByText("0 failures")).toBeVisible();
});

test.describe("unified dashboard", () => {
  // The dashboard is intentionally identical in both modes: one Nodes table
  // with the current install as the first ("This install") row, then the same
  // tab bar. The coordinator differs only by having more node rows.
  test("standalone shows the self row in the unified Nodes table with Standalone mode", async ({ page }) => {
    const original = await readNodeConfig();
    await writeNodeConfig("standalone");
    try {
      await goto(page, "/");
      await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
      const selfRow = page.locator("tr", { hasText: "This install" });
      await expect(selfRow).toBeVisible();
      await expect(selfRow).toContainText("Standalone");
      // Same tab bar as coordinator mode.
      await expect(page.getByTestId("dashboard-tab-environment")).toBeVisible();
      await expect(page.getByTestId("dashboard-tab-system")).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });

  test("coordinator shows the same table and tabs with a Coordinator self row", async ({ page }) => {
    const original = await readNodeConfig();
    await writeNodeConfig("coordinator");
    try {
      await goto(page, "/");
      await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
      const selfRow = page.locator("tr", { hasText: "This install" });
      await expect(selfRow).toContainText("Coordinator");
      await expect(page.getByTestId("dashboard-tab-projects")).toBeVisible();
      await expect(page.getByTestId("dashboard-tab-power")).toBeVisible();
      await expect(page.getByTestId("dashboard-tab-cameras")).toBeVisible();
    } finally {
      if (original) await writeNodeConfigRaw(original);
    }
  });
});

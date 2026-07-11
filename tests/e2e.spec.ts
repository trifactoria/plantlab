import { expect, test } from "@playwright/test";
import { disconnectPrisma, mockCameraApis, seedVisualData } from "./helpers/devData";
import { goto } from "./helpers/navigation";

test.afterAll(async () => {
  await disconnectPrisma();
});

test("core CRUD screens render and open edit surfaces", async ({ page }) => {
  await mockCameraApis(page);
  const ids = await seedVisualData();

  await goto(page, "/");
  await expect(page.getByRole("heading", { name: "Local plant experiment tracker" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Playwright Radish Study" })).toBeVisible();

  await page.getByLabel("Name").fill("Playwright Auto Folder Project");
  await expect(page.getByLabel("Camera")).toContainText("Mock USB Camera");
  await page.getByLabel("Camera").selectOption("/dev/video-test");
  await expect(page.getByText("Create and use a PlantLab photo folder")).toBeVisible();
  await expect(page.getByLabel("Planting date and time")).toBeVisible();
  await expect(page.getByText("Planting date/time unknown")).toBeVisible();
  await expect(page.getByLabel("Schedule starting date and time")).toBeVisible();
  await page.getByRole("button", { name: "Create Project" }).click();
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
  await expect(page.getByLabel("Initial event label")).toBeVisible();
  await expect(page.getByLabel("Initial timestamp")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await goto(page, `/projects/${ids.projectId}/settings`);
  await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Settings" })).toBeVisible();
  await expect(page.getByLabel("Camera")).toContainText("Mock USB Camera");
  await expect(page.getByLabel("Planting date and time")).toBeVisible();
  await expect(page.getByLabel("Schedule starting date and time")).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/camera`);
  await expect(page.getByRole("heading", { name: "Camera Setup" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preview and Focus" })).toBeVisible();
  await expect(page.getByText("Preview is idle")).toBeVisible();
  await expect(page.getByRole("button", { name: "Autofocus Now" })).toBeVisible();
  await expect(page.getByLabel("Input format")).toContainText("MJPG");
  await expect(page.getByLabel("Resolution")).toContainText("1920 x 1080");
  await expect(page.getByLabel("Camera profile")).toContainText("Mock Germination Profile");
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
  await expect(page.getByText("Germinated").first()).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/gallery/2026-07`);
  await expect(page.getByRole("heading", { name: "July 2026" })).toBeVisible();
  await expect(page.getByText("Friday, July 10, 2026")).toBeVisible();

  await goto(page, `/projects/${ids.projectId}/gallery/2026-07/10`);
  await expect(page.getByRole("heading", { name: "Friday, July 10, 2026" })).toBeVisible();
  await expect(page.getByText("1 event")).toBeVisible();

  await goto(page, `/photos/${ids.photoId}`);
  await expect(page.getByRole("heading", { name: "Edit Photo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Linked Events" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Photo" }).click();
  await expect(page.getByRole("heading", { name: "Delete Photo" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("grid-cell-0-0").click();
  await expect(page.getByRole("heading", { name: "Add Event" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select crop from photo" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await goto(page, `/plants/${ids.plantId}`);
  await expect(page.getByRole("heading", { name: "Edit Plant" })).toBeVisible();
  await expect(page.getByLabel("Initial event label")).toBeVisible();
  await expect(page.getByLabel("Initial timestamp")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByRole("heading", { name: "Edit Event" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select crop from photo" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
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

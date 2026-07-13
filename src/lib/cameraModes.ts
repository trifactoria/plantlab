export type CameraFormatResolution = {
  width: number;
  height: number;
  frameRates: string[];
};

export type CameraFormat = {
  pixelFormat: string;
  description: string;
  resolutions: CameraFormatResolution[];
};

export type CameraMode = {
  inputFormat: string;
  width: number;
  height: number;
  frameRates: string[];
};

export function normalizeCameraInputFormat(format: string | null | undefined): string {
  const normalized = (format ?? "").trim().toLowerCase();
  if (normalized === "mjpg" || normalized === "mjpeg" || normalized === "jpeg") return "mjpeg";
  if (normalized === "yuyv" || normalized === "yuyv422") return "yuyv422";
  return normalized || "mjpeg";
}

export function formatLabel(inputFormat: string): string {
  const normalized = normalizeCameraInputFormat(inputFormat);
  if (normalized === "mjpeg") return "MJPEG";
  if (normalized === "yuyv422") return "YUYV";
  return normalized.toUpperCase();
}

export function normalizeCameraFormats(formats: CameraFormat[]): CameraFormat[] {
  const byFormat = new Map<string, CameraFormat>();

  for (const format of formats) {
    const pixelFormat = normalizeCameraInputFormat(format.pixelFormat);
    const existing = byFormat.get(pixelFormat);
    const target =
      existing ??
      {
        pixelFormat,
        description: format.description,
        resolutions: [],
      };

    if (!existing) byFormat.set(pixelFormat, target);

    for (const resolution of format.resolutions) {
      const duplicate = target.resolutions.find((candidate) => candidate.width === resolution.width && candidate.height === resolution.height);
      if (duplicate) {
        duplicate.frameRates = Array.from(new Set([...duplicate.frameRates, ...resolution.frameRates]));
      } else {
        target.resolutions.push({
          width: resolution.width,
          height: resolution.height,
          frameRates: Array.from(new Set(resolution.frameRates)),
        });
      }
    }
  }

  return Array.from(byFormat.values());
}

export function flattenCameraModes(formats: CameraFormat[]): CameraMode[] {
  return normalizeCameraFormats(formats).flatMap((format) =>
    format.resolutions.map((resolution) => ({
      inputFormat: format.pixelFormat,
      width: resolution.width,
      height: resolution.height,
      frameRates: resolution.frameRates,
    })),
  );
}

function bestFpsScore(frameRates: string[]): number {
  if (frameRates.some((rate) => /(?:^|\D)30(?:\.0+)?\s*fps/i.test(rate))) return 2;
  if (frameRates.length > 0) return 1;
  return 0;
}

export function preferredCameraMode(formats: CameraFormat[]): CameraMode | null {
  const modes = flattenCameraModes(formats);
  if (modes.length === 0) return null;

  return [...modes].sort((a, b) => {
    const formatScore = Number(b.inputFormat === "mjpeg") - Number(a.inputFormat === "mjpeg");
    if (formatScore !== 0) return formatScore;

    const areaScore = b.width * b.height - a.width * a.height;
    if (areaScore !== 0) return areaScore;

    const fpsScore = bestFpsScore(b.frameRates) - bestFpsScore(a.frameRates);
    if (fpsScore !== 0) return fpsScore;

    return `${a.inputFormat}:${a.width}x${a.height}`.localeCompare(`${b.inputFormat}:${b.width}x${b.height}`);
  })[0];
}

export function findCameraMode(
  formats: CameraFormat[],
  inputFormat: string,
  width: number,
  height: number,
): CameraMode | null {
  const normalized = normalizeCameraInputFormat(inputFormat);
  return flattenCameraModes(formats).find((mode) => mode.inputFormat === normalized && mode.width === width && mode.height === height) ?? null;
}

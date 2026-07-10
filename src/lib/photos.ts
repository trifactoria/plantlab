import path from "node:path";

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

export function isImageFile(filename: string) {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function buildPhotoPath(directory: string, filenameOrPath: string) {
  if (path.isAbsolute(filenameOrPath)) {
    return path.normalize(filenameOrPath);
  }

  return path.resolve(directory, filenameOrPath);
}

export function contentTypeFor(filename: string) {
  const extension = path.extname(filename).toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export function parsePhotoTimestampFromFilename(filename: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(
    filename,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export function formatLocalTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-")
    + "_"
    + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(
      "-",
    );
}

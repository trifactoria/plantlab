export type GalleryPhoto = {
  id: string;
  timestamp: Date;
};

export function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function dayKey(date: Date) {
  return `${monthKey(date)}-${String(date.getDate()).padStart(2, "0")}`;
}

export function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1));
}

export function dayLabel(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    dateStyle: "full",
  }).format(new Date(year, month - 1, day));
}

export function localDayRange(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);

  return { start, end };
}

export function localMonthRange(key: string) {
  const [year, month] = key.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  return { start, end };
}

export function groupPhotosByMonth(photos: GalleryPhoto[]) {
  const groups = new Map<string, GalleryPhoto[]>();

  for (const photo of photos) {
    const key = monthKey(photo.timestamp);
    groups.set(key, [...(groups.get(key) ?? []), photo]);
  }

  return Array.from(groups.entries())
    .map(([key, monthPhotos]) => {
      const days = new Set(monthPhotos.map((photo) => dayKey(photo.timestamp)));
      return {
        key,
        label: monthLabel(key),
        photoCount: monthPhotos.length,
        dayCount: days.size,
        representativePhoto: monthPhotos[0],
      };
    })
    .sort((a, b) => b.key.localeCompare(a.key));
}

export function groupPhotosByDay(photos: GalleryPhoto[]) {
  const groups = new Map<string, GalleryPhoto[]>();

  for (const photo of photos) {
    const key = dayKey(photo.timestamp);
    groups.set(key, [...(groups.get(key) ?? []), photo]);
  }

  return Array.from(groups.entries())
    .map(([key, dayPhotos]) => {
      const sorted = [...dayPhotos].sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
      );
      const last = sorted[sorted.length - 1];

      return {
        key,
        label: dayLabel(key),
        photoCount: sorted.length,
        representativePhoto: sorted[0],
        firstCaptureAt: last.timestamp,
        lastCaptureAt: sorted[0].timestamp,
      };
    })
    .sort((a, b) => b.key.localeCompare(a.key));
}

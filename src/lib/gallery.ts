import {
  dayLabelInZone,
  localDateKey,
  localDayRangeUtc,
  localMonthKey,
  localMonthRangeUtc,
  monthLabelInZone,
} from "./timezone";

export type GalleryPhoto = {
  id: string;
  timestamp: Date;
};

export function monthKey(date: Date, timeZone: string) {
  return localMonthKey(date, timeZone);
}

export function dayKey(date: Date, timeZone: string) {
  return localDateKey(date, timeZone);
}

export function monthLabel(key: string, timeZone: string) {
  return monthLabelInZone(key, timeZone);
}

export function dayLabel(key: string, timeZone: string) {
  return dayLabelInZone(key, timeZone);
}

export function localDayRange(key: string, timeZone: string) {
  return localDayRangeUtc(key, timeZone);
}

export function localMonthRange(key: string, timeZone: string) {
  return localMonthRangeUtc(key, timeZone);
}

export function groupPhotosByMonth(photos: GalleryPhoto[], timeZone: string) {
  const groups = new Map<string, GalleryPhoto[]>();

  for (const photo of photos) {
    const key = monthKey(photo.timestamp, timeZone);
    groups.set(key, [...(groups.get(key) ?? []), photo]);
  }

  return Array.from(groups.entries())
    .map(([key, monthPhotos]) => {
      const days = new Set(monthPhotos.map((photo) => dayKey(photo.timestamp, timeZone)));
      return {
        key,
        label: monthLabel(key, timeZone),
        photoCount: monthPhotos.length,
        dayCount: days.size,
        representativePhoto: monthPhotos[0],
      };
    })
    .sort((a, b) => b.key.localeCompare(a.key));
}

export function groupPhotosByDay(photos: GalleryPhoto[], timeZone: string) {
  const groups = new Map<string, GalleryPhoto[]>();

  for (const photo of photos) {
    const key = dayKey(photo.timestamp, timeZone);
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
        label: dayLabel(key, timeZone),
        photoCount: sorted.length,
        representativePhoto: sorted[0],
        firstCaptureAt: last.timestamp,
        lastCaptureAt: sorted[0].timestamp,
      };
    })
    .sort((a, b) => b.key.localeCompare(a.key));
}

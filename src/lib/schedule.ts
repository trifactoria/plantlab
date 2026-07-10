export function nextAlignedCaptureTime({
  startAt,
  intervalMinutes,
  now = new Date(),
}: {
  startAt: Date;
  intervalMinutes: number;
  now?: Date;
}) {
  const intervalMs = intervalMinutes * 60_000;

  if (intervalMs <= 0) {
    throw new Error("intervalMinutes must be positive");
  }

  if (startAt.getTime() > now.getTime()) {
    return startAt;
  }

  const elapsed = now.getTime() - startAt.getTime();
  const intervalsElapsed = Math.floor(elapsed / intervalMs) + 1;

  return new Date(startAt.getTime() + intervalsElapsed * intervalMs);
}

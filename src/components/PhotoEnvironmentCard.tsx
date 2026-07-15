import { celsiusToFahrenheit } from "@/lib/greenhouseDisplay";
import { formatDateTime } from "@/lib/format";

export type PhotoEnvironmentReading = {
  binding: { id: string; label: string | null; role: string; sensor: { name: string } };
  reading: { distanceMs: number; temperatureC: number; humidityPct: number } | null;
};

/**
 * Compact photo-detail sidebar card showing the nearest environmental
 * reading (within nearestPhotoEnvironment's match window - see
 * src/lib/operations/projectSensors.ts) for each sensor linked to the
 * photo's project. Server-rendered from data the photo page already
 * fetches; never fabricates a value for a sensor that had no reading in
 * range.
 */
export function PhotoEnvironmentCard({ capturedAt, readings }: { capturedAt: string; readings: PhotoEnvironmentReading[] }) {
  const anyMatch = readings.some((item) => item.reading !== null);

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm" data-testid="photo-environment-card">
      <h2 className="text-lg font-semibold text-stone-950">Environment</h2>
      <p className="mt-1 text-xs text-stone-500">Captured: {formatDateTime(capturedAt)}</p>

      {readings.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">No environmental sensors are linked to this project.</p>
      ) : !anyMatch ? (
        <p className="mt-3 text-sm text-stone-600">No nearby environmental reading.</p>
      ) : (
        <div className="mt-3 grid gap-2">
          {readings.map(({ binding, reading }) => (
            <div key={binding.id} data-testid={`photo-environment-reading-${binding.id}`} className="rounded-md border border-stone-200 p-2 text-sm">
              <p className="font-medium text-stone-950">{binding.label ?? binding.sensor.name}</p>
              {reading ? (
                <>
                  <p className="text-stone-700">
                    {celsiusToFahrenheit(reading.temperatureC).toFixed(1)}&deg;F / {reading.humidityPct.toFixed(0)}%
                  </p>
                  <p className="text-xs text-stone-500">Matched within {Math.round(reading.distanceMs / 1000)} seconds</p>
                </>
              ) : (
                <p className="text-stone-500">No nearby environmental reading.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

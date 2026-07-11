// Shared fetch + warning-confirm handling for PlantEvent mutations, used by
// both ObservationForm and QuickMilestoneEntry so there is exactly one
// client-side implementation of "create/update/delete an observation".

export type PlantEventResponse = {
  id: string;
  plantId: string;
  photoId: string | null;
  milestoneId: string | null;
  kind: string;
  type: string;
  notes: string | null;
  timestamp: string;
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
};

export type ObservationMutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; warnings: string[] }
  | { ok: false; error: string };

async function parseMutationResponse<T>(response: Response): Promise<ObservationMutationResult<T>> {
  if (response.status === 409) {
    const payload = (await response.json()) as { warnings: string[] };
    return { ok: false, warnings: payload.warnings };
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: payload.error ?? "Could not save event." };
  }

  const data = (await response.json()) as T;
  return { ok: true, data };
}

export async function createObservation(
  payload: Record<string, unknown>,
  confirmWarnings = false,
): Promise<ObservationMutationResult<PlantEventResponse>> {
  const response = await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, confirmWarnings }),
  });
  return parseMutationResponse<PlantEventResponse>(response);
}

export async function updateObservation(
  eventId: string,
  payload: Record<string, unknown>,
  confirmWarnings = false,
): Promise<ObservationMutationResult<PlantEventResponse>> {
  const response = await fetch(`/api/events/${eventId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, confirmWarnings }),
  });
  return parseMutationResponse<PlantEventResponse>(response);
}

export async function deleteObservation(eventId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetch(`/api/events/${eventId}`, { method: "DELETE" });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: payload.error ?? "Could not delete event." };
  }

  return { ok: true };
}

/**
 * Client helper for the power state history API
 * (GET /api/nodes/:nodeName/power/history - see
 * src/lib/operations/powerHistory.ts). Deliberately generic: it knows about
 * "outlet tracks" as opaque on/off timelines, never about lights/fans/water
 * specifically, so the same normalized shape can later back irrigation,
 * pumps, or CO2 lanes on any shared timeline overlay.
 */

export type PowerTrackSegment = { from: number; to: number; state: boolean };
export type PowerTrackGap = { from: number; to: number };

export type NormalizedPowerTrack = {
  outletId: string;
  outletKey: string;
  label: string;
  enabled: boolean;
  available: boolean;
  initialState: boolean | null;
  segments: PowerTrackSegment[];
  gaps: PowerTrackGap[];
};

export type PowerHistoryFetchResult =
  | { ok: true; rangeFrom: number; rangeTo: number; tracks: NormalizedPowerTrack[] }
  | { ok: false; error: string };

export async function fetchPowerHistory(params: {
  nodeName: string;
  from: number;
  to: number;
  outletKeys?: string[];
  fetchImpl?: typeof fetch;
}): Promise<PowerHistoryFetchResult> {
  const search = new URLSearchParams({
    from: new Date(params.from).toISOString(),
    to: new Date(params.to).toISOString(),
  });
  if (params.outletKeys && params.outletKeys.length > 0) search.set("outletKeys", params.outletKeys.join(","));

  const doFetch = params.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`/api/nodes/${encodeURIComponent(params.nodeName)}/power/history?${search.toString()}`, { cache: "no-store" });
  } catch {
    return { ok: false, error: "Could not reach the coordinator." };
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: typeof body.error === "string" ? body.error : "Could not load power history." };
  }

  const rawTracks: Array<{
    outletId: string;
    outletKey: string;
    label: string;
    enabled: boolean;
    available: boolean;
    initialState: boolean | null;
    segments: Array<{ from: string; to: string; state: boolean }>;
    gaps: Array<{ from: string; to: string }>;
  }> = Array.isArray(body.tracks) ? body.tracks : [];

  return {
    ok: true,
    rangeFrom: body.range?.from ? new Date(body.range.from).getTime() : params.from,
    rangeTo: body.range?.to ? new Date(body.range.to).getTime() : params.to,
    tracks: rawTracks.map((track) => ({
      outletId: track.outletId,
      outletKey: track.outletKey,
      label: track.label,
      enabled: track.enabled,
      available: track.available,
      initialState: track.initialState,
      segments: track.segments.map((segment) => ({ from: new Date(segment.from).getTime(), to: new Date(segment.to).getTime(), state: segment.state })),
      gaps: track.gaps.map((gap) => ({ from: new Date(gap.from).getTime(), to: new Date(gap.to).getTime() })),
    })),
  };
}

// Client-safe PlantEvent "kind" constants. Kept separate from
// src/lib/experiment.ts (which pulls in Prisma-typed helpers) so client
// components can import these without risking a server-only module ending up
// in the browser bundle.

export const EVENT_KIND_ORIGIN = "origin";
export const EVENT_KIND_OBSERVATION = "observation";
export type EventKind = typeof EVENT_KIND_ORIGIN | typeof EVENT_KIND_OBSERVATION;

/**
 * The single canonical "Added to project" event every plant must have.
 * Plant.startedAt/startLabel remain as a compatibility mirror (kept in sync
 * when the origin event's timestamp changes) - the origin PlantEvent is the
 * canonical, editable record for timeline purposes.
 */
export const ORIGIN_EVENT_TYPE = "Added to project";

export function isOriginEvent(event: { kind: string }) {
  return event.kind === EVENT_KIND_ORIGIN;
}

/**
 * Project lifecycle metadata (see prisma/schema.prisma's Project.lifecycleState
 * comment and DEPLOYMENT.md/ARCHITECTURE.md). Metadata only in this task -
 * nothing reads this to change scheduling, capture, or visibility behavior.
 * It exists so backup manifests can snapshot it and so a future
 * backup/publication workflow (archiving a project, publishing it
 * read-only) has a real state machine to build on instead of inventing one
 * under time pressure later.
 *
 * Suggested flow (not enforced): ACTIVE -> COMPLETE -> UNANNOTATED /
 * ANNOTATED -> ARCHIVED -> PUBLISHED. Transitions are NOT validated against
 * this order in this task - `plantlab project set-lifecycle` accepts any
 * listed state from any other state. Enforcing a strict state machine is
 * deferred until a real workflow (e.g. publication) depends on one.
 */
export const PROJECT_LIFECYCLE_STATES = [
  "ACTIVE",
  "COMPLETE",
  "UNANNOTATED",
  "ANNOTATED",
  "ARCHIVED",
  "PUBLISHED",
] as const;
export type ProjectLifecycleState = (typeof PROJECT_LIFECYCLE_STATES)[number];

export function isValidProjectLifecycleState(value: unknown): value is ProjectLifecycleState {
  return typeof value === "string" && (PROJECT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** A null lifecycleState (every project created before this task) is treated identically to ACTIVE - never a distinct "unset" state application code has to special-case. */
export function effectiveProjectLifecycleState(lifecycleState: string | null): ProjectLifecycleState {
  return isValidProjectLifecycleState(lifecycleState) ? lifecycleState : "ACTIVE";
}

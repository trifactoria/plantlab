export const OUTLET_BEHAVIORS = ["normal", "pulse-only"] as const;
export type OutletBehavior = (typeof OUTLET_BEHAVIORS)[number];

export const DEFAULT_OUTLET_BEHAVIOR: OutletBehavior = "normal";

export function normalizeOutletBehavior(value: unknown): OutletBehavior | null {
  return typeof value === "string" && (OUTLET_BEHAVIORS as readonly string[]).includes(value) ? (value as OutletBehavior) : null;
}

export function outletBehaviorOrDefault(value: unknown): OutletBehavior {
  return normalizeOutletBehavior(value) ?? DEFAULT_OUTLET_BEHAVIOR;
}

export function canUsePermanentOn(behavior: OutletBehavior): boolean {
  return behavior === "normal";
}

export function canUsePermanentOff(behavior: OutletBehavior): boolean {
  return behavior === "normal" || behavior === "pulse-only";
}

export function canUsePulse(behavior: OutletBehavior): boolean {
  return behavior === "pulse-only";
}

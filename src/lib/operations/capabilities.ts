// Node capability vocabulary (Part 6 of the Pi Zero edge-agent task) - a
// node advertises what it can physically do, independent of its role.
// Deliberately additive and non-exclusive: a camera-node advertises just
// ["camera"] today; a future greenhouse-node could advertise
// ["camera", "temperature", "humidity", "relay"]. Runtime behavior should
// prefer checking a reported capability over hard-coding by role wherever
// practical - see serviceRoles.ts and remoteNode.ts's recommendedRuntime
// logic for where this still legitimately falls back to role (systemd unit
// selection has to be role-based; sensor/relay control does not exist yet).

export const NODE_CAPABILITIES = [
  "camera",
  "temperature",
  "humidity",
  "soil-moisture",
  "relay",
  "fan",
  "light",
  "pump",
  "microscope",
] as const;

export type NodeCapability = (typeof NODE_CAPABILITIES)[number];

export function isValidCapability(value: unknown): value is NodeCapability {
  return typeof value === "string" && (NODE_CAPABILITIES as readonly string[]).includes(value);
}

/** Never throws - an unparsable or missing value is just "no capabilities known yet." */
export function parseCapabilities(json: string | null | undefined): NodeCapability[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCapability);
  } catch {
    return [];
  }
}

export function serializeCapabilities(capabilities: readonly string[]): string {
  const valid = Array.from(new Set(capabilities.filter(isValidCapability)));
  return JSON.stringify(valid);
}

/**
 * Only used to seed a node's capability list at registration time, before
 * it has ever reported anything itself - a real heartbeat's own reported
 * capabilities always take precedence once one arrives (see
 * agentProtocol.ts recordHeartbeat). Every role defaults to camera-only or
 * nothing; no sensor/relay capability is ever assumed by role alone,
 * matching "do not implement sensor or relay control yet."
 */
export function defaultCapabilitiesForRole(role: string | null | undefined): NodeCapability[] {
  if (role === "camera-node" || role === "greenhouse-node" || role === "microscope-node") {
    return role === "microscope-node" ? ["microscope"] : ["camera"];
  }
  return [];
}

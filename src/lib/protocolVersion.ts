/**
 * The PlantLab agent protocol version - see docs/AGENT_PROTOCOL.md. Bump
 * only on a breaking wire-format change to heartbeat/inventory/job
 * endpoints; both the full TypeScript agent (scripts/agent-service.ts) and
 * the Python edge agent (edge-agent/) report this same literal value in
 * their heartbeats. There is no shared build between the two runtimes, so
 * this value is intentionally duplicated (see edge-agent/plantlab_edge_agent/protocol.py)
 * rather than imported - keep them in sync by hand and call it out in any
 * PR that changes either.
 */
export const AGENT_PROTOCOL_VERSION = "1";

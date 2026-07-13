const EXPECTED_SQLITE_WARNING = /SQLite is an experimental feature/i;

let installed = false;

function warningMessage(warning: string | Error): string {
  return typeof warning === "string" ? warning : warning.message;
}

/**
 * node:sqlite (used by agentSpool.ts/doctor.ts/migrations.ts for the agent
 * spool's local state db) emits a Node ExperimentalWarning on every normal
 * CLI/agent run - harmless and expected, but noisy for a nontechnical user
 * watching `plantlab-edge status` or the agent service's logs.
 *
 * A plain `process.on("warning", ...)` listener is NOT enough: Node prints
 * its own default stderr line for every warning regardless of registered
 * listeners (verified empirically - registering a listener does not
 * suppress the default output). The only way to actually stop the line is
 * to intercept `process.emitWarning` itself, since Node's default printing
 * lives inside that call. This wraps it, dropping only messages that match
 * the known SQLite warning text and delegating everything else - including
 * every other ExperimentalWarning - to the original implementation
 * unchanged, so a real problem is never hidden.
 */
export function suppressExpectedNodeWarnings(): void {
  if (installed) return;
  installed = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : undefined;
    const isExperimentalOrUntyped = type === undefined || type === "ExperimentalWarning";
    if (isExperimentalOrUntyped && EXPECTED_SQLITE_WARNING.test(warningMessage(warning))) {
      return;
    }
    return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

// Self-installing on import (not just on call): agentSpool.ts imports
// node:sqlite statically, so the warning can fire purely as a side effect
// of another module being require()'d/imported - a caller that only calls
// suppressExpectedNodeWarnings() *after* its own imports have already run
// (which is easy to get wrong, and did in an earlier version of this file)
// would install the override too late. Importing this module for its side
// effect (e.g. `import "../lib/suppressExpectedWarnings"` as the very
// first import in an entrypoint) is therefore enough on its own; calling
// the exported function explicitly afterward is harmless (idempotent).
suppressExpectedNodeWarnings();

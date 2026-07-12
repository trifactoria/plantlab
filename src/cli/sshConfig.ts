import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SshHostEntry = {
  host: string;
  hostName: string | null;
  user: string | null;
};

/**
 * Minimal `~/.ssh/config` "Host" block reader - used only to surface
 * *candidate* machine names for `plantlab node discover`/`list`. Never
 * connects to anything, never verifies reachability, never registers a
 * node - see ARCHITECTURE.md for why the actual capture-agent
 * discovery/registration protocol is explicitly out of scope for this
 * task.
 */
export async function readSshConfigHosts(configPath = path.join(os.homedir(), ".ssh", "config")): Promise<SshHostEntry[]> {
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw) {
    return [];
  }

  const entries: SshHostEntry[] = [];
  let current: SshHostEntry | null = null;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const [keyRaw, ...rest] = line.split(/\s+/);
    const key = keyRaw.toLowerCase();
    const value = rest.join(" ");

    if (key === "host") {
      if (current && current.host !== "*") entries.push(current);
      current = { host: value, hostName: null, user: null };
    } else if (current) {
      if (key === "hostname") current.hostName = value;
      if (key === "user") current.user = value;
    }
  }
  if (current && current.host !== "*") entries.push(current);

  return entries;
}

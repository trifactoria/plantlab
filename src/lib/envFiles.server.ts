import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRootDir } from "./paths.server";

if (typeof window !== "undefined") {
  throw new Error("src/lib/envFiles.server.ts reads local files and must not run in a browser.");
}

export type LoadedEnvFiles = {
  files: string[];
  keys: string[];
};

/**
 * Loads PlantLab's local env files for CLI/script entry points before any
 * Prisma client is constructed. Existing process env wins; values loaded
 * from `.env` may be overridden by later `.env.local`, matching the local
 * systemd EnvironmentFile order.
 */
export function loadPlantLabEnvFiles(rootDir = resolveRootDir()): LoadedEnvFiles {
  const loadedByThisCall = new Set<string>();
  const files: string[] = [];
  const keys: string[] = [];

  for (const name of [".env", ".env.local"]) {
    const filePath = path.join(rootDir, name);
    if (!existsSync(filePath)) continue;
    files.push(filePath);
    const parsed = parseEnvFile(readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || loadedByThisCall.has(key)) {
        process.env[key] = value;
        loadedByThisCall.add(key);
        keys.push(key);
      }
    }
  }

  return { files, keys: [...new Set(keys)] };
}

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

function unquoteEnvValue(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

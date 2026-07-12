import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static import-boundary check for the regression fixed in this commit:
 * src/instrumentation.ts transitively imported src/lib/paths.ts (a module
 * with `node:fs`/`node:path` imports), and Next.js compiles
 * instrumentation.ts for an edge-compatible webpack target that has no
 * Node builtin resolution at all - every route 500'd as a result. See
 * src/instrumentation.ts's own comment for the full empirical
 * investigation (a bare `import path from "node:path"` alone in that file
 * reproduces the same failure).
 *
 * This walks the real import graph (not a hand-maintained allowlist) from
 * every entry point that Next.js treats specially the same way
 * instrumentation.ts is (currently just that one file) plus every "use
 * client" component, and fails if any of them can reach a module with a
 * top-level Node builtin import - catching both a future instrumentation.ts
 * regression and a future accidental Client Component import of a
 * server-only module (e.g. src/lib/paths.server.ts,
 * src/lib/projectPaths.server.ts).
 *
 * `import type { X } from "..."` (whole-clause type-only) is correctly
 * excluded - it is erased entirely at compile time and never causes the
 * target module to be bundled. A mixed `import { a, type B } from "..."`
 * is NOT excluded, since `a` still needs the module at runtime.
 */

const SRC = path.resolve(__dirname, "../../src");
const NODE_BUILTIN_RE = /^node:|^(fs|path|child_process|crypto|os|util|http|https|net|tls|stream|zlib)(\/|$)/;

type ParsedImport = { spec: string; typeOnly: boolean };

/** Parses static import declarations, require(), and dynamic import() calls from source text. */
function parseImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];

  const staticImportRe = /import\s+(type\s+)?[^;'"]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = staticImportRe.exec(content))) {
    results.push({ spec: m[2], typeOnly: Boolean(m[1]) });
  }

  const requireRe = /require\(["']([^"']+)["']\)/g;
  while ((m = requireRe.exec(content))) {
    results.push({ spec: m[1], typeOnly: false });
  }

  const dynamicImportRe = /[^.\w]import\(["']([^"']+)["']\)/g;
  while ((m = dynamicImportRe.exec(content))) {
    results.push({ spec: m[1], typeOnly: false });
  }

  return results;
}

/** A spec counts as a real (non-type-only) dependency if any occurrence of it in the file is not type-only. */
function realDependencySpecs(imports: ParsedImport[]): Set<string> {
  const typeOnlyOnly = new Map<string, boolean>();
  for (const { spec, typeOnly } of imports) {
    const existing = typeOnlyOnly.get(spec);
    typeOnlyOnly.set(spec, existing === undefined ? typeOnly : existing && typeOnly);
  }
  return new Set([...typeOnlyOnly.entries()].filter(([, onlyType]) => !onlyType).map(([spec]) => spec));
}

type FileGraph = Map<string, Set<string>>;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) listSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = path.join(SRC, spec.slice(2));
  } else if (spec.startsWith(".")) {
    base = path.join(path.dirname(fromFile), spec);
  } else {
    return null; // external package - not part of this app's own boundary
  }

  for (const candidate of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Node builtins this file imports at runtime (excludes type-only imports). */
function directNodeBuiltinImports(file: string): string[] {
  const imports = parseImports(readFileSync(file, "utf8"));
  const real = realDependencySpecs(imports);
  return [...real].filter((spec) => NODE_BUILTIN_RE.test(spec));
}

function buildGraph(files: string[]): FileGraph {
  const graph: FileGraph = new Map();
  for (const file of files) {
    const imports = parseImports(readFileSync(file, "utf8"));
    const real = realDependencySpecs(imports);
    const deps = new Set<string>();
    for (const spec of real) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved) deps.add(resolved);
    }
    graph.set(file, deps);
  }
  return graph;
}

function isClientFile(file: string): boolean {
  const content = readFileSync(file, "utf8");
  const head = content.split("\n").slice(0, 5).join("\n");
  return /^\s*["']use client["'];?\s*$/m.test(head);
}

/** BFS from `start`; returns the first chain (start -> ... -> offending file) that reaches a Node builtin import, or null. */
function findChainToNodeBuiltin(start: string, graph: FileGraph): string[] | null {
  const queue: string[][] = [[start]];
  const visited = new Set<string>([start]);

  while (queue.length > 0) {
    const chain = queue.shift()!;
    const node = chain[chain.length - 1];

    if (directNodeBuiltinImports(node).length > 0) {
      return chain;
    }

    for (const dep of graph.get(node) ?? []) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      queue.push([...chain, dep]);
    }
  }

  return null;
}

describe("import boundaries: Node builtins must stay out of the edge/client graph", () => {
  const files = listSourceFiles(SRC);
  const graph = buildGraph(files);

  it("src/instrumentation.ts has zero local module imports (Next compiles it for an edge-compatible target with no Node builtin support)", () => {
    const instrumentationFile = path.join(SRC, "instrumentation.ts");
    const imports = parseImports(readFileSync(instrumentationFile, "utf8"));
    const localSpecs = imports
      .map((i) => i.spec)
      .filter((spec) => spec.startsWith(".") || spec.startsWith("@/"));

    expect(
      localSpecs,
      "instrumentation.ts must inline any logic it needs rather than importing shared modules - see its own top-of-file comment",
    ).toEqual([]);
  });

  it("no Client Component transitively imports a module with a top-level Node builtin import", () => {
    const violations: Array<{ file: string; chain: string[] }> = [];

    for (const file of files) {
      if (!isClientFile(file)) continue;
      const chain = findChainToNodeBuiltin(file, graph);
      if (chain && chain.length > 1) {
        // chain[0] is the client file itself; only report if a Node
        // builtin is reached via an IMPORTED module, not the client file's
        // own (which would be a different, more direct bug already caught
        // by Next's own build).
        violations.push({ file: path.relative(SRC, file), chain: chain.map((f) => path.relative(SRC, f)) });
      }
    }

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("src/lib/paths.server.ts and src/lib/projectPaths.server.ts are real Node-builtin-importing modules (sanity check that the analyzer isn't vacuously passing)", () => {
    expect(directNodeBuiltinImports(path.join(SRC, "lib/paths.server.ts")).length).toBeGreaterThan(0);
    expect(directNodeBuiltinImports(path.join(SRC, "lib/projectPaths.server.ts")).length).toBeGreaterThan(0);
  });
});

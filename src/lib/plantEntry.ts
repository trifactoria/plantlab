// Pure helpers for the repeated grid-entry workflow (creating many plants in a
// row). Kept side-effect free so they're easy to unit test; the sessionStorage
// wrapper around plantEntryMemoryKey/serialize/parse lives in
// usePlantEntryMemory.ts.

export type ObservationMemory =
  | { kind: "milestone"; milestoneId: string; label: string }
  | { kind: "custom"; label: string }
  | { kind: "none" };

export type PlantEntryMemory = {
  startedAt: string;
  observation: ObservationMemory;
  tags: string;
};

export function plantEntryMemoryKey(projectId: string) {
  return `plantlab:plant-entry:${projectId}`;
}

export function serializePlantEntryMemory(memory: PlantEntryMemory): string {
  return JSON.stringify(memory);
}

export function parsePlantEntryMemory(raw: string | null): PlantEntryMemory | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.tags === "string" &&
      parsed.observation &&
      typeof parsed.observation.kind === "string"
    ) {
      return parsed as PlantEntryMemory;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Proposes the next name in a sequence when a name ends in a number
 * (R1 -> R2, Radish 5 -> Radish 6). Returns null when there is no trailing
 * number to increment, so callers can leave the name field blank rather than
 * guess.
 */
export function nextSequentialName(name: string): string | null {
  const match = name.match(/^(.*?)(\d+)(\s*)$/);
  if (!match) {
    return null;
  }

  const [, prefix, digits, trailingSpace] = match;
  const incremented = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${prefix}${incremented}${trailingSpace}`;
}

/** Case-insensitive, trimmed match against a project's milestone labels. */
export function matchMilestoneByLabel<T extends { label: string }>(
  label: string,
  milestones: T[],
): T | undefined {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return milestones.find((milestone) => milestone.label.trim().toLowerCase() === normalized);
}

/**
 * Finds the next empty grid cell in row-major order starting just after
 * `current`, wrapping around the grid. Used by "Save and add next" to advance
 * through repeated specimen entry.
 */
export function findNextEmptyCell(
  current: { gridX: number; gridY: number },
  occupied: ReadonlySet<string>,
  gridWidth: number,
  gridHeight: number,
): { gridX: number; gridY: number } | null {
  const total = gridWidth * gridHeight;
  if (total <= 0) {
    return null;
  }

  const startIndex = current.gridY * gridWidth + current.gridX;
  for (let step = 1; step <= total; step += 1) {
    const index = (startIndex + step) % total;
    const gridX = index % gridWidth;
    const gridY = Math.floor(index / gridWidth);
    if (!occupied.has(`${gridX}:${gridY}`)) {
      return { gridX, gridY };
    }
  }

  return null;
}

export function gridCellKey(gridX: number, gridY: number) {
  return `${gridX}:${gridY}`;
}

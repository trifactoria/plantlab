import { describe, expect, it } from "vitest";
import {
  findNextEmptyCell,
  gridCellKey,
  matchMilestoneByLabel,
  nextSequentialName,
  parsePlantEntryMemory,
  plantEntryMemoryKey,
  serializePlantEntryMemory,
} from "../../src/lib/plantEntry";

describe("nextSequentialName", () => {
  it("increments a bare trailing number", () => {
    expect(nextSequentialName("R1")).toBe("R2");
  });

  it("increments a space-separated trailing number", () => {
    expect(nextSequentialName("Radish 5")).toBe("Radish 6");
  });

  it("preserves zero-padding width", () => {
    expect(nextSequentialName("Tray 09")).toBe("Tray 10");
  });

  it("returns null when there is no trailing number to propose", () => {
    expect(nextSequentialName("Radish")).toBeNull();
    expect(nextSequentialName("")).toBeNull();
  });
});

describe("matchMilestoneByLabel", () => {
  const milestones = [
    { id: "m1", label: "First visible" },
    { id: "m2", label: "Harvest Ready" },
  ];

  it("matches case-insensitively and trims whitespace", () => {
    expect(matchMilestoneByLabel("  first visible  ", milestones)?.id).toBe("m1");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchMilestoneByLabel("Cutting placed in water", milestones)).toBeUndefined();
  });
});

describe("findNextEmptyCell", () => {
  it("skips occupied cells and wraps row-major", () => {
    const occupied = new Set([gridCellKey(0, 0), gridCellKey(1, 0)]);
    const next = findNextEmptyCell({ gridX: 0, gridY: 0 }, occupied, 2, 2);
    expect(next).toEqual({ gridX: 0, gridY: 1 });
  });

  it("wraps back to the start of the grid", () => {
    const occupied = new Set([gridCellKey(0, 0)]);
    const next = findNextEmptyCell({ gridX: 1, gridY: 1 }, occupied, 2, 2);
    expect(next).toEqual({ gridX: 1, gridY: 0 });
  });

  it("returns null when the grid is full", () => {
    const occupied = new Set([gridCellKey(0, 0), gridCellKey(1, 0), gridCellKey(0, 1), gridCellKey(1, 1)]);
    expect(findNextEmptyCell({ gridX: 0, gridY: 0 }, occupied, 2, 2)).toBeNull();
  });
});

describe("plant entry memory serialization", () => {
  it("round-trips through JSON", () => {
    const memory = {
      startedAt: "2026-07-11T10:00:00.000Z",
      observation: { kind: "milestone" as const, milestoneId: "m1", label: "First visible" },
      tags: "fast, tray-a",
    };
    expect(parsePlantEntryMemory(serializePlantEntryMemory(memory))).toEqual(memory);
  });

  it("rejects malformed input instead of throwing", () => {
    expect(parsePlantEntryMemory("not json")).toBeNull();
    expect(parsePlantEntryMemory(JSON.stringify({ startedAt: "x" }))).toBeNull();
    expect(parsePlantEntryMemory(null)).toBeNull();
  });

  it("scopes the storage key per project so values cannot leak across projects", () => {
    const keyA = plantEntryMemoryKey("project-a");
    const keyB = plantEntryMemoryKey("project-b");
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain("project-a");
    expect(keyB).toContain("project-b");
  });
});

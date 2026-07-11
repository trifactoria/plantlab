"use client";

import { useCallback, useState } from "react";
import {
  PlantEntryMemory,
  parsePlantEntryMemory,
  plantEntryMemoryKey,
  serializePlantEntryMemory,
} from "@/lib/plantEntry";

function readMemory(projectId: string): PlantEntryMemory | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return parsePlantEntryMemory(window.sessionStorage.getItem(plantEntryMemoryKey(projectId)));
  } catch {
    return null;
  }
}

/**
 * Remembers the last submitted starting timestamp/observation/tags for
 * repeated grid entry, scoped to a single project via sessionStorage so
 * switching projects never leaks values across them.
 */
export function usePlantEntryMemory(projectId: string) {
  const [memory, setMemory] = useState<PlantEntryMemory | null>(() => readMemory(projectId));

  const remember = useCallback(
    (next: PlantEntryMemory) => {
      setMemory(next);
      if (typeof window === "undefined") {
        return;
      }
      try {
        window.sessionStorage.setItem(plantEntryMemoryKey(projectId), serializePlantEntryMemory(next));
      } catch {
        // sessionStorage can be unavailable (private browsing, quota); the
        // in-memory state above still covers the rest of this session.
      }
    },
    [projectId],
  );

  return { memory, remember };
}

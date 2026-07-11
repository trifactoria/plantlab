"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CreatedPlant, PlantCreateForm } from "@/components/PlantCreateForm";
import { ObservationForm } from "@/components/ObservationForm";
import { StartingObservationMilestone } from "@/components/StartingObservationField";
import { findNextEmptyCell, gridCellKey } from "@/lib/plantEntry";

type GridPlant = {
  id: string;
  name: string;
  gridX: number;
  gridY: number;
};

type ProjectGrid = {
  id: string;
  gridWidth: number;
  gridHeight: number;
};

type SelectedCell = {
  gridX: number;
  gridY: number;
};

type SelectedPlant = {
  id: string;
  name: string;
};

export function PlantGrid({
  project,
  plants,
  milestones = [],
  mode = "dashboard",
  photoId,
  photoTimestamp,
}: {
  project: ProjectGrid;
  plants: GridPlant[];
  milestones?: StartingObservationMilestone[];
  mode?: "dashboard" | "photo";
  photoId?: string;
  photoTimestamp?: string;
}) {
  const router = useRouter();
  const [localPlants, setLocalPlants] = useState(plants);
  useEffect(() => {
    setLocalPlants(plants);
  }, [plants]);

  const plantByCell = useMemo(() => {
    return new Map(localPlants.map((plant) => [gridCellKey(plant.gridX, plant.gridY), plant]));
  }, [localPlants]);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [lastCreatedName, setLastCreatedName] = useState<string | null>(null);
  const [selectedPlant, setSelectedPlant] = useState<SelectedPlant | null>(null);

  function handlePlantCreated(plant: CreatedPlant, options: { addNext: boolean }) {
    const nextLocalPlants = [...localPlants, plant];
    setLocalPlants(nextLocalPlants);
    setLastCreatedName(plant.name);

    if (options.addNext) {
      const occupied = new Set(nextLocalPlants.map((item) => gridCellKey(item.gridX, item.gridY)));
      const nextCell = findNextEmptyCell(
        { gridX: plant.gridX, gridY: plant.gridY },
        occupied,
        project.gridWidth,
        project.gridHeight,
      );
      setSelectedCell(nextCell);
    } else {
      setSelectedCell(null);
    }

    router.refresh();
  }

  const cells = [];
  for (let y = 0; y < project.gridHeight; y += 1) {
    for (let x = 0; x < project.gridWidth; x += 1) {
      const plant = plantByCell.get(gridCellKey(x, y));
      cells.push(
        <div key={`${x}:${y}`} className="aspect-square min-h-16">
          {plant && mode === "dashboard" ? (
            <Link
              href={`/plants/${plant.id}`}
              className="flex h-full w-full items-center justify-center rounded-md border border-emerald-300 bg-emerald-50 p-2 text-center text-sm font-semibold text-emerald-950 transition hover:bg-emerald-100"
            >
              {plant.name}
            </Link>
          ) : (
            <button
              type="button"
              data-testid={`grid-cell-${x}-${y}`}
              className={`h-full w-full rounded-md border p-2 text-center text-sm font-semibold transition ${
                plant
                  ? "border-cyan-300 bg-cyan-50 text-cyan-950 hover:bg-cyan-100"
                  : mode === "dashboard"
                    ? "border-dashed border-stone-300 bg-white text-stone-400 hover:border-emerald-400 hover:text-emerald-800"
                    : "cursor-default border-dashed border-stone-200 bg-stone-50 text-stone-300"
              }`}
              onClick={() => {
                if (plant && mode === "photo") {
                  setSelectedPlant(plant);
                  return;
                }

                if (!plant && mode === "dashboard") {
                  setSelectedCell({ gridX: x, gridY: y });
                }
              }}
              disabled={!plant && mode === "photo"}
            >
              {plant ? plant.name : ""}
            </button>
          )}
        </div>,
      );
    }
  }

  return (
    <>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${project.gridWidth}, minmax(0, 1fr))` }}
      >
        {cells}
      </div>

      {selectedCell ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <PlantCreateForm
            key={gridCellKey(selectedCell.gridX, selectedCell.gridY)}
            projectId={project.id}
            cell={selectedCell}
            milestones={milestones}
            lastCreatedName={lastCreatedName}
            onCancel={() => setSelectedCell(null)}
            onSaved={handlePlantCreated}
          />
        </div>
      ) : null}

      {selectedPlant ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
          <ObservationForm
            plantId={selectedPlant.id}
            milestones={milestones}
            photoId={photoId}
            photoTimestamp={photoTimestamp}
            copyPlantPhotoCrop
            title={`Add Event: ${selectedPlant.name}`}
            onCancel={() => setSelectedPlant(null)}
            onSaved={() => {
              setSelectedPlant(null);
              router.refresh();
            }}
          />
        </div>
      ) : null}
    </>
  );
}

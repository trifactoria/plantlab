"use client";

import Link from "next/link";
import { useState } from "react";
import { ProjectForm } from "@/components/ProjectForm";
import { Drawer } from "@/components/shell/Drawer";
import { EmptyState } from "@/components/shell/SummaryCard";
import { formatDateTime } from "@/lib/format";

export type ProjectListItem = {
  id: string;
  name: string;
  description: string | null;
  gridWidth: number;
  gridHeight: number;
  isTestProject: boolean;
  createdAt: string;
  counts: { photos: number; plants: number; events: number };
};

/**
 * Projects tab body: the project list plus a New Project action that opens the
 * existing ProjectForm in a drawer, instead of parking the full creation form
 * permanently on the dashboard. Keeps the homepage focused on browsing
 * projects while creation is one click away.
 */
export function ProjectsDashboard({ projects }: { projects: ProjectListItem[] }) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-stone-950">Projects</h2>
        <button type="button" className="button w-fit" onClick={() => setCreating(true)} data-testid="new-project-button">
          New Project
        </button>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          message="No projects yet. Create one to start tracking photos, plants, and observations."
          action={{ label: "New Project", onClick: () => setCreating(true) }}
        />
      ) : (
        <div className="grid gap-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm transition hover:border-emerald-300"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-stone-950">{project.name}</h3>
                  {project.isTestProject ? (
                    <span className="mt-1 inline-flex rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      Test project
                    </span>
                  ) : null}
                  {project.description ? <p className="mt-1 text-sm text-stone-600">{project.description}</p> : null}
                </div>
                <span className="rounded-md bg-stone-100 px-2.5 py-1 text-xs font-semibold text-stone-700">
                  {project.gridWidth} x {project.gridHeight}
                </span>
              </div>
              <dl className="mt-4 grid gap-3 text-sm text-stone-600 sm:grid-cols-4">
                <div>
                  <dt className="font-medium text-stone-950">Photos</dt>
                  <dd>{project.counts.photos}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Plants</dt>
                  <dd>{project.counts.plants}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Events</dt>
                  <dd>{project.counts.events}</dd>
                </div>
                <div>
                  <dt className="font-medium text-stone-950">Created</dt>
                  <dd>{formatDateTime(project.createdAt)}</dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      )}

      <Drawer open={creating} onClose={() => setCreating(false)} title="New Project">
        <ProjectForm />
      </Drawer>
    </div>
  );
}

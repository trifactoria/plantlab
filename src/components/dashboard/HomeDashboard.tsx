"use client";

import { useState } from "react";
import type { NodeSummaryResponse } from "@/lib/operations/nodeSummary";
import { DashboardTabPanel, DashboardTabs, type DashboardTab } from "@/components/shell/DashboardTabs";
import { UnifiedNodeTable } from "./UnifiedNodeTable";
import { EnvironmentDashboard, type EnvironmentDashboardNode } from "./EnvironmentDashboard";
import { ProjectsDashboard, type ProjectListItem } from "./ProjectsDashboard";
import { PowerDashboard } from "./PowerDashboard";
import { FleetCameraDashboard } from "./FleetCameraDashboard";
import { SystemDashboard, type SystemInfo } from "./SystemDashboard";

const TABS: DashboardTab[] = [
  { id: "environment", label: "Environment" },
  { id: "projects", label: "Projects" },
  { id: "power", label: "Power" },
  { id: "cameras", label: "Cameras" },
  { id: "system", label: "System" },
];

/**
 * The unified home dashboard shell. Identical structure in standalone and
 * coordinator modes: the Nodes table (self row first) is the primary system
 * summary, and the tabs below hold Environment, Projects, Power, Cameras, and
 * System. The coordinator differs only by having more node rows and more
 * populated tabs - never a different layout.
 */
export function HomeDashboard({
  nodeSummary,
  projects,
  environmentNodes,
  powerNodeNames,
  systemInfo,
  allNodeNames,
  initialTab,
}: {
  nodeSummary: NodeSummaryResponse;
  projects: ProjectListItem[];
  environmentNodes: EnvironmentDashboardNode[];
  powerNodeNames: string[];
  systemInfo: SystemInfo;
  allNodeNames: string[];
  initialTab?: string;
}) {
  // The tab bar is identical in every mode; only the initial selection is
  // data-driven so an install with no sensors doesn't open on an empty
  // Environment tab. An explicit ?tab= always wins.
  const fallbackTab = environmentNodes.length > 0 ? "environment" : "projects";
  const [activeTab, setActiveTab] = useState(TABS.some((tab) => tab.id === initialTab) ? (initialTab as string) : fallbackTab);

  return (
    <div className="grid gap-6">
      <UnifiedNodeTable initial={nodeSummary} />

      <div>
        <DashboardTabs tabs={TABS} activeId={activeTab} onChange={setActiveTab} />

        <DashboardTabPanel id="environment" active={activeTab === "environment"}>
          <EnvironmentDashboard nodes={environmentNodes} />
        </DashboardTabPanel>
        <DashboardTabPanel id="projects" active={activeTab === "projects"}>
          <ProjectsDashboard projects={projects} />
        </DashboardTabPanel>
        <DashboardTabPanel id="power" active={activeTab === "power"}>
          <PowerDashboard nodeNames={powerNodeNames} />
        </DashboardTabPanel>
        <DashboardTabPanel id="cameras" active={activeTab === "cameras"}>
          <FleetCameraDashboard />
        </DashboardTabPanel>
        <DashboardTabPanel id="system" active={activeTab === "system"}>
          <SystemDashboard info={systemInfo} nodeNames={allNodeNames} />
        </DashboardTabPanel>
      </div>
    </div>
  );
}

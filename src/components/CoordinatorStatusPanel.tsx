import type { CoordinatorDashboardData } from "@/lib/operations/coordinatorDashboard";
import { formatDateTime } from "@/lib/format";

const STATUS_STYLES: Record<CoordinatorDashboardData["nodes"][number]["statusLabel"], string> = {
  active: "bg-emerald-100 text-emerald-900 border-emerald-200",
  pending: "bg-stone-100 text-stone-700 border-stone-200",
  "repair-required": "bg-amber-100 text-amber-900 border-amber-200",
  offline: "bg-red-100 text-red-900 border-red-200",
  revoked: "bg-red-100 text-red-900 border-red-200",
};

const STATUS_LABEL: Record<CoordinatorDashboardData["nodes"][number]["statusLabel"], string> = {
  active: "Active",
  pending: "Pending first heartbeat",
  "repair-required": "Repair required",
  offline: "Offline",
  revoked: "Revoked",
};

export function CoordinatorStatusPanel({
  data,
  localCameraServiceEnabled,
}: {
  data: CoordinatorDashboardData;
  localCameraServiceEnabled: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Coordinator</h2>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-medium text-stone-950">Web service</dt>
            <dd>
              <span className="rounded-md border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                Running
              </span>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Database</dt>
            <dd>
              <span className="rounded-md border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                Connected
              </span>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-950">Capture job queue</dt>
            <dd className="text-stone-600">
              {data.jobQueue.queued} queued, {data.jobQueue.claimed} in progress
            </dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-950">Nodes</h2>
        {data.nodes.length === 0 ? (
          <p className="mt-3 text-sm text-stone-600">
            No nodes registered yet. Run &ldquo;plantlab node attach &lt;ssh-host&gt;&rdquo; from the coordinator to add one.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-md border border-stone-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-stone-50 text-xs font-semibold uppercase text-stone-600">
                <tr>
                  <th className="px-3 py-2">Node</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last heartbeat</th>
                  <th className="px-3 py-2">Cameras</th>
                  <th className="px-3 py-2">Failed jobs (24h)</th>
                </tr>
              </thead>
              <tbody>
                {data.nodes.map((node) => (
                  <tr key={node.id} className="border-t border-stone-100">
                    <td className="px-3 py-2 font-medium text-stone-950">{node.name}</td>
                    <td className="px-3 py-2 text-stone-600">{node.role}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[node.statusLabel]}`}>
                        {STATUS_LABEL[node.statusLabel]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-stone-600">
                      {node.lastHeartbeatAt ? formatDateTime(node.lastHeartbeatAt) : "never"}
                    </td>
                    <td className="px-3 py-2 text-stone-600">{node.cameraCount}</td>
                    <td className={node.recentFailedJobCount > 0 ? "px-3 py-2 font-medium text-red-700" : "px-3 py-2 text-stone-600"}>
                      {node.recentFailedJobCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">
        <span className="font-medium text-stone-950">Local camera service:</span>{" "}
        {localCameraServiceEnabled && data.activeLocalCaptureSourceCount > 0
          ? `optional - currently used by ${data.activeLocalCaptureSourceCount} local capture source(s) not tied to a node`
          : "not configured (optional - only needed for a camera attached directly to this coordinator)"}
      </div>
    </div>
  );
}

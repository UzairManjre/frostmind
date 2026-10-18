"use client";

import { useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { StatusBadge } from "@/components/Badges";
import { DownloadIcon, FileIcon } from "@/components/Icons";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { Idx, PageBody, PageHeader, Panel } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";
import { downloadShipmentReport, fetchFleet } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { FleetShipment } from "@/lib/types";

function ReportsList() {
  const { token } = useAuth();
  const { data, error, errorStatus, loading, refresh } = usePolling<FleetShipment[]>(
    () => fetchFleet(token as string),
    [token],
    10000
  );
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload(shipment: FleetShipment) {
    if (!token) return;
    setDownloadingId(shipment.id);
    setDownloadError(null);
    try {
      const blob = await downloadShipmentReport(token, shipment.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `frostmind_shipment_${shipment.id}_report.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingId(null);
    }
  }

  if (loading && !data) return <LoadingState label="Loading shipments..." />;
  if (error) return <ErrorState error={error} status={errorStatus} onRetry={refresh} />;
  if (!data || data.length === 0) {
    return <EmptyState title="No shipments yet" hint="Reports become available once a shipment has run and logged readings." />;
  }

  return (
    <div className="space-y-4">
      {downloadError && (
        <p className="rounded-[3px] border border-danger/30 bg-danger/[0.08] px-4 py-2.5 text-xs text-danger">
          Report download failed: {downloadError}
        </p>
      )}
      <Panel
        index={1}
        title="Shipment audit trails"
        subtitle="Temperature, humidity and door history plus alerts and category, as a CSV."
        bodyClassName="overflow-x-auto"
      >
        <table className="data-table min-w-[760px]">
          <thead>
            <tr>
              <th className="w-14">#</th>
              <th>Shipment</th>
              <th>Truck</th>
              <th>Category</th>
              <th>Status</th>
              <th>Started</th>
              <th className="text-right">Report</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s, i) => (
              <tr key={s.id}>
                <td>
                  <Idx n={i + 1} />
                </td>
                <td>
                  <div className="flex items-center gap-3">
                    <span className="icon-tile !h-7 !w-7">
                      <FileIcon className="h-3.5 w-3.5" />
                    </span>
                    <span className="font-medium text-white">{s.label || s.id.slice(0, 8)}</span>
                  </div>
                </td>
                <td className="text-peri-100">{s.truck_label}</td>
                <td className="capitalize text-dim">{s.category.replace(/_/g, " ")}</td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className="text-xs text-dim">{s.start_time ? new Date(s.start_time).toLocaleString() : "-"}</td>
                <td className="text-right">
                  <button
                    onClick={() => handleDownload(s)}
                    disabled={downloadingId === s.id}
                    className="btn btn-ghost btn-sm"
                  >
                    <DownloadIcon className="h-3.5 w-3.5" />
                    {downloadingId === s.id ? "Preparing..." : "CSV report"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <RequireAuth>
      <PageHeader
        variant="deep"
        eyebrow="Compliance"
        title="Reports"
        description="Per-shipment audit trail (temp/humidity/door history + alerts + category) as a downloadable CSV -- compliance evidence for cold-chain audits."
        page={[4, 6]}
      />
      <PageBody>
        <ReportsList />
      </PageBody>
    </RequireAuth>
  );
}

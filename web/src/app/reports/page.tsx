"use client";

import { useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { StatusBadge } from "@/components/Badges";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
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
    <div>
      {downloadError && (
        <p className="mb-3 rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-sm text-red-400">
          Report download failed: {downloadError}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
        <table className="w-full min-w-[700px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-left text-slate-400">
            <th className="py-2 px-4">Shipment</th>
            <th className="py-2 px-4">Truck</th>
            <th className="py-2 px-4">Category</th>
            <th className="py-2 px-4">Status</th>
            <th className="py-2 px-4">Started</th>
            <th className="py-2 px-4"></th>
          </tr>
        </thead>
        <tbody>
          {data.map((s) => (
            <tr key={s.id} className="border-b border-slate-900">
              <td className="py-2 px-4">{s.label || s.id.slice(0, 8)}</td>
              <td className="py-2 px-4">{s.truck_label}</td>
              <td className="py-2 px-4">{s.category}</td>
              <td className="py-2 px-4">
                <StatusBadge status={s.status} />
              </td>
              <td className="py-2 px-4 text-slate-400">{s.start_time ? new Date(s.start_time).toLocaleString() : "-"}</td>
              <td className="py-2 px-4">
                <button
                  onClick={() => handleDownload(s)}
                  disabled={downloadingId === s.id}
                  className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
                >
                  {downloadingId === s.id ? "Preparing..." : "Download CSV report"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <RequireAuth>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="mb-1 text-2xl font-semibold">Reports</h1>
        <p className="mb-6 text-sm text-slate-400">
          Per-shipment audit trail (temp/humidity/door history + alerts + category) as a downloadable CSV --
          compliance evidence for cold-chain audits.
        </p>
        <ReportsList />
      </div>
    </RequireAuth>
  );
}

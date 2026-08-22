"use client";

import Link from "next/link";
import { RequireAuth } from "@/components/RequireAuth";
import { StatusBadge } from "@/components/Badges";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { useAuth } from "@/lib/auth-context";
import { fetchFleet } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { FleetShipment } from "@/lib/types";

function fmtTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

function lastSeenAgo(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

function FleetTable() {
  const { token } = useAuth();
  const { data, error, errorStatus, loading, refresh } = usePolling<FleetShipment[]>(
    () => fetchFleet(token as string),
    [token],
    5000
  );

  if (loading && !data) return <LoadingState label="Loading fleet..." />;
  if (error) return <ErrorState error={error} status={errorStatus} onRetry={refresh} />;
  if (!data || data.length === 0) {
    return (
      <EmptyState
        title="No shipments yet"
        hint="Register a device and run the setup wizard from the phone bridge to see it appear here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-left text-slate-400">
            <th className="py-2 pr-4">Truck</th>
            <th className="py-2 pr-4">Device</th>
            <th className="py-2 pr-4">Shipment</th>
            <th className="py-2 pr-4">Category</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Latest temp</th>
            <th className="py-2 pr-4">Door</th>
            <th className="py-2 pr-4">Shelf life used</th>
            <th className="py-2 pr-4">Open alerts</th>
            <th className="py-2 pr-4">Device last seen</th>
          </tr>
        </thead>
        <tbody>
          {data.map((s) => (
            <tr key={s.id} className="border-b border-slate-900 hover:bg-slate-900/50">
              <td className="py-2 pr-4">
                <Link href={`/shipments/${s.id}`} className="text-sky-300 hover:underline">
                  {s.truck_label}
                </Link>
                {s.truck_plate && <div className="text-xs text-slate-500">{s.truck_plate}</div>}
              </td>
              <td className="py-2 pr-4">{s.device_name || s.device_id || "-"}</td>
              <td className="py-2 pr-4">{s.label || s.id.slice(0, 8)}</td>
              <td className="py-2 pr-4">{s.category}</td>
              <td className="py-2 pr-4">
                <StatusBadge status={s.status} />
              </td>
              <td className="py-2 pr-4">
                {s.latest_temp_c != null ? `${s.latest_temp_c.toFixed(1)} C` : "-"}
                {s.latest_reading_ts && (
                  <div className="text-xs text-slate-500">{fmtTime(s.latest_reading_ts)}</div>
                )}
              </td>
              <td className="py-2 pr-4">{s.latest_door_open == null ? "-" : s.latest_door_open ? "open" : "closed"}</td>
              <td className="py-2 pr-4">
                {s.shelf_life_consumed_fraction != null ? `${(s.shelf_life_consumed_fraction * 100).toFixed(1)}%` : "-"}
              </td>
              <td className="py-2 pr-4">
                {s.open_alert_count > 0 ? (
                  <span className="rounded-full bg-red-800 px-2 py-0.5 text-xs text-red-100">{s.open_alert_count}</span>
                ) : (
                  <span className="text-slate-500">0</span>
                )}
              </td>
              <td className="py-2 pr-4 text-slate-400">{lastSeenAgo(s.device_last_seen_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FleetPage() {
  return (
    <RequireAuth>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="mb-1 text-2xl font-semibold">Fleet</h1>
        <p className="mb-6 text-sm text-slate-400">
          Every truck/device, its current shipment, status, and last-seen time. Refreshes every 5s.
        </p>
        <FleetTable />
      </div>
    </RequireAuth>
  );
}

"use client";

// Fleet-level analytics/trends view (Prototype-to-Production plan §4: "not just per-shipment
// detail, but 'how many excursions this month,' 'which routes/trucks have the most alerts' --
// this is what actually sells the product to a fleet manager, versus a single shipment's
// chart"). Backend contract: GET /analytics/fleet?days=N, JWT-protected like the other
// admin-read endpoints. Kept dependency-free like components/LiveChart.tsx -- plain CSS bars,
// no charting library.

import { useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { useAuth } from "@/lib/auth-context";
import { fetchFleetAnalytics } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { FleetAnalytics } from "@/lib/types";

const WINDOWS = [7, 30, 90] as const;

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function HBar({ label, value, max, colorClass }: { label: string; value: number; max: number; colorClass: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="font-medium text-slate-100">{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const TYPE_COLORS: Record<string, string> = {
  anomaly: "bg-red-500",
  "shelf-life-threshold": "bg-amber-500",
  "door-open-too-long": "bg-sky-500",
};

function AnalyticsBody() {
  const { token } = useAuth();
  const [days, setDays] = useState<number>(30);

  const { data, error, errorStatus, loading, refresh } = usePolling<FleetAnalytics>(
    () => fetchFleetAnalytics(token as string, days),
    [token, days],
    15000
  );

  const maxTypeCount = data ? Math.max(1, ...data.by_type.map((t) => t.count)) : 1;
  const sortedByTruck = data ? [...data.by_truck].sort((a, b) => b.alert_count - a.alert_count) : [];
  const maxTruckCount = sortedByTruck.length ? Math.max(1, ...sortedByTruck.map((t) => t.alert_count)) : 1;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-400">Fleet-wide alert and shipment trends over a trailing window.</p>
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900/40 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`rounded px-3 py-1 text-xs font-medium ${
                days === w ? "bg-sky-700 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <LoadingState label="Loading analytics..." />}
      {error && <ErrorState error={error} status={errorStatus} onRetry={refresh} />}

      {data && !error && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile label="Total alerts" value={data.total_alerts} />
            <StatTile label="Active shipments" value={data.shipments_active} />
            <StatTile label="Completed shipments" value={data.shipments_completed} />
            <StatTile label="Window" value={`${data.period_days}d`} />
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="mb-3 text-sm font-medium text-slate-400">Alerts by type</h3>
            {data.by_type.length === 0 ? (
              <EmptyState title="No alerts in this window" />
            ) : (
              <div className="space-y-3">
                {data.by_type.map((t) => (
                  <HBar key={t.type} label={t.type} value={t.count} max={maxTypeCount} colorClass={TYPE_COLORS[t.type] || "bg-slate-500"} />
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="mb-3 text-sm font-medium text-slate-400">Alerts by truck</h3>
            {sortedByTruck.length === 0 ? (
              <EmptyState title="No alerts in this window" />
            ) : (
              <div className="space-y-3">
                {sortedByTruck.map((t) => (
                  <HBar key={t.truck_id} label={t.truck_label} value={t.alert_count} max={maxTruckCount} colorClass="bg-sky-500" />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <RequireAuth>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="mb-1 text-2xl font-semibold">Analytics</h1>
        <AnalyticsBody />
      </div>
    </RequireAuth>
  );
}

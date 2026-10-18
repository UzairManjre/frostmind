"use client";

// Fleet-level analytics/trends view (Prototype-to-Production plan §4: "not just per-shipment
// detail, but 'how many excursions this month,' 'which routes/trucks have the most alerts' --
// this is what actually sells the product to a fleet manager, versus a single shipment's
// chart"). Backend contract: GET /analytics/fleet?days=N, JWT-protected like the other
// admin-read endpoints. Kept dependency-free like components/LiveChart.tsx -- plain CSS bars,
// no charting library.

import { useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { alertTypeLabel } from "@/components/Badges";
import { BellIcon, BoxIcon, CheckIcon, TrendIcon } from "@/components/Icons";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { Idx, PageBody, PageHeader, Panel, Segmented, StatCard } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";
import { fetchFleetAnalytics } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { FleetAnalytics } from "@/lib/types";

const WINDOWS = [7, 30, 90] as const;

const TYPE_COLORS: Record<string, string> = {
  anomaly: "from-danger/70 to-danger",
  "shelf-life-threshold": "from-warn/70 to-warn",
  "door-open-too-long": "from-royal-400 to-peri-200",
};

function HBar({
  rank,
  label,
  value,
  max,
  total,
  colorClass,
}: {
  rank: number;
  label: string;
  value: number;
  max: number;
  total: number;
  colorClass: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="group">
      <div className="mb-2 flex items-baseline gap-3">
        <Idx n={rank} />
        <span className="flex-1 truncate text-[13px] text-peri-100">{label}</span>
        <span className="font-mono text-[10px] text-faint">{share}%</span>
        <span className="display num w-12 text-right text-2xl text-white">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${colorClass} transition-[width] duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function AnalyticsView() {
  const { token } = useAuth();
  const [days, setDays] = useState<number>(30);

  const { data, error, errorStatus, loading, refresh } = usePolling<FleetAnalytics>(
    () => fetchFleetAnalytics(token as string, days),
    [token, days],
    15000
  );

  const maxTypeCount = data ? Math.max(1, ...data.by_type.map((t) => t.count)) : 1;
  const sortedTypes = data ? [...data.by_type].sort((a, b) => b.count - a.count) : [];
  const sortedByTruck = data ? [...data.by_truck].sort((a, b) => b.alert_count - a.alert_count) : [];
  const maxTruckCount = sortedByTruck.length ? Math.max(1, ...sortedByTruck.map((t) => t.alert_count)) : 1;
  const shipmentsTotal = data ? data.shipments_active + data.shipments_completed : 0;
  const perShipment = data && shipmentsTotal > 0 ? (data.total_alerts / shipmentsTotal).toFixed(1) : "0";

  return (
    <>
      <PageHeader
        eyebrow="Fleet analytics"
        title={
          <>
            Proven impact,
            <br />
            measured.
          </>
        }
        description="Fleet-wide alert and shipment trends over a trailing window."
        page={[3, 4]}
        actions={
          <Segmented
            onDark
            options={WINDOWS.map((w) => ({ label: `${w} days`, value: w as number }))}
            value={days}
            onChange={setDays}
          />
        }
      >
        {data && !error && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            <StatCard index={0} icon={<TrendIcon />} value={data.shipments_active} label="Active shipments" hint="Currently pending or in transit" />
            <StatCard index={1} icon={<CheckIcon />} value={data.shipments_completed} label="Completed shipments" hint={`Delivered in the last ${data.period_days} days`} />
            <StatCard index={2} icon={<BoxIcon />} value={perShipment} label="Alerts per shipment" hint="Average across active + completed" />
            <StatCard
              index={3}
              highlight
              icon={<BellIcon />}
              value={data.total_alerts}
              label="Total alerts"
              hint={`Raised fleet-wide in the last ${data.period_days} days`}
            />
          </div>
        )}
      </PageHeader>

      <PageBody>
        {loading && !data && <LoadingState label="Loading analytics..." />}
        {error && <ErrorState error={error} status={errorStatus} onRetry={refresh} />}

        {data && !error && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel index={1} title="Alerts by type" subtitle="Which kinds of excursion happen most.">
              {sortedTypes.every((t) => t.count === 0) ? (
                <EmptyState title="No alerts in this window" />
              ) : (
                <div className="space-y-5">
                  {sortedTypes.map((t, i) => (
                    <HBar
                      key={t.type}
                      rank={i + 1}
                      label={alertTypeLabel(t.type)}
                      value={t.count}
                      max={maxTypeCount}
                      total={data.total_alerts}
                      colorClass={TYPE_COLORS[t.type] || "from-peri-100/40 to-peri-100/70"}
                    />
                  ))}
                </div>
              )}
            </Panel>

            <Panel index={2} title="Alerts by truck" subtitle="Ranked -- the trucks that need attention first.">
              {sortedByTruck.length === 0 ? (
                <EmptyState title="No alerts in this window" />
              ) : (
                <div className="space-y-5">
                  {sortedByTruck.map((t, i) => (
                    <HBar
                      key={t.truck_id}
                      rank={i + 1}
                      label={t.truck_label}
                      value={t.alert_count}
                      max={maxTruckCount}
                      total={data.total_alerts}
                      colorClass="from-royal-500 to-peri-200"
                    />
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </PageBody>
    </>
  );
}

export default function AnalyticsPage() {
  return (
    <RequireAuth>
      <AnalyticsView />
    </RequireAuth>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { RequireAuth } from "@/components/RequireAuth";
import { StatusBadge } from "@/components/Badges";
import { BellIcon, HourglassIcon, SignalIcon, TruckIcon } from "@/components/Icons";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { Meter, PageBody, PageHeader, Panel, StatCard } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";
import { fetchFleet } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { FleetShipment } from "@/lib/types";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function fmtTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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

function isOnline(iso: string | null) {
  return !!iso && Date.now() - new Date(iso).getTime() < ONLINE_WINDOW_MS;
}

function categoryLabel(c: string) {
  return c.replace(/_generic$/, "").replace(/_/g, " ");
}

function FleetStats({ data }: { data: FleetShipment[] }) {
  const inTransit = data.filter((s) => s.status === "in-transit").length;
  const openAlerts = data.reduce((sum, s) => sum + s.open_alert_count, 0);
  const online = data.filter((s) => isOnline(s.device_last_seen_at)).length;
  const withDevice = data.filter((s) => s.device_id).length;
  const atRisk = data.filter((s) => (s.shelf_life_consumed_fraction ?? 0) >= 0.8).length;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      <StatCard index={0} icon={<TruckIcon />} value={inTransit} label="In transit" hint={`${data.length} shipments tracked in total`} />
      <StatCard
        index={1}
        icon={<SignalIcon />}
        value={
          <>
            {online}
            <span className="text-[1.6rem] opacity-50">/{withDevice}</span>
          </>
        }
        label="Devices online"
        hint="Reported in the last 5 minutes"
      />
      <StatCard index={2} icon={<HourglassIcon />} value={atRisk} label="Shelf life at risk" hint="80% or more of shelf life consumed" />
      <StatCard
        index={3}
        highlight
        icon={<BellIcon />}
        value={openAlerts}
        label="Open alerts"
        hint={openAlerts > 0 ? "Unacknowledged across the fleet" : "Fleet is quiet right now"}
      >
        {openAlerts > 0 && (
          <Link href="/alerts" className="mt-3 self-start text-[11px] font-medium text-royal-600 hover:underline">
            Review alerts &rarr;
          </Link>
        )}
      </StatCard>
    </div>
  );
}

function FleetTable({ data }: { data: FleetShipment[] }) {
  const router = useRouter();
  return (
    <Panel
      index={1}
      title="Shipments"
      subtitle="Every truck/device, its current shipment, status, and last-seen time. Refreshes every 5s."
      bodyClassName="overflow-x-auto"
    >
      <table className="data-table min-w-[960px]">
        <thead>
          <tr>
            <th>Truck</th>
            <th>Shipment</th>
            <th>Status</th>
            <th>Latest temp</th>
            <th>Door</th>
            <th className="w-40">Shelf life used</th>
            <th>Alerts</th>
            <th>Device</th>
          </tr>
        </thead>
        <tbody>
          {data.map((s) => {
            const online = isOnline(s.device_last_seen_at);
            return (
              <tr key={s.id} className="cursor-pointer" onClick={() => router.push(`/shipments/${s.id}`)}>
                <td>
                  <Link
                    href={`/shipments/${s.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-medium text-white hover:text-peri-200"
                  >
                    {s.truck_label}
                  </Link>
                  {s.truck_plate && <div className="mt-0.5 font-mono text-[10px] text-faint">{s.truck_plate}</div>}
                </td>
                <td>
                  <div className="text-peri-100">{s.label || s.id.slice(0, 8)}</div>
                  <div className="mt-0.5 text-[11px] capitalize text-faint">{categoryLabel(s.category)}</div>
                </td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td>
                  {s.latest_temp_c != null ? (
                    <>
                      <span className="display num text-[1.35rem] text-white">{s.latest_temp_c.toFixed(1)}</span>
                      <span className="ml-0.5 text-xs text-faint">&deg;C</span>
                      <div className="text-[10px] text-faint">{fmtTime(s.latest_reading_ts)}</div>
                    </>
                  ) : (
                    <span className="text-faint">-</span>
                  )}
                </td>
                <td>
                  {s.latest_door_open == null ? (
                    <span className="text-faint">-</span>
                  ) : s.latest_door_open ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-warn">
                      <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                      Open
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-dim">
                      <span className="h-1.5 w-1.5 rounded-full bg-peri-100/40" />
                      Closed
                    </span>
                  )}
                </td>
                <td>
                  {s.shelf_life_consumed_fraction != null ? (
                    <div className="w-36">
                      <div className="mb-1.5 flex justify-between text-[11px]">
                        <span className="num text-peri-100">{(s.shelf_life_consumed_fraction * 100).toFixed(1)}%</span>
                      </div>
                      <Meter fraction={s.shelf_life_consumed_fraction} />
                    </div>
                  ) : (
                    <span className="text-faint">-</span>
                  )}
                </td>
                <td>
                  {s.open_alert_count > 0 ? (
                    <span className="num inline-flex min-w-6 items-center justify-center rounded-[2px] bg-danger/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-danger">
                      {s.open_alert_count}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-faint">0</span>
                  )}
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-ok shadow-[0_0_8px_var(--ok)]" : "bg-peri-100/25"}`} />
                    <div>
                      <div className="text-xs text-peri-100">{s.device_name || s.device_id || "-"}</div>
                      <div className="text-[10px] text-faint">{lastSeenAgo(s.device_last_seen_at)}</div>
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function FleetView() {
  const { token } = useAuth();
  const { data, error, errorStatus, loading, refresh } = usePolling<FleetShipment[]>(
    () => fetchFleet(token as string),
    [token],
    5000
  );

  return (
    <>
      <PageHeader
        eyebrow="Fleet overview"
        title={
          <>
            Every truck,
            <br />
            every degree.
          </>
        }
        description="Live status of each truck, its device, and the shipment it's carrying -- temperature, door state, and shelf life at a glance."
        page={[1, 4]}
      >
        {data && data.length > 0 && <FleetStats data={data} />}
      </PageHeader>
      <PageBody>
        {loading && !data ? (
          <LoadingState label="Loading fleet..." />
        ) : error ? (
          <ErrorState error={error} status={errorStatus} onRetry={refresh} />
        ) : !data || data.length === 0 ? (
          <EmptyState
            title="No shipments yet"
            hint="Register a device and run the setup wizard from the phone bridge to see it appear here."
          />
        ) : (
          <FleetTable data={data} />
        )}
      </PageBody>
    </>
  );
}

export default function FleetPage() {
  return (
    <RequireAuth>
      <FleetView />
    </RequireAuth>
  );
}

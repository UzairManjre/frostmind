"use client";

import { useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { AlertList } from "@/components/AlertList";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { PageBody, PageHeader, Segmented } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";
import { acknowledgeAlert, fetchAlerts } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { Alert, AlertType } from "@/lib/types";

const TYPE_FILTERS: { label: string; value: AlertType | "" }[] = [
  { label: "All types", value: "" },
  { label: "Anomaly", value: "anomaly" },
  { label: "Shelf-life threshold", value: "shelf-life-threshold" },
  { label: "Door open too long", value: "door-open-too-long" },
];

function AlertsView() {
  const { token } = useAuth();
  const [typeFilter, setTypeFilter] = useState<AlertType | "">("");
  const [showAcked, setShowAcked] = useState(false);

  const { data, error, errorStatus, loading, refresh } = usePolling<Alert[]>(
    () =>
      fetchAlerts(token as string, {
        type: typeFilter || undefined,
        acknowledged: showAcked ? undefined : false,
        limit: 200,
      }),
    [token, typeFilter, showAcked],
    5000
  );

  async function handleAck(id: string) {
    if (!token) return;
    await acknowledgeAlert(token, id, true);
    refresh();
  }

  const critical = data?.filter((a) => a.severity === "critical" || a.severity === "high").length ?? 0;

  return (
    <>
      <PageHeader
        variant="deep"
        eyebrow="Incident feed"
        title="Alerts"
        description="Anomaly detections, shelf-life-threshold breaches and door events across the whole fleet. Refreshes every 5s."
        page={[2, 4]}
        actions={
          data && (
            <div className="flex gap-3">
              <div className="glass min-w-28 px-4 py-3 text-white">
                <p className="display num text-3xl">{data.length}</p>
                <p className="text-[11px] text-peri-100/70">{showAcked ? "Shown" : "Unacknowledged"}</p>
              </div>
              <div className="highlight min-w-28 px-4 py-3">
                <p className="display num text-3xl">{critical}</p>
                <p className="text-[11px] text-ink-950/60">High / critical</p>
              </div>
            </div>
          )
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented options={TYPE_FILTERS} value={typeFilter} onChange={setTypeFilter} />
          <label className="flex cursor-pointer select-none items-center gap-2.5 text-xs text-dim">
            <span className="relative inline-flex">
              <input
                type="checkbox"
                checked={showAcked}
                onChange={(e) => setShowAcked(e.target.checked)}
                className="peer sr-only"
              />
              <span className="h-5 w-9 rounded-full border border-line-strong bg-ink-950 transition-colors peer-checked:border-royal-400 peer-checked:bg-royal-500 peer-focus-visible:ring-2 peer-focus-visible:ring-royal-300" />
              <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-peri-100 transition-transform peer-checked:translate-x-4 peer-checked:bg-white" />
            </span>
            Show acknowledged
          </label>
        </div>

        {loading && !data && <LoadingState label="Loading alerts..." />}
        {error && <ErrorState error={error} status={errorStatus} onRetry={refresh} />}
        {!error && data && data.length === 0 && (
          <EmptyState
            title="No alerts matching this filter"
            hint={showAcked || typeFilter ? "Try widening the filter above." : "The fleet is quiet -- no unacknowledged alerts right now."}
          />
        )}
        {!error && data && data.length > 0 && <AlertList alerts={data} showShipment onAcknowledge={handleAck} />}
      </PageBody>
    </>
  );
}

export default function AlertsPage() {
  return (
    <RequireAuth>
      <AlertsView />
    </RequireAuth>
  );
}

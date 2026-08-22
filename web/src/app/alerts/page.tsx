"use client";

import { useState } from "react";
import Link from "next/link";
import { RequireAuth } from "@/components/RequireAuth";
import { SeverityBadge, AlertTypeBadge } from "@/components/Badges";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
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

function AlertsFeed() {
  const { token } = useAuth();
  const [typeFilter, setTypeFilter] = useState<AlertType | "">("");
  const [showAcked, setShowAcked] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as AlertType | "")}
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
        >
          {TYPE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          <input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} />
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

      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
          <table className="w-full min-w-[800px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-slate-400">
                <th className="py-2 px-4">Time</th>
                <th className="py-2 px-4">Type</th>
                <th className="py-2 px-4">Severity</th>
                <th className="py-2 px-4">Message</th>
                <th className="py-2 px-4">Shipment</th>
                <th className="py-2 px-4">AI analysis</th>
                <th className="py-2 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => {
                const hasLlm = a.llm_assessment || a.llm_recommended_action || a.llm_narrative;
                const isOpen = expanded.has(a.id);
                return (
                  <>
                    <tr key={a.id} className="border-b border-slate-900">
                      <td className="py-2 px-4 whitespace-nowrap text-slate-400">{new Date(a.ts).toLocaleString()}</td>
                      <td className="py-2 px-4">
                        <AlertTypeBadge type={a.type} />
                      </td>
                      <td className="py-2 px-4">
                        <SeverityBadge severity={a.severity} />
                      </td>
                      <td className="py-2 px-4">{a.message}</td>
                      <td className="py-2 px-4">
                        <Link href={`/shipments/${a.shipment_id}`} className="text-sky-300 hover:underline">
                          {a.shipment_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-2 px-4">
                        {hasLlm ? (
                          <button
                            onClick={() => toggleExpanded(a.id)}
                            className="rounded border border-sky-800 bg-sky-950/40 px-2 py-1 text-xs text-sky-300 hover:bg-sky-900/40"
                          >
                            {isOpen ? "Hide" : "View"}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-600">pending / unavailable</span>
                        )}
                      </td>
                      <td className="py-2 px-4">
                        {!a.acknowledged && (
                          <button
                            onClick={() => handleAck(a.id)}
                            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                          >
                            Acknowledge
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && hasLlm && (
                      <tr key={`${a.id}-llm`} className="border-b border-slate-900 bg-slate-950/60">
                        <td colSpan={7} className="px-4 py-3 text-sm">
                          <div className="space-y-2">
                            {a.llm_assessment && (
                              <p>
                                <span className="font-medium text-slate-300">Assessment: </span>
                                <span className="text-slate-400">{a.llm_assessment}</span>
                              </p>
                            )}
                            {a.llm_recommended_action && (
                              <p>
                                <span className="font-medium text-slate-300">Recommended action: </span>
                                <span className="text-slate-400">{a.llm_recommended_action}</span>
                              </p>
                            )}
                            {a.llm_narrative && (
                              <p>
                                <span className="font-medium text-slate-300">Context: </span>
                                <span className="text-slate-400">{a.llm_narrative}</span>
                              </p>
                            )}
                            <p className="text-xs text-slate-600">
                              AI-generated, for human reference only -- never drives any automatic action.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AlertsPage() {
  return (
    <RequireAuth>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="mb-1 text-2xl font-semibold">Alerts</h1>
        <p className="mb-6 text-sm text-slate-400">
          Anomaly detections and shelf-life-threshold breaches across the whole fleet. Refreshes every 5s.
        </p>
        <AlertsFeed />
      </div>
    </RequireAuth>
  );
}

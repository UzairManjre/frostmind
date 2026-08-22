"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { RequireAuth } from "@/components/RequireAuth";
import { StatusBadge, SeverityBadge, AlertTypeBadge } from "@/components/Badges";
import { LiveChart } from "@/components/LiveChart";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { ThresholdSettings } from "@/components/ThresholdSettings";
import { ShipmentMap } from "@/components/ShipmentMap";
import { useAuth } from "@/lib/auth-context";
import { fetchFleet, fetchShipment, fetchReadings, fetchShipmentAlerts, generateComplianceReport } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { Alert, FleetShipment, SensorReading, Shipment } from "@/lib/types";

function ShelfLifeCard({ shipment }: { shipment: Shipment }) {
  const pct = shipment.shelf_life_consumed_fraction != null ? shipment.shelf_life_consumed_fraction * 100 : null;
  const barColor = pct == null ? "bg-slate-700" : pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-emerald-600";

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <h3 className="mb-2 text-sm font-medium text-slate-400">Shelf life (Model 3, Arrhenius)</h3>
      {pct == null ? (
        <p className="text-slate-500">No readings yet.</p>
      ) : (
        <>
          <div className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div className={`h-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <p className="text-lg font-semibold">{pct.toFixed(1)}% consumed</p>
          <p className="text-sm text-slate-400">
            {shipment.shelf_life_remaining_hours != null
              ? `${shipment.shelf_life_remaining_hours.toFixed(1)}h remaining at current temp`
              : "remaining time unavailable"}
          </p>
        </>
      )}
    </div>
  );
}

function AlertHistory({ alerts }: { alerts: Alert[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (alerts.length === 0) {
    return <EmptyState title="No alerts for this shipment yet" hint="Alerts appear here the moment a threshold or shelf-life crossing is detected." />;
  }
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
      <table className="w-full min-w-[600px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-left text-slate-400">
            <th className="py-2 px-4">Time</th>
            <th className="py-2 px-4">Type</th>
            <th className="py-2 px-4">Severity</th>
            <th className="py-2 px-4">Message</th>
            <th className="py-2 px-4">Ack&apos;d</th>
            <th className="py-2 px-4">AI analysis</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => {
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
                  <td className="py-2 px-4">{a.acknowledged ? "yes" : "no"}</td>
                  <td className="py-2 px-4">
                    {hasLlm ? (
                      <button
                        onClick={() => toggle(a.id)}
                        className="rounded border border-sky-800 bg-sky-950/40 px-2 py-1 text-xs text-sky-300 hover:bg-sky-900/40"
                      >
                        {isOpen ? "Hide" : "View"}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-600">pending / unavailable</span>
                    )}
                  </td>
                </tr>
                {isOpen && hasLlm && (
                  <tr key={`${a.id}-llm`} className="border-b border-slate-900 bg-slate-950/60">
                    <td colSpan={6} className="px-4 py-3 text-sm">
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
  );
}

function ComplianceReportPanel({ shipmentId }: { shipmentId: string }) {
  const { token } = useAuth();
  const [narrative, setNarrative] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "failed">("idle");

  async function handleGenerate() {
    if (!token) return;
    setStatus("loading");
    try {
      const report = await generateComplianceReport(token, shipmentId);
      if (report.narrative) {
        setNarrative(report.narrative);
        setStatus("done");
      } else {
        setStatus("failed");
      }
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-slate-300">Compliance report</h3>
          <p className="text-xs text-slate-500">
            AI-generated incident narrative from this shipment&apos;s full history -- generated fresh each time, not cached.
          </p>
        </div>
        <button
          onClick={handleGenerate}
          disabled={status === "loading"}
          className="rounded border border-sky-800 bg-sky-950/40 px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-900/40 disabled:opacity-50"
        >
          {status === "loading" ? "Generating..." : "Generate report"}
        </button>
      </div>
      {status === "failed" && (
        <p className="mt-3 text-sm text-amber-400">
          Couldn&apos;t generate a report right now (the local LLM may be unreachable or slow) -- try again.
        </p>
      )}
      {status === "done" && narrative && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{narrative}</p>
      )}
    </div>
  );
}

function ShipmentDetailBody({ id }: { id: string }) {
  const { token } = useAuth();

  const shipmentPoll = usePolling<Shipment>(() => fetchShipment(token as string, id), [token, id], 5000);
  const readingsPoll = usePolling<SensorReading[]>(() => fetchReadings(token as string, id, 500), [token, id], 5000);
  const alertsPoll = usePolling<Alert[]>(() => fetchShipmentAlerts(token as string, id), [token, id], 5000);
  // GPS (plan §5): the backend contract only guarantees latest_lat/latest_lng on the fleet-list
  // endpoint (FleetShipmentOut), not the single-shipment GET -- so this polls the fleet list too
  // and picks out this shipment's row, rather than assuming a field the contract doesn't promise
  // on GET /shipments/{id}.
  const fleetPoll = usePolling<FleetShipment[]>(() => fetchFleet(token as string), [token], 5000);
  const fleetEntry = fleetPoll.data?.find((s) => s.id === id);

  if (shipmentPoll.loading && !shipmentPoll.data) return <LoadingState label="Loading shipment..." />;
  if (shipmentPoll.error) return <ErrorState error={shipmentPoll.error} status={shipmentPoll.errorStatus} onRetry={shipmentPoll.refresh} />;
  if (!shipmentPoll.data) return null;

  const shipment = shipmentPoll.data;
  const readings = readingsPoll.data || [];
  const alerts = alertsPoll.data || [];
  const anomalyCount = readings.filter((r) => r.is_anomaly).length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-sky-300 hover:underline">
          &larr; Back to fleet
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{shipment.label || shipment.id}</h1>
          <StatusBadge status={shipment.status} />
        </div>
        <p className="text-sm text-slate-400">
          Category: {shipment.category} &middot; Started: {shipment.start_time ? new Date(shipment.start_time).toLocaleString() : "-"}
          {shipment.end_time && ` · Ended: ${new Date(shipment.end_time).toLocaleString()}`}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ShelfLifeCard shipment={shipment} />
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-400">Anomaly flags (this window)</h3>
          <p className="text-lg font-semibold">{anomalyCount} of {readings.length} readings flagged</p>
          <p className="text-sm text-slate-400">
            Shown as red markers on the chart below. Source: the device&apos;s own on-device
            threshold rule (Model 1 ML scoring isn&apos;t wired up yet -- see backend/README.md
            &quot;Model 1 status&quot;).
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <h3 className="mb-3 text-sm font-medium text-slate-400">Temperature / humidity / door history</h3>
        {readingsPoll.loading && !readingsPoll.data ? (
          <LoadingState label="Loading readings..." />
        ) : readingsPoll.error && !readings.length ? (
          <ErrorState error={readingsPoll.error} status={readingsPoll.errorStatus} onRetry={readingsPoll.refresh} />
        ) : (
          <>
            {readingsPoll.error && (
              <p className="mb-2 text-xs text-red-400">Last refresh failed ({readingsPoll.error}) -- showing the last data received.</p>
            )}
            <LiveChart readings={readings} />
            <div className="mt-2 flex gap-4 text-xs text-slate-500">
              <span><span className="inline-block h-2 w-2 rounded-full bg-[#7fd4ff] align-middle" /> temperature</span>
              <span><span className="inline-block h-2 w-2 rounded-full bg-[#38bdf8] align-middle" /> humidity</span>
              <span><span className="inline-block h-2 w-2 rounded-full bg-[#ff6b6b] align-middle" /> anomaly</span>
              <span><span className="inline-block h-2 w-2 bg-amber-500/40 align-middle" /> door open</span>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-400">Location</h3>
          <ShipmentMap lat={fleetEntry?.latest_lat} lng={fleetEntry?.latest_lng} />
        </div>
        <ThresholdSettings token={token as string} shipment={shipment} onUpdated={shipmentPoll.refresh} />
      </div>

      <div>
        <h3 className="mb-3 text-sm font-medium text-slate-400">Alert history</h3>
        {alertsPoll.loading && !alertsPoll.data ? (
          <LoadingState label="Loading alerts..." />
        ) : alertsPoll.error && !alerts.length ? (
          <ErrorState error={alertsPoll.error} status={alertsPoll.errorStatus} onRetry={alertsPoll.refresh} />
        ) : (
          <AlertHistory alerts={alerts} />
        )}
      </div>

      <ComplianceReportPanel shipmentId={id} />
    </div>
  );
}

export default function ShipmentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  return (
    <RequireAuth>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <ShipmentDetailBody id={id} />
      </div>
    </RequireAuth>
  );
}

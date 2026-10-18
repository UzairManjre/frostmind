"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { RequireAuth } from "@/components/RequireAuth";
import { StatusBadge } from "@/components/Badges";
import { AlertList } from "@/components/AlertList";
import { ArrowLeftIcon, DoorIcon, HourglassIcon, PinIcon, PulseIcon, SparkIcon, ThermometerIcon } from "@/components/Icons";
import { CHART_COLORS, LiveChart } from "@/components/LiveChart";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { ThresholdSettings } from "@/components/ThresholdSettings";
import { ShipmentMap } from "@/components/ShipmentMap";
import { Idx, Meter, PageBody, PageHeader, Panel, StatCard } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";
import { fetchFleet, fetchShipment, fetchReadings, fetchShipmentAlerts, generateComplianceReport } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { Alert, FleetShipment, SensorReading, Shipment } from "@/lib/types";

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "-";
}

function ShelfLifeCard({ shipment }: { shipment: Shipment }) {
  const fraction = shipment.shelf_life_consumed_fraction;
  return (
    <StatCard
      index={3}
      highlight
      icon={<HourglassIcon />}
      value={fraction != null ? `${(fraction * 100).toFixed(1)}%` : "-"}
      label="Shelf life consumed"
      hint={
        fraction == null
          ? "No readings yet."
          : shipment.shelf_life_remaining_hours != null
            ? `${shipment.shelf_life_remaining_hours.toFixed(1)}h remaining at current temp (Model 3, Arrhenius)`
            : "Remaining time unavailable"
      }
    >
      {fraction != null && <Meter fraction={fraction} className="mt-3 !bg-ink-950/10" />}
    </StatCard>
  );
}

function ComplianceReportPanel({ shipmentId, index }: { shipmentId: string; index: number }) {
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
    <Panel
      index={index}
      title="Compliance report"
      subtitle="AI-generated incident narrative from this shipment's full history -- generated fresh each time, not cached."
      action={
        <button onClick={handleGenerate} disabled={status === "loading"} className="btn btn-primary">
          <SparkIcon className="h-4 w-4 text-royal-600" />
          {status === "loading" ? "Generating..." : status === "done" ? "Regenerate" : "Generate report"}
        </button>
      }
      bodyClassName={status === "idle" ? "hidden" : "p-5"}
    >
      {status === "loading" && (
        <div className="space-y-2">
          {[92, 100, 76].map((w, i) => (
            <div key={i} className="h-2.5 animate-pulse rounded-full bg-white/[0.07]" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
      {status === "failed" && (
        <p className="text-xs text-warn">
          Couldn&apos;t generate a report right now (the local LLM may be unreachable or slow) -- try again.
        </p>
      )}
      {status === "done" && narrative && (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-peri-100">{narrative}</p>
      )}
    </Panel>
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

  if (shipmentPoll.loading && !shipmentPoll.data) {
    return (
      <PageBody>
        <LoadingState label="Loading shipment..." />
      </PageBody>
    );
  }
  if (shipmentPoll.error) {
    return (
      <PageBody>
        <ErrorState error={shipmentPoll.error} status={shipmentPoll.errorStatus} onRetry={shipmentPoll.refresh} />
      </PageBody>
    );
  }
  if (!shipmentPoll.data) return null;

  const shipment = shipmentPoll.data;
  const readings = readingsPoll.data || [];
  const alerts = alertsPoll.data || [];
  const anomalyCount = readings.filter((r) => r.is_anomaly).length;
  const latest = readings.length ? readings[readings.length - 1] : null;
  const latestTemp = fleetEntry?.latest_temp_c ?? latest?.temp_c ?? null;
  const latestDoor = fleetEntry?.latest_door_open ?? latest?.door_open ?? null;

  const meta = [
    { label: "Truck", value: fleetEntry ? `${fleetEntry.truck_label}${fleetEntry.truck_plate ? ` · ${fleetEntry.truck_plate}` : ""}` : "-" },
    { label: "Category", value: shipment.category.replace(/_/g, " ") },
    { label: "Started", value: fmtDate(shipment.start_time) },
    ...(shipment.end_time ? [{ label: "Ended", value: fmtDate(shipment.end_time) }] : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow={`Shipment · ${shipment.id.slice(0, 8)}`}
        title={shipment.label || shipment.id}
        description={
          <span className="mt-1 flex flex-wrap gap-x-6 gap-y-2">
            {meta.map((m, i) => (
              <span key={m.label} className="inline-flex items-baseline gap-1.5">
                <Idx n={i + 1} className="!text-peri-100/50" />
                <span className="text-peri-100/60">{m.label}</span>
                <span className="capitalize text-white">{m.value}</span>
              </span>
            ))}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={shipment.status} />
            <Link href="/" className="btn btn-ghost btn-sm !border-white/25 !text-white">
              <ArrowLeftIcon className="h-3.5 w-3.5" />
              Fleet
            </Link>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <StatCard
            index={0}
            icon={<ThermometerIcon />}
            value={latestTemp != null ? `${latestTemp.toFixed(1)}°` : "-"}
            label="Latest temp"
            hint={latest ? `Humidity ${latest.humidity != null ? `${latest.humidity.toFixed(0)}%` : "-"}` : "No readings yet"}
          />
          <StatCard
            index={1}
            icon={<DoorIcon />}
            value={latestDoor == null ? "-" : latestDoor ? "Open" : "Closed"}
            label="Door"
            hint="Most recent reading"
          />
          <StatCard
            index={2}
            icon={<PulseIcon />}
            value={
              <>
                {anomalyCount}
                <span className="text-[1.6rem] opacity-50">/{readings.length}</span>
              </>
            }
            label="Anomaly flags"
            hint="Device's on-device threshold rule (Model 1 ML scoring isn't wired up yet)"
          />
          <ShelfLifeCard shipment={shipment} />
        </div>
      </PageHeader>

      <PageBody>
        <Panel
          index={1}
          title="Temperature / humidity / door history"
          subtitle="Anomaly-flagged readings show as red markers; amber bands are door-open spans."
          action={
            <div className="flex flex-wrap gap-4 text-[11px] text-dim">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-4" style={{ background: CHART_COLORS.temp }} /> Temperature
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-0 w-4 border-t border-dashed" style={{ borderColor: CHART_COLORS.humidity }} /> Humidity
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS.anomaly }} /> Anomaly
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-3" style={{ background: "rgba(255,198,92,0.25)", borderTop: `2px solid ${CHART_COLORS.door}` }} /> Door open
              </span>
            </div>
          }
        >
          {readingsPoll.loading && !readingsPoll.data ? (
            <LoadingState label="Loading readings..." />
          ) : readingsPoll.error && !readings.length ? (
            <ErrorState error={readingsPoll.error} status={readingsPoll.errorStatus} onRetry={readingsPoll.refresh} />
          ) : (
            <>
              {readingsPoll.error && (
                <p className="mb-2 text-xs text-danger">Last refresh failed ({readingsPoll.error}) -- showing the last data received.</p>
              )}
              <LiveChart readings={readings} />
            </>
          )}
        </Panel>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel
            index={2}
            title="Location"
            subtitle="Last GPS fix reported by the driver's phone."
            action={
              <span className="icon-tile">
                <PinIcon className="h-4 w-4" />
              </span>
            }
          >
            <ShipmentMap lat={fleetEntry?.latest_lat} lng={fleetEntry?.latest_lng} />
          </Panel>
          <ThresholdSettings index={3} token={token as string} shipment={shipment} onUpdated={shipmentPoll.refresh} />
        </div>

        <section className="space-y-3">
          <div className="flex items-baseline gap-2">
            <Idx n={4} />
            <h2 className="text-sm font-medium text-peri-50">Alert history</h2>
            {alerts.length > 0 && <span className="font-mono text-[11px] text-faint">{alerts.length}</span>}
          </div>
          {alertsPoll.loading && !alertsPoll.data ? (
            <LoadingState label="Loading alerts..." />
          ) : alertsPoll.error && !alerts.length ? (
            <ErrorState error={alertsPoll.error} status={alertsPoll.errorStatus} onRetry={alertsPoll.refresh} />
          ) : alerts.length === 0 ? (
            <EmptyState
              title="No alerts for this shipment yet"
              hint="Alerts appear here the moment a threshold or shelf-life crossing is detected."
            />
          ) : (
            <AlertList alerts={alerts} />
          )}
        </section>

        <ComplianceReportPanel shipmentId={id} index={5} />
      </PageBody>
    </>
  );
}

export default function ShipmentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  return (
    <RequireAuth>
      <ShipmentDetailBody id={id} />
    </RequireAuth>
  );
}

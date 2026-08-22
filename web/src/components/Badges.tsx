import type { AlertSeverity, ShipmentStatus } from "@/lib/types";

const STATUS_STYLES: Record<ShipmentStatus, string> = {
  pending: "bg-slate-700 text-slate-200",
  "in-transit": "bg-sky-700 text-sky-100",
  delivered: "bg-emerald-700 text-emerald-100",
};

export function StatusBadge({ status }: { status: ShipmentStatus }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  low: "bg-slate-700 text-slate-200",
  medium: "bg-amber-700 text-amber-100",
  high: "bg-orange-700 text-orange-100",
  critical: "bg-red-700 text-red-100",
};

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${SEVERITY_STYLES[severity]}`}>
      {severity}
    </span>
  );
}

export function AlertTypeBadge({ type }: { type: string }) {
  return <span className="inline-block rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-300">{type}</span>;
}

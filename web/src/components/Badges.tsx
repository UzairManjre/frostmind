import type { AlertSeverity, ShipmentStatus } from "@/lib/types";

const STATUS_STYLES: Record<ShipmentStatus, { cls: string; dot: string; label: string }> = {
  pending: { cls: "border-line-strong text-peri-100/70", dot: "bg-peri-100/50", label: "Pending" },
  "in-transit": { cls: "border-royal-300/50 bg-royal-500/20 text-peri-100", dot: "bg-royal-300", label: "In transit" },
  delivered: { cls: "border-ok/35 bg-ok/10 text-ok", dot: "bg-ok", label: "Delivered" },
};

export function StatusBadge({ status }: { status: ShipmentStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[2px] border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      <span className="relative flex h-1.5 w-1.5">
        {status === "in-transit" && <span className={`absolute inset-0 animate-ping rounded-full opacity-75 ${s.dot}`} />}
        <span className={`relative h-1.5 w-1.5 rounded-full ${s.dot}`} />
      </span>
      {s.label}
    </span>
  );
}

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  low: "border-line-strong text-peri-100/70",
  medium: "border-warn/40 bg-warn/10 text-warn",
  high: "border-hot/40 bg-hot/10 text-hot",
  critical: "border-danger/50 bg-danger/15 text-danger",
};

export const SEVERITY_BAR: Record<AlertSeverity, string> = {
  low: "bg-peri-100/30",
  medium: "bg-warn",
  high: "bg-hot",
  critical: "bg-danger",
};

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <span
      className={`inline-block rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ${SEVERITY_STYLES[severity]}`}
    >
      {severity}
    </span>
  );
}

const TYPE_LABELS: Record<string, string> = {
  anomaly: "Anomaly",
  "shelf-life-threshold": "Shelf-life threshold",
  "door-open-too-long": "Door open too long",
};

export function alertTypeLabel(type: string) {
  return TYPE_LABELS[type] ?? type;
}

export function AlertTypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-[2px] bg-white/[0.06] px-2 py-0.5 text-[11px] text-peri-100/80">
      {alertTypeLabel(type)}
    </span>
  );
}

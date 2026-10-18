"use client";

// One alert row layout shared by the fleet-wide Alerts page and the shipment detail page's alert
// history (previously two copy-pasted tables). Each row can expand to show the LLM analysis
// (FROSTMIND_LLM_Orchestration_Plan.md, Role A) as a numbered list.

import Link from "next/link";
import { useState } from "react";
import { AlertTypeBadge, SEVERITY_BAR, SeverityBadge } from "@/components/Badges";
import { CheckIcon, ChevronDownIcon, SparkIcon } from "@/components/Icons";
import { Idx } from "@/components/ui";
import type { Alert } from "@/lib/types";

function fmtTime(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

function LlmPanel({ alert }: { alert: Alert }) {
  const items = [
    { label: "Assessment", text: alert.llm_assessment },
    { label: "Recommended action", text: alert.llm_recommended_action },
    { label: "Context", text: alert.llm_narrative },
  ].filter((i): i is { label: string; text: string } => !!i.text);

  return (
    <div className="border-t border-line bg-ink-950/50 px-5 py-4">
      <ol className="grid gap-3 md:grid-cols-3">
        {items.map((item, i) => (
          <li key={item.label} className={`rounded-[3px] p-4 ${i === 0 ? "highlight" : "glass"}`}>
            <div className="flex items-center justify-between">
              <span className={`text-xs font-medium ${i === 0 ? "text-ink-950" : "text-peri-50"}`}>{item.label}</span>
              <Idx n={i + 1} className={i === 0 ? "!text-ink-950/50" : ""} />
            </div>
            <p className={`mt-2 text-xs leading-relaxed ${i === 0 ? "text-ink-950/70" : "text-dim"}`}>{item.text}</p>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[10px] text-faint">AI-generated, for human reference only -- never drives any automatic action.</p>
    </div>
  );
}

export function AlertList({
  alerts,
  showShipment = false,
  onAcknowledge,
}: {
  alerts: Alert[];
  showShipment?: boolean;
  onAcknowledge?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <ul className="panel divide-y divide-line overflow-hidden">
      {alerts.map((a) => {
        const hasLlm = !!(a.llm_assessment || a.llm_recommended_action || a.llm_narrative);
        const isOpen = expanded.has(a.id);
        const t = fmtTime(a.ts);
        return (
          <li key={a.id} className={a.acknowledged ? "opacity-60" : ""}>
            <div className="relative flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 transition-colors hover:bg-royal-500/[0.06]">
              <span className={`absolute inset-y-3 left-0 w-[2px] ${SEVERITY_BAR[a.severity]}`} aria-hidden="true" />
              <div className="w-20 shrink-0">
                <p className="num font-mono text-xs text-peri-100">{t.time}</p>
                <p className="text-[10px] text-faint">{t.date}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <SeverityBadge severity={a.severity} />
                <AlertTypeBadge type={a.type} />
              </div>
              <p className="min-w-[200px] flex-1 text-[13px] leading-snug text-peri-50">{a.message}</p>
              {showShipment && (
                <Link href={`/shipments/${a.shipment_id}`} className="font-mono text-[11px] text-royal-300 hover:text-peri-100">
                  #{a.shipment_id.slice(0, 8)}
                </Link>
              )}
              <div className="flex shrink-0 items-center gap-2">
                {hasLlm ? (
                  <button onClick={() => toggle(a.id)} className="btn btn-ghost btn-sm" aria-expanded={isOpen}>
                    <SparkIcon className="h-3.5 w-3.5 text-royal-300" />
                    AI analysis
                    <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                ) : (
                  <span className="text-[11px] text-faint" title="LLM analysis pending or unavailable">
                    AI pending
                  </span>
                )}
                {a.acknowledged ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-ok">
                    <CheckIcon className="h-3.5 w-3.5" />
                    Acknowledged
                  </span>
                ) : (
                  onAcknowledge && (
                    <button onClick={() => onAcknowledge(a.id)} className="btn btn-primary btn-sm">
                      Acknowledge
                    </button>
                  )
                )}
              </div>
            </div>
            {isOpen && hasLlm && <LlmPanel alert={a} />}
          </li>
        );
      })}
    </ul>
  );
}

"use client";

// AI Models -- one page that shows (and lets you verify) every AI component in FROSTMIND: what it
// does, whether it's live right now, the scores it was measured at (read from the
// models/*_metrics.json files the training scripts wrote), where it's used, and live usage counts.
// The LLM card has a one-click round-trip test. Backend: GET /ai/status, POST /ai/llm/test.

import Link from "next/link";
import { useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { ArrowUpRightIcon, BoxIcon, PulseIcon, SparkIcon } from "@/components/Icons";
import { ErrorState, LoadingState } from "@/components/StateViews";
import { PageBody, PageHeader, Panel, StatCard } from "@/components/ui";
import { useAuth } from "@/lib/auth-context";
import { fetchAiStatus, testLlm } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import type { AiComponent, AiStatus, LlmTestResult } from "@/lib/types";

const LIVE = new Set(["live"]);

function StatusPill({ status }: { status: string }) {
  const live = LIVE.has(status);
  const partial = status === "physics-only" || status === "rules-only";
  const cls = live
    ? "border-ok/50 bg-ok/10 text-ok"
    : partial
      ? "border-warn/50 bg-warn/10 text-warn"
      : "border-line-strong bg-white/5 text-faint";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "live-dot bg-ok" : partial ? "bg-warn" : "bg-faint"}`} />
      {status}
    </span>
  );
}

function fmt(v: number | string | null): string {
  if (v === null || v === undefined) return "--";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3);
  // model ids like "hf.co/unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL" -> "gemma-4-E4B-it-qat-GGUF"
  return v.includes("/") ? v.split("/").pop()!.split(":")[0] : v;
}

function LlmTest() {
  const { token } = useAuth();
  const [result, setResult] = useState<LlmTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mt-4 rounded-[3px] border border-line bg-ink-950/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint">Sends a real cold-chain question to the local LLM and shows the answer.</p>
        <button
          className="btn btn-royal btn-sm"
          disabled={busy || !token}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            setResult(null);
            try {
              setResult(await testLlm(token as string));
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Asking the LLM..." : "Test LLM now"}
        </button>
      </div>
      {busy && <div className="mt-3 h-12 animate-pulse rounded bg-white/5" />}
      {err && <p className="mt-3 text-xs text-danger">{err}</p>}
      {result && (
        <div className="mt-3 text-[13px]">
          {result.ok ? (
            <>
              <p className="leading-relaxed text-peri-50">&ldquo;{result.reply}&rdquo;</p>
              <p className="mt-2 font-mono text-[10px] text-faint">
                {result.model} · {(result.latency_ms / 1000).toFixed(1)} s
              </p>
            </>
          ) : (
            <p className="text-warn">No answer -- Ollama isn&apos;t reachable. Start it with `ollama serve` and try again.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ComponentCard({ c, index }: { c: AiComponent; index: number }) {
  const metrics = Object.entries(c.metrics).filter(([, v]) => v !== null && v !== undefined);
  const usage = Object.entries(c.usage);
  return (
    <Panel
      index={index}
      title={c.name}
      subtitle={c.kind}
      action={<StatusPill status={c.status} />}
    >
      <p className="text-[13px] leading-relaxed text-peri-100/85">{c.what}</p>
      <p className="mt-2 text-xs text-faint">
        <span className="text-peri-100/60">Used in:</span> {c.where}
      </p>
      {c.note && <p className="mt-2 rounded-[3px] border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">{c.note}</p>}
      {(metrics.length > 0 || usage.length > 0) && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {metrics.map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-wide text-faint">{k}</dt>
              <dd className="display num mt-0.5 break-words text-xl text-white" title={String(v)}>
                {fmt(v)}
              </dd>
            </div>
          ))}
          {usage.map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-wide text-faint">{k}</dt>
              <dd className="display num mt-0.5 text-xl text-royal-300">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {(c.key === "model4" || c.key === "model5") && (
        <Link href="/planner" className="btn btn-ghost btn-sm mt-4 inline-flex items-center gap-1.5">
          Try it in the Load Planner <ArrowUpRightIcon className="h-3.5 w-3.5" />
        </Link>
      )}
      {c.key === "llm" && <LlmTest />}
    </Panel>
  );
}

function AiView() {
  const { token } = useAuth();
  const { data, error, errorStatus, loading, refresh } = usePolling<AiStatus>(() => fetchAiStatus(token), [token], 20000);
  const live = data ? data.components.filter((c) => c.status === "live").length : 0;
  const llm = data?.components.find((c) => c.key === "llm");
  const m5 = data?.components.find((c) => c.key === "model5");
  const m4 = data?.components.find((c) => c.key === "model4");

  return (
    <>
      <PageHeader
        eyebrow="AI models"
        title={
          <>
            Every model,
            <br />
            verifiable.
          </>
        }
        description="What each AI component does, whether it is running right now, the scores it was measured at, and where in FROSTMIND it is used."
        page={[6, 6]}
      >
        {data && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            <StatCard index={0} highlight icon={<SparkIcon />} value={`${live}/${data.components.length}`} label="Components live" hint="Refreshed every 20 s" />
            <StatCard index={1} icon={<BoxIcon />} value={fmt(m5?.metrics["ROC-AUC on unseen products"] ?? null)} label="Model 5 ROC-AUC" hint="Compatibility, products it never saw" />
            <StatCard index={2} icon={<PulseIcon />} value={m4?.metrics["MAE on unseen products (C)"] != null ? `${fmt(m4.metrics["MAE on unseen products (C)"])} °C` : "--"} label="Model 4 error" hint="Setpoint MAE, unseen products" />
            <StatCard
              index={3}
              icon={<SparkIcon />}
              value={llm ? `${llm.usage["alerts with an AI explanation"] ?? 0}` : "--"}
              label="Alerts explained by AI"
              hint={llm?.metrics["model in use"] ? String(llm.metrics["model in use"]).split("/").pop() : "LLM not reachable"}
            />
          </div>
        )}
      </PageHeader>
      <PageBody>
        {loading && !data && <LoadingState label="Checking every AI component..." />}
        {error && <ErrorState error={error} status={errorStatus} onRetry={refresh} />}
        {data && (
          <div className="grid gap-6 lg:grid-cols-2">
            {data.components.map((c, i) => (
              <ComponentCard key={c.key} c={c} index={i + 1} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

export default function AiPage() {
  return (
    <RequireAuth>
      <AiView />
    </RequireAuth>
  );
}

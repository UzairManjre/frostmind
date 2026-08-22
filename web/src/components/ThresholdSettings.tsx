"use client";

// Configurable per-shipment alert thresholds (Prototype-to-Production plan §4). Backend contract
// (owned by a separate agent, see backend/README.md once it lands): PATCH /shipments/{id} takes
// optional `alert_rate_threshold_override` / `alert_deviation_threshold_override`, each
// `number | null` -- `null` means "clear the override, fall back to the category default".
// Ties to the shelf-life model already being category-aware (each of the 6 PRODUCT_LIBRARY
// categories has its own implicit rate-of-change/deviation tolerance; this lets an admin tighten
// or loosen that per shipment without touching the category itself).

import { useState } from "react";
import { updateShipmentThresholds } from "@/lib/api";
import type { Shipment } from "@/lib/types";

function ThresholdField({
  label,
  unitHint,
  value,
  onChange,
}: {
  label: string;
  unitHint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-sm text-slate-400">
      <span className="mb-1 flex items-center justify-between">
        <span>{label}</span>
        <span className="text-xs text-slate-500">{unitHint}</span>
      </span>
      <div className="flex gap-2">
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Using category default"
          className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-600"
        />
        {value !== "" && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="shrink-0 rounded border border-slate-700 px-2.5 text-xs text-slate-400 hover:bg-slate-800"
            title="Reset to category default"
          >
            Reset
          </button>
        )}
      </div>
    </label>
  );
}

export function ThresholdSettings({
  token,
  shipment,
  onUpdated,
}: {
  token: string;
  shipment: Shipment;
  onUpdated: () => void;
}) {
  // "" means "no override -- use category default" (renders via the input's placeholder, per
  // the plan's explicit ask: "Null/unset should read as 'using category default,' not a blank
  // number field"). A numeric string is a pending edit; it's only committed to the shipment on
  // Save.
  function toFieldValue(v: number | null | undefined) {
    return v != null ? String(v) : "";
  }

  // Tracks the last shipment-override values this form's fields were synced from, so a poll tick
  // that brings back genuinely new override values (e.g. edited elsewhere) can update the form --
  // without clobbering in-progress typing on every 5s refresh. Adjusting state during render
  // (rather than in a useEffect) is React's documented pattern for "reset state when a prop
  // changes"; it resolves within the same render pass instead of costing an extra committed one.
  const overrideKey = `${shipment.alert_rate_threshold_override ?? ""}|${shipment.alert_deviation_threshold_override ?? ""}`;
  const [syncedKey, setSyncedKey] = useState(overrideKey);
  const [rate, setRate] = useState(() => toFieldValue(shipment.alert_rate_threshold_override));
  const [deviation, setDeviation] = useState(() => toFieldValue(shipment.alert_deviation_threshold_override));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (overrideKey !== syncedKey && !saving) {
    setSyncedKey(overrideKey);
    setRate(toFieldValue(shipment.alert_rate_threshold_override));
    setDeviation(toFieldValue(shipment.alert_deviation_threshold_override));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const rateNum = rate.trim() === "" ? null : Number(rate);
      const deviationNum = deviation.trim() === "" ? null : Number(deviation);
      if (rateNum !== null && Number.isNaN(rateNum)) throw new Error("Rate threshold must be a number");
      if (deviationNum !== null && Number.isNaN(deviationNum)) throw new Error("Deviation threshold must be a number");

      await updateShipmentThresholds(token, shipment.id, {
        alert_rate_threshold_override: rateNum,
        alert_deviation_threshold_override: deviationNum,
      });
      setSavedAt(Date.now());
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <h3 className="mb-1 text-sm font-medium text-slate-400">Alert threshold overrides</h3>
      <p className="mb-3 text-xs text-slate-500">
        Per-shipment overrides for this category&apos;s default anomaly thresholds. Leave a field blank
        (or hit Reset) to fall back to the category default.
      </p>
      <form onSubmit={handleSave} className="space-y-3">
        <ThresholdField label="Rate-of-change threshold" unitHint="deg C / min" value={rate} onChange={setRate} />
        <ThresholdField label="Deviation threshold" unitHint="deg C from reference" value={deviation} onChange={setDeviation} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save thresholds"}
          </button>
          {savedAt && !saving && !error && <span className="text-xs text-emerald-400">Saved.</span>}
        </div>
      </form>
    </div>
  );
}

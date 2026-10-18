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
import { CheckIcon, SlidersIcon } from "@/components/Icons";
import { Panel } from "@/components/ui";

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
    <label className="block text-xs text-dim">
      <span className="mb-1.5 flex items-center justify-between">
        <span className="font-medium text-peri-100">{label}</span>
        <span className="font-mono text-[10px] text-faint">{unitHint}</span>
      </span>
      <div className="flex gap-2">
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Using category default"
          className="field num"
        />
        {value !== "" && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="btn btn-ghost shrink-0 !h-10"
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
  index,
}: {
  token: string;
  shipment: Shipment;
  onUpdated: () => void;
  index?: number;
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
    <Panel
      index={index}
      title="Alert threshold overrides"
      subtitle="Per-shipment overrides for this category's default anomaly thresholds. Leave a field blank (or hit Reset) to fall back to the category default."
      action={
        <span className="icon-tile">
          <SlidersIcon className="h-4 w-4" />
        </span>
      }
    >
      <form onSubmit={handleSave} className="space-y-4">
        <ThresholdField label="Rate-of-change threshold" unitHint="°C / min" value={rate} onChange={setRate} />
        <ThresholdField label="Deviation threshold" unitHint="°C from reference" value={deviation} onChange={setDeviation} />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex items-center gap-3 pt-1">
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? "Saving..." : "Save thresholds"}
          </button>
          {savedAt && !saving && !error && (
            <span className="inline-flex items-center gap-1 text-xs text-ok">
              <CheckIcon className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
        </div>
      </form>
    </Panel>
  );
}

"use client";

// Load Planner -- where Model 4 (mixed-load setpoint) and Model 5 (co-shipment compatibility)
// are used in the admin panel. A dispatcher picks the products (and kg) for a trip; the backend
// (POST /planner/plan, see backend/app/load_planner.py) returns which pairs can share a reefer,
// the products split into compatible groups (one compartment / truck each), and each group's
// recommended setpoint plus the FROSTMIND device category that applies it. Dependency-free like
// the analytics page -- plain CSS grid for the compatibility matrix, no charting library.

import { useMemo, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { ApiError, fetchProducts, fetchTrucks, planLoad } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { usePolling } from "@/lib/use-polling";
import type { PlanGroup, PlanPair, PlanResponse, Product, Truck } from "@/lib/types";

const CATEGORY_ORDER = ["fruit", "vegetable", "dairy", "eggs", "meat", "poultry", "seafood", "frozen", "pharma"];

const PRESETS: { label: string; items: string[] }[] = [
  { label: "Mixed grocery run", items: ["apples", "lettuce", "bananas_ripe", "milk_pasteurized", "poultry_fresh", "ice_cream"] },
  { label: "Fruit & veg wholesale", items: ["apples", "pears", "grapes", "broccoli", "lettuce", "cucumbers", "tomatoes_ripe", "mangos"] },
  { label: "Clinic + dairy", items: ["vaccines_refrigerated", "insulin_unopened", "milk_pasteurized", "yogurt", "cheese_hard_cheddar_swiss"] },
];

const METHOD_LABEL: Record<PlanGroup["method"], string> = {
  ml: "ML (Model 4)",
  physics: "Physics optimizer",
  physics_fallback: "Physics (ML disagreed)",
  infeasible: "No safe setpoint",
};

function fmt(v: number | null | undefined, digits = 1) {
  return v === null || v === undefined ? "--" : v.toFixed(digits);
}

function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function GroupCard({ group }: { group: PlanGroup }) {
  const [lo, hi] = group.safe_range_c;
  return (
    <div className={`rounded-lg border p-4 ${group.feasible ? "border-slate-800 bg-slate-900/40" : "border-red-900/60 bg-red-950/20"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Compartment {group.group_id}</p>
          <p className="mt-1 text-3xl font-semibold text-sky-300">
            {group.feasible ? `${fmt(group.recommended_setpoint_c)} °C` : "Split further"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Near-optimal band {fmt(group.band_c[0])} to {fmt(group.band_c[1])} °C · safe range {lo === null ? "−∞" : fmt(lo)} to{" "}
            {hi === null ? "+∞" : fmt(hi)} °C
          </p>
        </div>
        <span className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{METHOD_LABEL[group.method]}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
        <p>
          Physics check: <span className="text-slate-200">{fmt(group.physics_setpoint_c, 2)} °C</span>
        </p>
        <p>
          ML student: <span className="text-slate-200">{group.student_setpoint_c === null ? "--" : `${fmt(group.student_setpoint_c, 2)} °C`}</span>
        </p>
        {group.device_category_within_1c ? (
          <p className="col-span-2">
            Device category: <span className="text-slate-200">{group.device_category}</span> ({fmt(group.device_category_setpoint_c)} °C via BLE
            set_category)
          </p>
        ) : (
          <p className="col-span-2 text-amber-300/90">
            No FROSTMIND device category near this setpoint (nearest {fmt(group.device_category_setpoint_c)} °C) -- set the reefer manually.
          </p>
        )}
      </div>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="py-1 font-medium">Product</th>
            <th className="py-1 text-right font-medium">kg</th>
            <th className="py-1 text-right font-medium">Shelf life used / day</th>
          </tr>
        </thead>
        <tbody>
          {group.products.map((p) => (
            <tr key={p.product_id} className="border-t border-slate-800">
              <td className="py-1.5 text-slate-200">{p.name}</td>
              <td className="py-1.5 text-right text-slate-400">{p.quantity_kg}</td>
              <td className={`py-1.5 text-right ${p.expected_loss_pct_per_day > 20 ? "text-amber-400" : "text-slate-300"}`}>
                {p.expected_loss_pct_per_day.toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function CompatibilityMatrix({
  ids,
  names,
  pairs,
  selected,
  onSelect,
}: {
  ids: string[];
  names: Record<string, string>;
  pairs: Map<string, PlanPair>;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `minmax(9rem, auto) repeat(${ids.length}, 2.75rem)` }}>
        <div />
        {ids.map((id) => (
          <div key={id} className="relative h-32">
            <span className="absolute bottom-1 left-1/2 origin-bottom-left -rotate-45 whitespace-nowrap text-xs text-slate-400">{names[id]}</span>
          </div>
        ))}
        {ids.map((row) => (
          <div key={row} className="contents">
            <div className="truncate pr-2 text-right text-xs leading-9 text-slate-400">{names[row]}</div>
            {ids.map((col) => {
              if (row === col) return <div key={col} className="h-9 rounded bg-slate-900" />;
              const key = pairKey(row, col);
              const p = pairs.get(key);
              if (!p) return <div key={col} className="h-9 rounded bg-slate-900" />;
              const cls = p.vetoes.length
                ? "bg-red-900/70 text-red-100"
                : p.compatible
                  ? "bg-sky-600 text-white"
                  : "bg-slate-700 text-slate-200";
              return (
                <button
                  key={col}
                  onClick={() => onSelect(key)}
                  title={`${names[row]} + ${names[col]}: ${p.compatible ? "compatible" : "keep apart"}${p.probability !== null ? ` (p=${p.probability.toFixed(2)})` : ""}`}
                  className={`h-9 rounded text-[10px] font-medium ${cls} ${selected === key ? "ring-2 ring-white" : ""}`}
                >
                  {p.vetoes.length ? "✕" : p.probability !== null ? p.probability.toFixed(2) : p.compatible ? "✓" : "–"}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-sky-600" /> Compatible
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-slate-700" /> Keep apart (physical)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-red-900/70" /> Keep apart (regulation)
        </span>
        <span>Numbers = Model 5 probability of compatibility</span>
      </div>
    </div>
  );
}

function PlannerBody() {
  const { token } = useAuth();
  // The catalog is static reference data -- "polled" every 5 min only so a retrained catalog
  // shows up without a reload; usePolling also gives the shared loading/error handling.
  const catalog = usePolling<{ products: Product[]; trucks: Truck[] }>(
    async () => {
      const [products, trucks] = await Promise.all([fetchProducts(token), token ? fetchTrucks(token) : Promise.resolve([] as Truck[])]);
      return { products, trucks };
    },
    [token],
    300000
  );
  const products = catalog.data?.products ?? null;
  const trucks = catalog.data?.trucks ?? [];
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [truckId, setTruckId] = useState<string>("");
  const [sigma, setSigma] = useState<string>("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<{ msg: string; status: number | null } | null>(null);
  const [selectedPair, setSelectedPair] = useState<string | null>(null);

  const byId = useMemo(() => Object.fromEntries((products ?? []).map((p) => [p.product_id, p])), [products]);
  const names = useMemo(() => Object.fromEntries((products ?? []).map((p) => [p.product_id, p.name])), [products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? []).filter(
      (p) => (category === "all" || p.category === category) && (!q || p.name.toLowerCase().includes(q))
    );
  }, [products, query, category]);

  const pairMap = useMemo(() => new Map((plan?.pairs ?? []).map((p) => [pairKey(p.a, p.b), p])), [plan]);
  const planIds = useMemo(() => (plan ? plan.groups.flatMap((g) => g.products.map((p) => p.product_id)) : []), [plan]);

  const runPlan = async () => {
    if (!token || Object.keys(cart).length === 0) return;
    setPlanning(true);
    setPlanError(null);
    setSelectedPair(null);
    try {
      const res = await planLoad(token, {
        products: Object.entries(cart).map(([product_id, quantity_kg]) => ({ product_id, quantity_kg })),
        truck_id: truckId || null,
        sigma_c: sigma === "" ? null : Number(sigma),
      });
      setPlan(res);
    } catch (e) {
      const err = e as Error;
      setPlanError({ msg: err.message, status: e instanceof ApiError ? e.status : null });
    } finally {
      setPlanning(false);
    }
  };

  if (catalog.error && !products) return <ErrorState error={catalog.error} status={catalog.errorStatus} onRetry={catalog.refresh} />;
  if (!products) return <LoadingState label="Loading product catalog..." />;

  const selectedPairData = selectedPair ? pairMap.get(selectedPair) : undefined;
  const incompatible = (plan?.pairs ?? []).filter((p) => !p.compatible);

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      {/* ---------------- left: build the load ---------------- */}
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-300">1. Pick products</h3>
          <div className="mb-2 flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => setCart(Object.fromEntries(preset.items.filter((id) => byId[id]).map((id) => [id, 100])))}
                className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${products.length} products...`}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200"
          >
            <option value="all">All categories</option>
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-slate-800">
            {filtered.map((p) => (
              <li key={p.product_id} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-slate-200">
                  {p.name}
                  <span className="ml-1.5 text-xs text-slate-500">
                    {fmt(p.t_min_c)}–{fmt(p.t_max_c)} °C
                  </span>
                </span>
                <button
                  disabled={p.product_id in cart}
                  onClick={() => setCart((c) => ({ ...c, [p.product_id]: 100 }))}
                  className="rounded px-2 py-0.5 text-xs text-sky-300 hover:bg-slate-800 disabled:text-slate-600"
                >
                  {p.product_id in cart ? "Added" : "Add"}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-300">2. Quantities ({Object.keys(cart).length})</h3>
          {Object.keys(cart).length === 0 ? (
            <p className="text-xs text-slate-500">Nothing added yet -- pick products or a preset above.</p>
          ) : (
            <ul className="space-y-1.5">
              {Object.entries(cart).map(([id, kg]) => (
                <li key={id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate text-slate-200">{names[id]}</span>
                  <input
                    type="number"
                    min={1}
                    value={kg}
                    onChange={(e) => setCart((c) => ({ ...c, [id]: Math.max(1, Number(e.target.value) || 1) }))}
                    className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-right text-sm text-slate-100"
                    aria-label={`${names[id]} kg`}
                  />
                  <span className="text-xs text-slate-500">kg</span>
                  <button
                    onClick={() =>
                      setCart((c) => {
                        const next = { ...c };
                        delete next[id];
                        return next;
                      })
                    }
                    className="text-xs text-slate-500 hover:text-red-300"
                    aria-label={`Remove ${names[id]}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-300">3. Reefer stability</h3>
          <label className="block text-xs text-slate-500">Truck (uses its own recent temperature wobble)</label>
          <select
            value={truckId}
            onChange={(e) => setTruckId(e.target.value)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200"
          >
            <option value="">No truck -- use real-data default</option>
            {trucks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <label className="mt-2 block text-xs text-slate-500">…or set fluctuation σ manually (°C, optional)</label>
          <input
            type="number"
            step={0.1}
            min={0}
            max={5}
            value={sigma}
            onChange={(e) => setSigma(e.target.value)}
            placeholder="e.g. 0.5"
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <button
            onClick={runPlan}
            disabled={planning || Object.keys(cart).length === 0}
            className="mt-3 w-full rounded bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:bg-slate-800 disabled:text-slate-500"
          >
            {planning ? "Planning..." : "Plan load"}
          </button>
        </div>
      </div>

      {/* ---------------- right: results ---------------- */}
      <div className="space-y-6">
        {planError && <ErrorState error={planError.msg} status={planError.status} onRetry={runPlan} />}
        {!plan && !planError && (
          <EmptyState
            title="No plan yet"
            hint="Add the products for a trip and press Plan load. Model 5 decides which products can share a reefer; Model 4 picks each compartment's temperature."
          />
        )}
        {plan && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile label="Compartments needed" value={plan.groups.length} />
              <StatTile label="Products" value={planIds.length} />
              <StatTile label="Fluctuation σ" value={`${plan.sigma_c.toFixed(2)} °C`} hint={plan.sigma_source} />
              <StatTile
                label="Models"
                value={`${plan.model5_active ? "M5 ✓" : "M5 –"} ${plan.model4_active ? "M4 ✓" : "M4 –"}`}
                hint={plan.model5_active ? `threshold ${plan.compatibility_threshold?.toFixed(2)}` : "rules / physics fallback"}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              {plan.groups.map((g) => (
                <GroupCard key={g.group_id} group={g} />
              ))}
            </div>

            {planIds.length > 1 && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <h3 className="mb-3 text-sm font-medium text-slate-400">Compatibility matrix (click a cell for the reasons)</h3>
                <CompatibilityMatrix ids={planIds} names={names} pairs={pairMap} selected={selectedPair} onSelect={setSelectedPair} />
                {selectedPairData && (
                  <div className="mt-4 rounded border border-slate-800 bg-slate-950/60 p-3 text-sm">
                    <p className="font-medium text-slate-200">
                      {names[selectedPairData.a]} + {names[selectedPairData.b]}:{" "}
                      <span className={selectedPairData.compatible ? "text-sky-300" : "text-amber-300"}>
                        {selectedPairData.compatible ? "can share a compartment" : "keep apart"}
                      </span>
                      {selectedPairData.probability !== null && (
                        <span className="ml-2 text-xs text-slate-500">Model 5 p = {selectedPairData.probability.toFixed(3)}</span>
                      )}
                      {selectedPairData.extrapolated && <span className="ml-2 text-xs text-slate-500">(outside produce training data)</span>}
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-400">
                      {[...selectedPairData.vetoes, ...selectedPairData.reasons, ...selectedPairData.warnings].map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                      {selectedPairData.vetoes.length + selectedPairData.reasons.length + selectedPairData.warnings.length === 0 && (
                        <li>No physical or regulatory conflict found.</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {incompatible.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                <h3 className="mb-3 text-sm font-medium text-slate-400">Why products were separated</h3>
                <ul className="space-y-2 text-sm">
                  {incompatible.slice(0, 12).map((p) => (
                    <li key={pairKey(p.a, p.b)}>
                      <span className="text-slate-200">
                        {names[p.a]} + {names[p.b]}
                      </span>
                      <span className="text-slate-500"> — {[...p.vetoes, ...p.reasons][0] ?? "Model 5 predicts they don't travel well together."}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-200/90">
                {plan.warnings.map((w, i) => (
                  <p key={i}>⚠ {w}</p>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function PlannerPage() {
  return (
    <RequireAuth>
      <div className="mx-auto max-w-7xl px-6 py-8">
        <h1 className="mb-1 text-2xl font-semibold">Load Planner</h1>
        <p className="mb-6 text-sm text-slate-400">
          Which products can share a reefer (Model 5), and the temperature to run each compartment at (Model 4).
        </p>
        <PlannerBody />
      </div>
    </RequireAuth>
  );
}

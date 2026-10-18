"use client";

// Load Planner -- where Model 4 (mixed-load setpoint) and Model 5 (co-shipment compatibility)
// are used in the admin panel. A dispatcher picks the products (and kg) for a trip; the backend
// (POST /planner/plan, backend/app/load_planner.py) returns which pairs can share a reefer, the
// products split into compatible compartments, and each compartment's recommended setpoint plus
// the FROSTMIND device preset that applies it. A compartment can then be turned straight into a
// real mixed-load shipment on a truck (POST /shipments with products), which is what the phone
// app's setup wizard does too. Styled with the shared design system (components/ui.tsx).

import { useMemo, useState } from "react";
import Link from "next/link";
import { RequireAuth } from "@/components/RequireAuth";
import { ArrowUpRightIcon, BoxIcon, PulseIcon, SnowflakeIcon, SparkIcon, ThermometerIcon } from "@/components/Icons";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateViews";
import { Idx, PageBody, PageHeader, Panel, StatCard } from "@/components/ui";
import { API_BASE, ApiError, fetchProducts, fetchTrucks, planLoad } from "@/lib/api";
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
  ml: "AI · Model 4",
  physics: "Physics optimizer",
  physics_fallback: "Physics (AI disagreed)",
  infeasible: "No safe setpoint",
};

function fmt(v: number | null | undefined, digits = 1) {
  return v === null || v === undefined ? "--" : v.toFixed(digits);
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function GroupCard({
  group,
  trucks,
  onCreated,
}: {
  group: PlanGroup;
  trucks: Truck[];
  onCreated: (msg: string) => void;
}) {
  const [lo, hi] = group.safe_range_c;
  const [truckId, setTruckId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function createShipment() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/shipments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          truck_id: truckId,
          label: `Mixed load: ${group.products.map((p) => p.name).join(", ")}`.slice(0, 120),
          products: group.products.map((p) => ({ product_id: p.product_id, quantity_kg: p.quantity_kg })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : body.detail?.message || res.statusText);
      onCreated(`Shipment created for compartment ${group.group_id} on ${trucks.find((t) => t.id === truckId)?.label || "truck"} (setpoint ${fmt(body.recommended_setpoint_c)} °C).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rise flex flex-col p-5 ${group.feasible ? "glass text-white" : "border border-danger/40 bg-danger/10 text-white"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <Idx n={group.group_id} />
          <span className="ml-2 text-[11px] uppercase tracking-wide text-peri-100/60">Compartment</span>
        </div>
        <span className="chip-fade">{METHOD_LABEL[group.method]}</span>
      </div>
      <p className="display num mt-3 text-[3rem] leading-none">{group.feasible ? `${fmt(group.recommended_setpoint_c)} °C` : "Split"}</p>
      <p className="mt-2 text-[11px] text-peri-100/60">
        Near-optimal {fmt(group.band_c[0])} to {fmt(group.band_c[1])} °C · safe {lo === null ? "−∞" : fmt(lo)} to {hi === null ? "+∞" : fmt(hi)} °C
      </p>
      <p className="mt-1 font-mono text-[10px] text-peri-100/45">
        physics {fmt(group.physics_setpoint_c, 2)} °C · ML {group.student_setpoint_c === null ? "--" : `${fmt(group.student_setpoint_c, 2)} °C`}
      </p>
      <p className={`mt-2 text-xs ${group.device_category_within_1c ? "text-peri-100/75" : "text-warn"}`}>
        {group.device_category_within_1c
          ? `ESP preset: ${group.device_category} (${fmt(group.device_category_setpoint_c)} °C via BLE set_category)`
          : `No ESP preset near this setpoint (nearest ${fmt(group.device_category_setpoint_c)} °C) -- set the reefer manually.`}
      </p>
      <table className="mt-4 w-full text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-peri-100/50">
            <th className="pb-1 font-medium">Product</th>
            <th className="pb-1 text-right font-medium">kg</th>
            <th className="pb-1 text-right font-medium">Shelf life / day</th>
          </tr>
        </thead>
        <tbody>
          {group.products.map((p) => (
            <tr key={p.product_id} className="border-t border-white/10">
              <td className="py-1.5">{p.name}</td>
              <td className="py-1.5 text-right text-peri-100/70">{p.quantity_kg}</td>
              <td className={`num py-1.5 text-right ${p.expected_loss_pct_per_day > 20 ? "text-warn" : ""}`}>{p.expected_loss_pct_per_day.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {group.feasible && trucks.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
          <select className="field flex-1 !py-1.5 text-xs" value={truckId} onChange={(e) => setTruckId(e.target.value)} aria-label="Truck for this compartment">
            <option value="">Choose a truck...</option>
            {trucks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" disabled={!truckId || busy} onClick={createShipment}>
            {busy ? "Creating..." : "Create shipment"}
          </button>
        </div>
      )}
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </div>
  );
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
            <span className="absolute bottom-1 left-1/2 origin-bottom-left -rotate-45 whitespace-nowrap text-[11px] text-peri-100/70">{names[id]}</span>
          </div>
        ))}
        {ids.map((row) => (
          <div key={row} className="contents">
            <div className="truncate pr-2 text-right text-[11px] leading-9 text-peri-100/70">{names[row]}</div>
            {ids.map((col) => {
              if (row === col) return <div key={col} className="h-9 rounded-[2px] bg-ink-950" />;
              const key = pairKey(row, col);
              const p = pairs.get(key);
              if (!p) return <div key={col} className="h-9 rounded-[2px] bg-ink-950" />;
              const cls = p.vetoes.length ? "bg-danger/35 text-white" : p.compatible ? "bg-royal-500 text-white" : "bg-white/10 text-peri-100";
              return (
                <button
                  key={col}
                  onClick={() => onSelect(key)}
                  title={`${names[row]} + ${names[col]}: ${p.compatible ? "compatible" : "keep apart"}${p.probability !== null ? ` (p=${p.probability.toFixed(2)})` : ""}`}
                  className={`num h-9 rounded-[2px] text-[10px] font-medium ${cls} ${selected === key ? "ring-2 ring-white" : ""}`}
                >
                  {p.vetoes.length ? "veto" : p.probability !== null ? p.probability.toFixed(2) : p.compatible ? "ok" : "--"}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-4 text-[11px] text-faint">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[2px] bg-royal-500" /> Compatible</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[2px] bg-white/10" /> Keep apart (physical)</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[2px] bg-danger/35" /> Keep apart (regulation)</span>
        <span>Numbers = Model 5 probability of compatibility</span>
      </div>
    </div>
  );
}

function PlannerView() {
  const { token } = useAuth();
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
  const [notice, setNotice] = useState<string | null>(null);

  const byId = useMemo(() => Object.fromEntries((products ?? []).map((p) => [p.product_id, p])), [products]);
  const names = useMemo(() => Object.fromEntries((products ?? []).map((p) => [p.product_id, p.name])), [products]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? []).filter((p) => (category === "all" || p.category === category) && (!q || p.name.toLowerCase().includes(q)));
  }, [products, query, category]);
  const pairMap = useMemo(() => new Map((plan?.pairs ?? []).map((p) => [pairKey(p.a, p.b), p])), [plan]);
  const planIds = useMemo(() => (plan ? plan.groups.flatMap((g) => g.products.map((p) => p.product_id)) : []), [plan]);

  const runPlan = async () => {
    if (Object.keys(cart).length === 0) return;
    setPlanning(true);
    setPlanError(null);
    setSelectedPair(null);
    setNotice(null);
    try {
      setPlan(
        await planLoad(token as string, {
          products: Object.entries(cart).map(([product_id, quantity_kg]) => ({ product_id, quantity_kg })),
          truck_id: truckId || null,
          sigma_c: sigma === "" ? null : Number(sigma),
        })
      );
    } catch (e) {
      setPlanError({ msg: (e as Error).message, status: e instanceof ApiError ? e.status : null });
    } finally {
      setPlanning(false);
    }
  };

  const selectedPairData = selectedPair ? pairMap.get(selectedPair) : undefined;
  const incompatible = (plan?.pairs ?? []).filter((p) => !p.compatible);

  return (
    <>
      <PageHeader
        eyebrow="Load planner"
        title={
          <>
            Mix the load,
            <br />
            not the risk.
          </>
        }
        description="Model 5 decides which products can share a reefer (and explains why not); Model 4 picks the temperature to run each compartment at, allowing for the truck's real temperature wobble."
        page={[5, 6]}
      >
        {plan && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            <StatCard index={0} highlight icon={<BoxIcon />} value={plan.groups.length} label="Compartments needed" hint={`${planIds.length} products checked`} />
            <StatCard index={1} icon={<ThermometerIcon />} value={plan.groups.length === 1 && plan.groups[0].recommended_setpoint_c != null ? `${fmt(plan.groups[0].recommended_setpoint_c)} °C` : "multi"} label="Recommended setpoint" hint="Model 4, guarded by physics" />
            <StatCard index={2} icon={<PulseIcon />} value={`${plan.sigma_c.toFixed(2)} °C`} label="Truck wobble σ" hint={plan.sigma_source} />
            <StatCard
              index={3}
              icon={<SparkIcon />}
              value={`${plan.model5_active ? "AI" : "rules"} / ${plan.model4_active ? "AI" : "phys"}`}
              label="Model 5 / Model 4"
              hint={plan.model5_active ? `threshold ${plan.compatibility_threshold?.toFixed(2)}` : "fallback mode"}
            />
          </div>
        )}
      </PageHeader>

      <PageBody>
        {catalog.error && !products && <ErrorState error={catalog.error} status={catalog.errorStatus} onRetry={catalog.refresh} />}
        {!products && !catalog.error && <LoadingState label="Loading product catalog..." />}
        {products && (
          <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
            <div className="space-y-6">
              <Panel index={1} title="Pick products" subtitle={`${products.length} products from USDA HB66, McGregor, FDA, CDC`}>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      onClick={() => setCart(Object.fromEntries(preset.items.filter((id) => byId[id]).map((id) => [id, 100])))}
                      className="btn btn-ghost btn-sm"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products..." className="field w-full" />
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="field mt-2 w-full">
                  <option value="all">All categories</option>
                  {CATEGORY_ORDER.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <ul className="mt-3 max-h-64 divide-y divide-line overflow-y-auto">
                  {filtered.map((p) => (
                    <li key={p.product_id} className="flex items-center justify-between py-1.5 text-[13px]">
                      <span className="text-peri-50">
                        {p.name}
                        <span className="ml-1.5 font-mono text-[10px] text-faint">
                          {fmt(p.t_min_c)}–{fmt(p.t_max_c)} °C
                        </span>
                      </span>
                      <button
                        disabled={p.product_id in cart}
                        onClick={() => setCart((c) => ({ ...c, [p.product_id]: 100 }))}
                        className="rounded-[2px] px-2 py-0.5 text-xs text-royal-300 hover:bg-white/5 disabled:text-faint"
                      >
                        {p.product_id in cart ? "Added" : "Add"}
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel index={2} title={`Quantities (${Object.keys(cart).length})`}>
                {Object.keys(cart).length === 0 ? (
                  <p className="text-xs text-faint">Nothing added yet -- pick products or a preset above.</p>
                ) : (
                  <ul className="space-y-2">
                    {Object.entries(cart).map(([id, kg]) => (
                      <li key={id} className="flex items-center gap-2 text-[13px]">
                        <span className="flex-1 truncate text-peri-50">{names[id]}</span>
                        <input
                          type="number"
                          min={1}
                          value={kg}
                          onChange={(e) => setCart((c) => ({ ...c, [id]: Math.max(1, Number(e.target.value) || 1) }))}
                          className="field w-20 !py-1 text-right"
                          aria-label={`${names[id]} kg`}
                        />
                        <span className="text-xs text-faint">kg</span>
                        <button
                          onClick={() =>
                            setCart((c) => {
                              const next = { ...c };
                              delete next[id];
                              return next;
                            })
                          }
                          className="px-1 text-sm text-faint hover:text-danger"
                          aria-label={`Remove ${names[id]}`}
                        >
                          &times;
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel index={3} title="Reefer stability" subtitle="σ = how much the truck's temperature wobbles around its setpoint.">
                <label className="block text-[11px] text-faint">Truck (uses its own recent readings)</label>
                <select value={truckId} onChange={(e) => setTruckId(e.target.value)} className="field mt-1 w-full">
                  <option value="">No truck -- real-data default</option>
                  {trucks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <label className="mt-3 block text-[11px] text-faint">…or set σ manually (°C, optional)</label>
                <input type="number" step={0.1} min={0} max={5} value={sigma} onChange={(e) => setSigma(e.target.value)} placeholder="e.g. 0.5" className="field mt-1 w-full" />
                <button onClick={runPlan} disabled={planning || Object.keys(cart).length === 0} className="btn btn-primary mt-4 w-full">
                  {planning ? "Planning..." : "Plan load"}
                </button>
              </Panel>
            </div>

            <div className="space-y-6">
              {planError && <ErrorState error={planError.msg} status={planError.status} onRetry={runPlan} />}
              {notice && (
                <div className="rise flex flex-wrap items-center justify-between gap-3 rounded-[3px] border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">
                  {notice}
                  <Link href="/" className="inline-flex items-center gap-1 text-xs underline">
                    Open fleet <ArrowUpRightIcon className="h-3 w-3" />
                  </Link>
                </div>
              )}
              {!plan && !planError && (
                <EmptyState
                  title="No plan yet"
                  hint="Add the products for a trip and press Plan load. Model 5 decides which products can share a reefer; Model 4 picks each compartment's temperature."
                />
              )}
              {plan && (
                <>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {plan.groups.map((g) => (
                      <GroupCard key={g.group_id} group={g} trucks={trucks} onCreated={setNotice} />
                    ))}
                  </div>

                  {planIds.length > 1 && (
                    <Panel index={4} title="Compatibility matrix" subtitle="Click a cell for the reasons.">
                      <CompatibilityMatrix ids={planIds} names={names} pairs={pairMap} selected={selectedPair} onSelect={setSelectedPair} />
                      {selectedPairData && (
                        <div className="mt-4 rounded-[3px] border border-line bg-ink-950/60 p-4 text-[13px]">
                          <p className="font-medium text-peri-50">
                            {names[selectedPairData.a]} + {names[selectedPairData.b]}:{" "}
                            <span className={selectedPairData.compatible ? "text-royal-300" : "text-warn"}>
                              {selectedPairData.compatible ? "can share a compartment" : "keep apart"}
                            </span>
                            {selectedPairData.probability !== null && (
                              <span className="ml-2 font-mono text-[10px] text-faint">Model 5 p = {selectedPairData.probability.toFixed(3)}</span>
                            )}
                            {selectedPairData.extrapolated && <span className="ml-2 text-[10px] text-faint">(outside produce training data)</span>}
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-peri-100/70">
                            {[...selectedPairData.vetoes, ...selectedPairData.reasons, ...selectedPairData.warnings].map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                            {selectedPairData.vetoes.length + selectedPairData.reasons.length + selectedPairData.warnings.length === 0 && (
                              <li>No physical or regulatory conflict found.</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </Panel>
                  )}

                  {incompatible.length > 0 && (
                    <Panel index={5} title="Why products were separated">
                      <ul className="space-y-2 text-[13px]">
                        {incompatible.slice(0, 12).map((p) => (
                          <li key={pairKey(p.a, p.b)}>
                            <span className="text-peri-50">
                              {names[p.a]} + {names[p.b]}
                            </span>
                            <span className="text-faint"> — {[...p.vetoes, ...p.reasons][0] ?? "Model 5 predicts they don't travel well together."}</span>
                          </li>
                        ))}
                      </ul>
                    </Panel>
                  )}

                  {plan.warnings.length > 0 && (
                    <div className="rounded-[3px] border border-warn/40 bg-warn/10 p-4 text-[13px] text-warn">
                      {plan.warnings.map((w, i) => (
                        <p key={i} className="flex gap-2">
                          <SnowflakeIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}

export default function PlannerPage() {
  return (
    <RequireAuth>
      <PlannerView />
    </RequireAuth>
  );
}

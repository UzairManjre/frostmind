// Mirrors backend/app/schemas.py + backend/app/models.py enums. Keep in sync manually --
// there's no shared codegen between the FastAPI backend and this Next.js app for the MVP.

export type ProductCategory =
  | "vaccine_generic"
  | "pasteurized_milk"
  | "fresh_produce_generic"
  | "meat_poultry_chilled"
  | "frozen_food_generic"
  | "seafood_fresh_chilled";

export type ShipmentStatus = "pending" | "in-transit" | "delivered";

export type PairingState = "idle" | "scanning" | "matched" | "no_match";

export type AlertType = "anomaly" | "shelf-life-threshold" | "door-open-too-long";

export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface CategoryInfo {
  key: ProductCategory;
  name: string;
  reference_temp_c: number;
  shelf_life_at_ref_hours: number;
}

export interface Shipment {
  id: string;
  truck_id: string;
  category: ProductCategory;
  status: ShipmentStatus;
  label: string | null;
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  shelf_life_consumed_fraction: number | null;
  shelf_life_remaining_hours: number | null;
  shelf_life_updated_at: string | null;
  // Per-shipment alert threshold overrides (Prototype-to-Production plan §4 "Configurable alert
  // thresholds"). Optional on the wire until the backend half of this lands -- treated as
  // `| undefined` here, not just `| null`, so this app doesn't crash reading an older backend
  // response that omits the fields entirely; `?? null` at every read site normalizes both to
  // "using category default".
  alert_rate_threshold_override?: number | null;
  alert_deviation_threshold_override?: number | null;
  // Mixed load (Load Planner, Models 4 + 5) -- null/absent for a single-category shipment.
  products?: { product_id: string; name: string; quantity_kg: number }[] | null;
  recommended_setpoint_c?: number | null;
  setpoint_band?: number[] | null;
  setpoint_method?: string | null;
  product_shelf_life?: { product_id: string; name: string; quantity_kg: number | null; consumed_fraction: number; remaining_hours: number | null }[] | null;
}

export interface FleetShipment extends Shipment {
  truck_label: string;
  truck_plate: string | null;
  device_id: string | null;
  device_name: string | null;
  device_last_seen_at: string | null;
  latest_temp_c: number | null;
  latest_humidity: number | null;
  latest_door_open: boolean | null;
  latest_reading_ts: string | null;
  open_alert_count: number;
  // GPS (plan §5 correction: phone's own Geolocation API, not new ESP32 hardware) -- the most
  // recent non-null lat/lng reported for this shipment. Only guaranteed on the fleet-list
  // endpoint per the backend contract, hence `| undefined` for the same reason as above.
  latest_lat?: number | null;
  latest_lng?: number | null;
}

// ---------- Fleet analytics (plan §4 "fleet-level analytics/trends view") ----------

export interface AlertTypeCount {
  type: AlertType;
  count: number;
}

export interface TruckAlertCount {
  truck_id: string;
  truck_label: string;
  alert_count: number;
}

export interface FleetAnalytics {
  period_days: number;
  total_alerts: number;
  by_type: AlertTypeCount[];
  by_truck: TruckAlertCount[];
  shipments_active: number;
  shipments_completed: number;
}

export interface SensorReading {
  id: string;
  shipment_id: string;
  ts: string;
  temp_c: number;
  humidity: number | null;
  door_open: boolean | null;
  rate_of_change: number | null;
  device_reported_alert: boolean | null;
  anomaly_score: number | null;
  is_anomaly: boolean | null;
  lat: number | null;
  lng: number | null;
}

export interface Alert {
  id: string;
  shipment_id: string;
  ts: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  model1_score: number | null;
  acknowledged: boolean;
  // LLM orchestration (FROSTMIND_LLM_Orchestration_Plan.md), Role A -- populated by a background
  // task shortly after the alert is created, so these are commonly null on a freshly-created
  // alert and fill in a few seconds later (Ollama unreachable/timeout/malformed output also
  // leaves them null indefinitely -- that's the documented fallback, not a loading state to
  // wait out forever).
  llm_assessment: string | null;
  llm_recommended_action: string | null;
  llm_narrative: string | null;
}

export interface ComplianceReport {
  shipment_id: string;
  narrative: string | null; // null means generation failed -- show "try again", never fabricate
}

export interface Truck {
  id: string;
  label: string;
  plate: string | null;
  device_id: string | null;
  created_at: string;
}

export interface Device {
  id: string;
  mac_address: string;
  serial: string | null;
  name: string | null;
  last_seen_at: string | null;
  pairing_state: PairingState;
  paired_protocol: string | null;
}

// ---------- Load Planner (Model 4 mixed-load setpoint + Model 5 co-shipment compatibility) ----------
// Mirrors backend/app/schemas.py ProductOut / PlanRequest / PlanResponse.

export interface Product {
  product_id: string;
  name: string;
  category: string;
  safety_class: "produce" | "ready_to_eat" | "raw_animal" | "frozen" | "pharma";
  frostmind_category: ProductCategory;
  t_min_c: number | null;
  t_max_c: number | null;
  t_opt_c: number | null;
  rh_min: number | null;
  rh_max: number | null;
  chilling_sensitive: boolean;
  ethylene_production: number;
  ethylene_sensitivity: number;
  compat_groups: string;
  source: string;
}

export interface PlanRequest {
  products: { product_id: string; quantity_kg: number }[];
  truck_id?: string | null;
  sigma_c?: number | null;
}

export interface PlanPair {
  a: string;
  b: string;
  probability: number | null;
  compatible: boolean;
  extrapolated: boolean;
  vetoes: string[];
  reasons: string[];
  warnings: string[];
}

export interface PlanGroup {
  group_id: number;
  products: { product_id: string; name: string; quantity_kg: number; expected_loss_pct_per_day: number }[];
  feasible: boolean;
  recommended_setpoint_c: number | null;
  method: "ml" | "physics" | "physics_fallback" | "infeasible";
  physics_setpoint_c: number;
  student_setpoint_c: number | null;
  safe_range_c: (number | null)[];
  band_c: number[];
  expected_loss_pct_per_day: number;
  device_category: ProductCategory;
  device_category_setpoint_c: number;
  device_category_within_1c: boolean;
}

export interface PlanResponse {
  sigma_c: number;
  sigma_source: string;
  model4_active: boolean;
  model5_active: boolean;
  compatibility_threshold: number | null;
  groups: PlanGroup[];
  pairs: PlanPair[];
  warnings: string[];
}

// ---------- AI status (GET /ai/status, POST /ai/llm/test) ----------

export interface AiComponent {
  key: string;
  name: string;
  kind: string;
  status: string; // "live" | "inactive" | "physics-only" | "rules-only" | "unavailable"
  what: string;
  where: string;
  note?: string | null;
  metrics: Record<string, number | string | null>;
  usage: Record<string, number>;
}

export interface AiStatus {
  components: AiComponent[];
  llm: { reachable: boolean; model: string | null; configured_model: string; installed_models?: string[]; error?: string };
}

export interface LlmTestResult {
  ok: boolean;
  model: string | null;
  latency_ms: number;
  reply: string | null;
}

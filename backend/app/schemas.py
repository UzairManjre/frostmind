from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models import AlertSeverity, AlertType, PairingState, ProductCategory, ShipmentStatus

# ---------- Auth ----------


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    role: str


# ---------- Device ----------


class DeviceRegisterRequest(BaseModel):
    mac_address: str
    serial: str | None = None
    name: str | None = None


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    mac_address: str
    serial: str | None
    name: str | None
    provisioning_key: str
    last_seen_at: datetime | None
    created_at: datetime
    pairing_state: PairingState
    pairing_started_at: datetime | None
    pairing_candidate_index: int | None
    pairing_total_candidates: int | None
    paired_protocol: str | None


class DeviceUpdateRequest(BaseModel):
    name: str | None = None


class PairingStartResponse(BaseModel):
    device_id: str
    pairing_state: PairingState
    pairing_started_at: datetime | None


class PairingStatusUpdate(BaseModel):
    """Body the phone bridge POSTs after relaying a `pairing_status` BLE notification."""

    state: PairingState
    candidate_index: int | None = None
    total: int | None = None
    paired_protocol: str | None = None


class PairingStatusOut(BaseModel):
    device_id: str
    state: PairingState
    candidate_index: int | None
    total: int | None
    paired_protocol: str | None
    started_at: datetime | None


# ---------- Truck ----------


class TruckCreateRequest(BaseModel):
    label: str
    plate: str | None = None
    device_id: str | None = None


class TruckUpdateRequest(BaseModel):
    label: str | None = None
    plate: str | None = None
    device_id: str | None = None


class TruckOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    label: str
    plate: str | None
    device_id: str | None
    created_at: datetime


# ---------- Shipment ----------


class ShipmentCreateRequest(BaseModel):
    truck_id: str
    category: ProductCategory
    label: str | None = None
    status: ShipmentStatus = ShipmentStatus.pending


class ShipmentUpdateRequest(BaseModel):
    category: ProductCategory | None = None
    status: ShipmentStatus | None = None
    label: str | None = None
    # Configurable alert thresholds (plan §4). Setting either activates the corresponding
    # backend-side check on /ingest in addition to the existing device-flag/Model 1/door logic;
    # leaving both unset (null) preserves current behavior exactly.
    alert_rate_threshold_override: float | None = None
    alert_deviation_threshold_override: float | None = None


class ShipmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    truck_id: str
    category: ProductCategory
    status: ShipmentStatus
    label: str | None
    start_time: datetime | None
    end_time: datetime | None
    created_at: datetime
    shelf_life_consumed_fraction: float | None
    shelf_life_remaining_hours: float | None
    shelf_life_updated_at: datetime | None
    alert_rate_threshold_override: float | None
    alert_deviation_threshold_override: float | None


class FleetShipmentOut(ShipmentOut):
    """ShipmentOut plus enough truck/device context for the fleet view in one round trip."""

    truck_label: str
    truck_plate: str | None
    device_id: str | None
    device_name: str | None
    device_last_seen_at: datetime | None
    latest_temp_c: float | None
    latest_humidity: float | None
    latest_door_open: bool | None
    latest_reading_ts: datetime | None
    open_alert_count: int
    # Most recent reading with a non-null GPS fix for this shipment (not necessarily the very
    # latest reading, which may itself lack GPS) -- lets the web app render a map without a
    # second round trip. Both null if no reading for this shipment has ever carried GPS.
    latest_lat: float | None
    latest_lng: float | None


# ---------- Sensor readings / ingest ----------


class ReadingIn(BaseModel):
    """Mirrors the phone-bridge/BLE payload contract exactly: ts (ms epoch), temp, hum, door,
    roc, alert. Field names differ slightly (hum->humidity, roc->rate_of_change, door/alert
    kept as-is) only in the ORM column names, not in what's accepted over the wire.
    """

    ts: int = Field(..., description="epoch milliseconds, matches the BLE payload's ts field")
    temp: float
    hum: float | None = None
    door: bool | None = None
    roc: float | None = None
    alert: bool | None = None
    lat: float | None = Field(default=None, description="phone Geolocation API latitude, if permitted/available")
    lng: float | None = Field(default=None, description="phone Geolocation API longitude, if permitted/available")


class IngestRequest(BaseModel):
    device_mac: str | None = None
    device_id: str | None = None
    shipment_id: str | None = None
    readings: list[ReadingIn]


class IngestResult(BaseModel):
    shipment_id: str
    stored: int
    anomalies_flagged: int
    alerts_created: int
    shelf_life_consumed_fraction: float | None
    shelf_life_remaining_hours: float | None


class SensorReadingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    shipment_id: str
    ts: datetime
    temp_c: float
    humidity: float | None
    door_open: bool | None
    rate_of_change: float | None
    device_reported_alert: bool | None
    anomaly_score: float | None
    is_anomaly: bool | None
    lat: float | None
    lng: float | None


# ---------- Alerts ----------


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    shipment_id: str
    ts: datetime
    type: AlertType
    severity: AlertSeverity
    message: str
    model1_score: float | None
    acknowledged: bool
    llm_assessment: str | None = None
    llm_recommended_action: str | None = None
    llm_narrative: str | None = None


class AlertAckRequest(BaseModel):
    acknowledged: bool = True


# ---------- Fleet analytics ----------


class AlertTypeCount(BaseModel):
    type: str
    count: int


class TruckAlertCount(BaseModel):
    truck_id: str
    truck_label: str
    alert_count: int


class FleetAnalyticsOut(BaseModel):
    period_days: int
    total_alerts: int
    by_type: list[AlertTypeCount]
    by_truck: list[TruckAlertCount]
    shipments_active: int
    shipments_completed: int


class ComplianceReportOut(BaseModel):
    shipment_id: str
    narrative: str | None  # None means generation failed (Ollama unreachable/timeout/malformed
    # output) -- see app/llm_orchestrator.py's reliability contract; the admin UI must show this
    # as "couldn't generate right now, try again" and never fabricate a narrative client-side.


# ---------- Load Planner (Model 4 + Model 5) ----------


class ProductOut(BaseModel):
    product_id: str
    name: str
    category: str
    safety_class: str
    frostmind_category: str
    t_min_c: float | None
    t_max_c: float | None
    t_opt_c: float | None
    rh_min: float | None
    rh_max: float | None
    chilling_sensitive: bool
    ethylene_production: int
    ethylene_sensitivity: int
    compat_groups: str
    source: str


class PlanItemIn(BaseModel):
    product_id: str
    quantity_kg: float = Field(default=1.0, gt=0)


class PlanRequest(BaseModel):
    products: list[PlanItemIn] = Field(min_length=1, max_length=40)
    truck_id: str | None = None
    # Explicit reefer fluctuation override (deg C); otherwise taken from the truck's own recent
    # readings, otherwise the real-data default (data/product_catalog/reefer_fluctuation.json).
    sigma_c: float | None = Field(default=None, ge=0.0, le=5.0)


class PlanPairOut(BaseModel):
    a: str
    b: str
    probability: float | None
    compatible: bool
    extrapolated: bool
    vetoes: list[str]
    reasons: list[str]
    warnings: list[str]


class PlanGroupProductOut(BaseModel):
    product_id: str
    name: str
    quantity_kg: float
    expected_loss_pct_per_day: float


class PlanGroupOut(BaseModel):
    group_id: int
    products: list[PlanGroupProductOut]
    feasible: bool
    recommended_setpoint_c: float | None
    method: str  # "ml" | "physics" | "physics_fallback" | "infeasible"
    physics_setpoint_c: float
    student_setpoint_c: float | None
    safe_range_c: list[float | None]
    band_c: list[float]
    expected_loss_pct_per_day: float
    device_category: str
    device_category_setpoint_c: float
    device_category_within_1c: bool


class PlanResponse(BaseModel):
    sigma_c: float
    sigma_source: str
    model4_active: bool
    model5_active: bool
    compatibility_threshold: float | None
    groups: list[PlanGroupOut]
    pairs: list[PlanPairOut]
    warnings: list[str]

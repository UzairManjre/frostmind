"""SQLAlchemy ORM models for the entities in Phase2 plan §2.1: Device, Truck, Shipment,
SensorReading, Alert, User. Written against the ORM (no raw/SQLite-specific SQL anywhere in
this codebase) so DATABASE_URL can point at Postgres later without touching this file.
"""
from __future__ import annotations

import enum
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _provisioning_key() -> str:
    return secrets.token_urlsafe(24)


class ProductCategory(str, enum.Enum):
    """Must stay exactly in sync with PRODUCT_LIBRARY keys in scripts/model3_shelf_life.py."""

    vaccine_generic = "vaccine_generic"
    pasteurized_milk = "pasteurized_milk"
    fresh_produce_generic = "fresh_produce_generic"
    meat_poultry_chilled = "meat_poultry_chilled"
    frozen_food_generic = "frozen_food_generic"
    seafood_fresh_chilled = "seafood_fresh_chilled"


class ShipmentStatus(str, enum.Enum):
    pending = "pending"
    in_transit = "in-transit"
    delivered = "delivered"


class PairingState(str, enum.Enum):
    idle = "idle"
    scanning = "scanning"
    matched = "matched"
    no_match = "no_match"


class AlertType(str, enum.Enum):
    anomaly = "anomaly"
    shelf_life_threshold = "shelf-life-threshold"
    door_open_too_long = "door-open-too-long"


class AlertSeverity(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class UserRole(str, enum.Enum):
    admin = "admin"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.admin, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    mac_address: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    serial: Mapped[str | None] = mapped_column(String(128), nullable=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    provisioning_key: Mapped[str] = mapped_column(String(64), default=_provisioning_key, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    # Auto-pairing (§3 / §4) lifecycle, tracked server-side so the admin panel and the phone
    # bridge can both poll GET /devices/{id}/pairing/status. The actual BLE command send and
    # the raw pairing_status notifications happen phone<->device directly (the backend has no
    # BLE radio); the phone bridge relays what it observes via POST /devices/{id}/pairing/status.
    pairing_state: Mapped[PairingState] = mapped_column(Enum(PairingState), default=PairingState.idle)
    pairing_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pairing_candidate_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pairing_total_candidates: Mapped[int | None] = mapped_column(Integer, nullable=True)
    paired_protocol: Mapped[str | None] = mapped_column(String(128), nullable=True)

    truck: Mapped["Truck | None"] = relationship(back_populates="device", uselist=False)


class Truck(Base):
    __tablename__ = "trucks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    plate: Mapped[str | None] = mapped_column(String(64), nullable=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    device: Mapped[Device | None] = relationship(back_populates="truck")
    shipments: Mapped[list["Shipment"]] = relationship(back_populates="truck")


class Shipment(Base):
    __tablename__ = "shipments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    truck_id: Mapped[str] = mapped_column(ForeignKey("trucks.id"), nullable=False)
    category: Mapped[ProductCategory] = mapped_column(Enum(ProductCategory), nullable=False)
    status: Mapped[ShipmentStatus] = mapped_column(Enum(ShipmentStatus), default=ShipmentStatus.pending)
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    # Model 3 output, refreshed on every /ingest batch that touches this shipment.
    shelf_life_consumed_fraction: Mapped[float | None] = mapped_column(Float, nullable=True)
    shelf_life_remaining_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    shelf_life_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Configurable alert thresholds (Prototype-to-Production plan §4). Nullable: when null,
    # /ingest's alert logic behaves exactly as before (device-flag / Model 1 / door-open only).
    # When set, /ingest additionally flags a reading as anomalous if it deviates from the
    # category's reference temperature by more than alert_deviation_threshold_override (deg C),
    # or if |rate_of_change| exceeds alert_rate_threshold_override -- see app/routers/ingest.py.
    alert_rate_threshold_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    alert_deviation_threshold_override: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Mixed loads (Load Planner, Models 4 + 5). Null for a classic single-category shipment.
    # products: [{product_id, name, quantity_kg}] -- all mutually compatible (Model 5 + policy),
    # checked at creation. recommended_setpoint_c / setpoint_band: Model 4's setpoint for the mix
    # (guarded by the physics optimizer). product_shelf_life: per-product shelf-life consumption,
    # refreshed on every /ingest batch alongside the shipment-level Model 3 numbers.
    products: Mapped[list | None] = mapped_column(JSON, nullable=True)
    recommended_setpoint_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    setpoint_band: Mapped[list | None] = mapped_column(JSON, nullable=True)
    setpoint_method: Mapped[str | None] = mapped_column(String(32), nullable=True)
    product_shelf_life: Mapped[list | None] = mapped_column(JSON, nullable=True)

    truck: Mapped[Truck] = relationship(back_populates="shipments")
    readings: Mapped[list["SensorReading"]] = relationship(back_populates="shipment", order_by="SensorReading.ts")
    alerts: Mapped[list["Alert"]] = relationship(back_populates="shipment", order_by="Alert.ts")


class SensorReading(Base):
    __tablename__ = "sensor_readings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    shipment_id: Mapped[str] = mapped_column(ForeignKey("shipments.id"), index=True, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True, nullable=False)
    temp_c: Mapped[float] = mapped_column(Float, nullable=False)
    humidity: Mapped[float | None] = mapped_column(Float, nullable=True)
    door_open: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    rate_of_change: Mapped[float | None] = mapped_column(Float, nullable=True)
    device_reported_alert: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    anomaly_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_anomaly: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # GPS (plan §5's correction: phone Geolocation API, not new hardware). Optional -- the
    # phone-bridge sends these when it has a geolocation fix and omits/nulls them otherwise, so
    # both columns are nullable and every existing row/reading without GPS stays valid.
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    shipment: Mapped[Shipment] = relationship(back_populates="readings")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    shipment_id: Mapped[str] = mapped_column(ForeignKey("shipments.id"), index=True, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)
    type: Mapped[AlertType] = mapped_column(Enum(AlertType), nullable=False)
    severity: Mapped[AlertSeverity] = mapped_column(Enum(AlertSeverity), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    model1_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)

    # LLM orchestration (app/llm_orchestrator.py) -- Role A, alert reasoning. All nullable: an
    # alert is fully valid with these unset (Ollama unreachable/timed out/malformed output), see
    # that module's docstring for the fallback contract. Never used for actuation -- explanation
    # and recommendation surfaced to a human only.
    llm_assessment: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_recommended_action: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_narrative: Mapped[str | None] = mapped_column(Text, nullable=True)

    shipment: Mapped[Shipment] = relationship(back_populates="alerts")

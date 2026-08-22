"""POST /ingest -- Phase2 plan §2.2 / §2.4: the phone bridge batch-POSTs queued readings here
(after flushing its IndexedDB buffer). Model 3 updates shelf-life-consumed for the shipment on
every batch, per the plan's own description of this endpoint.

Model 1 status: this endpoint calls app/ml.py:score_with_model1() on every reading once enough
rolling-window history exists, but that seam only actually scores anything once a real
models/model1_isolation_forest_frostmind.pkl is present on disk (it isn't yet -- see app/ml.py's
module docstring and backend/README.md's "Model 1 status"). Until then it always returns
(None, None), so behavior is unchanged from before this pass: the ESP32 firmware's own on-device
rate-of-change/deviation threshold rule -- the `alert` boolean already present in every BLE
reading -- remains the system's real current detection mechanism.

Configurable per-shipment alert thresholds (Prototype-to-Production plan §4): if a shipment has
`alert_deviation_threshold_override` and/or `alert_rate_threshold_override` set (via
PATCH /shipments/{id}), a reading that deviates from the category's reference temperature by more
than the deviation override, or whose |rate_of_change| exceeds the rate override, is *also*
flagged as anomalous and can trigger an Alert (subject to the same cooldown as the other anomaly
sources below). When both are null (the default), this check never runs -- current behavior is
unchanged.

Requires a device-scoped `X-Device-Key` header matching the resolved device's
`provisioning_key` (Prototype-to-Production plan §2 A3) -- missing or wrong key gets 401. Every
other field-facing endpoint (device registration, truck/shipment create) stays open per the
existing documented auth-boundary reasoning in devices.py; only /ingest writes sensor data on
behalf of a specific device, so only /ingest gets this check.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated

import numpy as np
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import (
    DEVICE_ALERT_COOLDOWN_SECONDS,
    DOOR_ALERT_COOLDOWN_SECONDS,
    DOOR_OPEN_ALERT_SECONDS,
    DOOR_TRUE_MEANS_OPEN,
    MODEL1_ROLLING_WINDOW,
    SHELF_LIFE_CRITICAL_FRACTION,
    SHELF_LIFE_WARNING_FRACTION,
)
from app.database import get_db
from app.llm_orchestrator import run_alert_reasoning_background
from app.logging_config import get_logger, log_event
from app.ml import MODEL1_ACTIVE, PRODUCT_LIBRARY, compute_shelf_life, score_with_model1
from app.models import Alert, AlertSeverity, AlertType, Device, SensorReading, Shipment, ShipmentStatus
from app.schemas import IngestRequest, IngestResult

router = APIRouter(tags=["ingest"])
logger = get_logger("frostmind.ingest")


def _resolve_device(body: IngestRequest, db: Session) -> Device:
    device = None
    if body.device_id:
        device = db.get(Device, body.device_id)
    elif body.device_mac:
        device = db.query(Device).filter(Device.mac_address == body.device_mac).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found (register it first via POST /devices/register)")
    return device


def _verify_device_key(device: Device, x_device_key: str | None) -> None:
    """Prototype-to-Production plan §2 A3: /ingest is the one field-facing endpoint that writes
    sensor data on behalf of a specific device, so it's the one that gets a device-scoped auth
    check. The phone-bridge sends the provisioning_key it was handed once at
    POST /devices/register (DeviceOut.provisioning_key) back as this header on every /ingest
    call.
    """
    if not x_device_key or x_device_key != device.provisioning_key:
        log_event(
            logger,
            logging.WARNING,
            "device_auth_rejected",
            device_id=device.id,
            reason="missing_header" if not x_device_key else "key_mismatch",
        )
        raise HTTPException(status_code=401, detail="Missing or invalid X-Device-Key header")


def _model1_features(history: list[SensorReading], idx: int) -> tuple[float, float, float, float]:
    """Rolling-window features matching scripts/train_model1_frostmind.py's build_features()
    exactly (WINDOW=10, columns roll_mean/roll_std/rate_of_change/door_open_dur) so that once a
    real model1_isolation_forest_frostmind.pkl is trained on that script's output, scoring here
    lines up with what it was trained on -- see app/ml.py.
    """
    window = history[max(0, idx - MODEL1_ROLLING_WINDOW + 1) : idx + 1]
    temps = [h.temp_c for h in window]
    roll_mean = float(np.mean(temps))
    roll_std = float(np.std(temps, ddof=1)) if len(temps) > 1 else 0.0
    reading = history[idx]
    if reading.rate_of_change is not None:
        rate_of_change = reading.rate_of_change
    elif idx > 0:
        rate_of_change = reading.temp_c - history[idx - 1].temp_c
    else:
        rate_of_change = 0.0
    door_open_dur = float(sum(1 for h in window if h.door_open))
    return roll_mean, roll_std, rate_of_change, door_open_dur


def _resolve_shipment(body: IngestRequest, device: Device, db: Session) -> Shipment:
    if body.shipment_id:
        shipment = db.get(Shipment, body.shipment_id)
        if shipment is None:
            raise HTTPException(status_code=404, detail="Shipment not found")
        return shipment

    if device.truck is None:
        raise HTTPException(status_code=400, detail="Device is not assigned to a truck; cannot infer shipment")

    shipment = (
        db.query(Shipment)
        .filter(Shipment.truck_id == device.truck.id, Shipment.status == ShipmentStatus.in_transit)
        .order_by(Shipment.created_at.desc())
        .first()
    )
    if shipment is None:
        raise HTTPException(
            status_code=400,
            detail="No in-transit shipment for this device's truck; pass shipment_id explicitly or PATCH a shipment to in-transit first",
        )
    return shipment


@router.post("/ingest", response_model=IngestResult)
def ingest(
    body: IngestRequest,
    db: Annotated[Session, Depends(get_db)],
    background_tasks: BackgroundTasks,
    x_device_key: Annotated[str | None, Header(alias="X-Device-Key")] = None,
):
    # Alerts created during this request get LLM reasoning enqueued as background tasks after
    # db.commit() (see the bottom of this function) -- collected here rather than fired
    # inline so the ESP32 waiting on this response is never blocked on local LLM inference
    # (real seconds; see app/llm_orchestrator.py's module docstring).
    new_alerts: list[Alert] = []

    device = _resolve_device(body, db)
    _verify_device_key(device, x_device_key)
    shipment = _resolve_shipment(body, device, db)

    device.last_seen_at = datetime.now(timezone.utc)

    if not body.readings:
        db.commit()
        return IngestResult(
            shipment_id=shipment.id,
            stored=0,
            anomalies_flagged=0,
            alerts_created=0,
            shelf_life_consumed_fraction=shipment.shelf_life_consumed_fraction,
            shelf_life_remaining_hours=shipment.shelf_life_remaining_hours,
        )

    # The device's `ts` is millis() since ESP32 boot, NOT wall-clock time -- the firmware has
    # no RTC or network time source (documented in firmware/frostmind_main/README.md). Treating
    # it as Unix-epoch milliseconds (the previous behavior here) stamped every reading around
    # 1970-01-01, which then fed Model 3's shelf-life integral a ~56-year-old reference point --
    # explains both the bogus dates seen in the admin panel and absurd (>100,000%) shelf-life-
    # consumed values. Fix: anchor the batch's most recent device `ts` to this server's real
    # receipt time, and offset every other reading in the batch from that anchor using the
    # device's own relative spacing -- this keeps intra-batch ordering/spacing accurate (readings
    # really were ~2s apart on-device) while landing on real wall-clock dates.
    received_at = datetime.now(timezone.utc)
    ordered_in = sorted(body.readings, key=lambda r: r.ts)
    anchor_device_ts_ms = ordered_in[-1].ts
    new_rows: list[SensorReading] = []
    for r in ordered_in:
        if r.door is None:
            door_open = None
        else:
            door_open = r.door if DOOR_TRUE_MEANS_OPEN else (not r.door)
        real_ts = received_at - timedelta(milliseconds=(anchor_device_ts_ms - r.ts))
        row = SensorReading(
            shipment_id=shipment.id,
            ts=real_ts,
            temp_c=r.temp,
            humidity=r.hum,
            door_open=door_open,
            rate_of_change=r.roc,
            device_reported_alert=r.alert,
            lat=r.lat,
            lng=r.lng,
        )
        db.add(row)
        new_rows.append(row)
    db.commit()

    # Full chronological history for this shipment, used for Model 3's exposure integral and
    # for the door-open-too-long look-back below. Fine at demo/MVP scale; would need
    # pagination/streaming at real fleet-scale reading volume.
    history = db.execute(
        select(SensorReading).where(SensorReading.shipment_id == shipment.id).order_by(SensorReading.ts)
    ).scalars().all()
    new_ids = {row.id for row in new_rows}

    anomalies_flagged = 0
    alerts_created = 0

    # Cooldown state is tracked in-memory (seeded once from the DB, then updated as alerts are
    # created in this loop) rather than re-queried per reading -- the session has
    # autoflush=False, so a DB query mid-loop would not see Alert rows added earlier in this
    # same request/commit, which would defeat the cooldown entirely on a batch that contains a
    # long continuous door-open or device-alert run (as it did before this fix: a single 140s
    # door-open batch created a new alert on nearly every reading instead of one).
    last_door_alert_ts = (
        db.query(Alert.ts)
        .filter(Alert.shipment_id == shipment.id, Alert.type == AlertType.door_open_too_long)
        .order_by(Alert.ts.desc())
        .limit(1)
        .scalar()
    )
    last_device_alert_ts = (
        db.query(Alert.ts)
        .filter(Alert.shipment_id == shipment.id, Alert.type == AlertType.anomaly)
        .order_by(Alert.ts.desc())
        .limit(1)
        .scalar()
    )

    for idx, reading in enumerate(history):
        if reading.id not in new_ids:
            continue

        # -- Anomaly sources, each independently toggleable --
        # 1. Device-reported: the ESP32's own on-device rate-of-change/deviation threshold rule,
        #    surfaced as the `alert` field in the BLE payload -- this system's real current
        #    detection mechanism.
        device_flagged = bool(reading.device_reported_alert)

        # 2. Model 1: app/ml.py:score_with_model1() is always called (so nothing caller-side
        #    needs to change the day a real .pkl shows up), but it only actually scores anything
        #    once models/model1_isolation_forest_frostmind.pkl exists on disk (MODEL1_ACTIVE) --
        #    until then it's a no-op returning (None, None), same as before this pass. Needs a
        #    full rolling window of history to match how the model was trained (see
        #    scripts/train_model1_frostmind.py's .dropna() on partial windows).
        model1_score: float | None = None
        model1_flagged = False
        if idx + 1 >= MODEL1_ROLLING_WINDOW:
            roll_mean, roll_std, rate_of_change, door_open_dur = _model1_features(history, idx)
            model1_score, model1_is_anomaly = score_with_model1(roll_mean, roll_std, rate_of_change, door_open_dur)
            model1_flagged = bool(model1_is_anomaly)

        # 3. Configurable per-shipment threshold overrides (plan §4) -- inert (both None) unless
        #    PATCH /shipments/{id} set them; when set, checked against this category's reference
        #    temperature / this reading's rate_of_change instead of relying solely on the device
        #    flag or Model 1.
        deviation_flagged = False
        rate_flagged = False
        if shipment.alert_deviation_threshold_override is not None:
            ref_temp_c = PRODUCT_LIBRARY[shipment.category.value].reference_temp_c
            deviation_flagged = abs(reading.temp_c - ref_temp_c) > shipment.alert_deviation_threshold_override
        if shipment.alert_rate_threshold_override is not None and reading.rate_of_change is not None:
            rate_flagged = abs(reading.rate_of_change) > shipment.alert_rate_threshold_override

        reading.anomaly_score = model1_score
        reading.is_anomaly = device_flagged or model1_flagged or deviation_flagged or rate_flagged

        if reading.is_anomaly:
            anomalies_flagged += 1
            cooldown_ok = (
                last_device_alert_ts is None
                or (reading.ts - last_device_alert_ts).total_seconds() >= DEVICE_ALERT_COOLDOWN_SECONDS
            )
            if cooldown_ok:
                sources = []
                if device_flagged:
                    sources.append("device-rule")
                if model1_flagged:
                    sources.append(f"model1(score={model1_score:.3f})")
                if deviation_flagged:
                    sources.append(
                        f"deviation-override(|{reading.temp_c:.1f}C - ref| > {shipment.alert_deviation_threshold_override}C)"
                    )
                if rate_flagged:
                    sources.append(f"rate-override(|roc| > {shipment.alert_rate_threshold_override})")
                message = "Anomaly alert [" + ", ".join(sources) + "]"
                if not MODEL1_ACTIVE:
                    message += " -- Model 1 ML scoring not yet wired up, see backend/README.md 'Model 1 status'"
                alert_row = Alert(
                    shipment_id=shipment.id,
                    ts=reading.ts,
                    type=AlertType.anomaly,
                    severity=AlertSeverity.medium,
                    message=message,
                    model1_score=model1_score,
                )
                db.add(alert_row)
                new_alerts.append(alert_row)
                alerts_created += 1
                last_device_alert_ts = reading.ts
                log_event(
                    logger,
                    logging.INFO,
                    "alert_created",
                    shipment_id=shipment.id,
                    alert_type=AlertType.anomaly.value,
                    severity=AlertSeverity.medium.value,
                    sources=sources,
                )

        # Door-open-too-long check (deterministic, not model-based) -- walk backwards through
        # the continuous run of door_open=True readings ending at this one.
        if reading.door_open:
            start_idx = idx
            while start_idx > 0 and history[start_idx - 1].door_open:
                start_idx -= 1
            open_duration_s = (reading.ts - history[start_idx].ts).total_seconds()
            if open_duration_s >= DOOR_OPEN_ALERT_SECONDS:
                cooldown_ok = (
                    last_door_alert_ts is None
                    or (reading.ts - last_door_alert_ts).total_seconds() >= DOOR_ALERT_COOLDOWN_SECONDS
                )
                if cooldown_ok:
                    alert_row = Alert(
                        shipment_id=shipment.id,
                        ts=reading.ts,
                        type=AlertType.door_open_too_long,
                        severity=AlertSeverity.high,
                        message=f"Door open for {open_duration_s:.0f}s (threshold {DOOR_OPEN_ALERT_SECONDS}s)",
                    )
                    db.add(alert_row)
                    new_alerts.append(alert_row)
                    alerts_created += 1
                    last_door_alert_ts = reading.ts
                    log_event(
                        logger,
                        logging.INFO,
                        "alert_created",
                        shipment_id=shipment.id,
                        alert_type=AlertType.door_open_too_long.value,
                        severity=AlertSeverity.high.value,
                        open_duration_s=open_duration_s,
                    )

    # Model 3: recompute shelf-life-consumed over the full exposure history so far.
    previous_consumed = shipment.shelf_life_consumed_fraction
    if history:
        ref_time = shipment.start_time or history[0].ts
        hours = [(h.ts - ref_time).total_seconds() / 3600.0 for h in history]
        temps = [h.temp_c for h in history]
        consumed, remaining = compute_shelf_life(shipment.category.value, temps, hours, temps[-1])
        shipment.shelf_life_consumed_fraction = consumed
        shipment.shelf_life_remaining_hours = remaining
        shipment.shelf_life_updated_at = datetime.now(timezone.utc)

        crossed_warning = (
            (previous_consumed is None or previous_consumed < SHELF_LIFE_WARNING_FRACTION)
            and consumed >= SHELF_LIFE_WARNING_FRACTION
            and consumed < SHELF_LIFE_CRITICAL_FRACTION
        )
        crossed_critical = (
            previous_consumed is None or previous_consumed < SHELF_LIFE_CRITICAL_FRACTION
        ) and consumed >= SHELF_LIFE_CRITICAL_FRACTION

        if crossed_warning:
            alert_row = Alert(
                shipment_id=shipment.id,
                type=AlertType.shelf_life_threshold,
                severity=AlertSeverity.medium,
                message=f"Shelf life warning: {consumed * 100:.1f}% consumed ({shipment.category.value})",
            )
            db.add(alert_row)
            new_alerts.append(alert_row)
            alerts_created += 1
            log_event(
                logger,
                logging.INFO,
                "alert_created",
                shipment_id=shipment.id,
                alert_type=AlertType.shelf_life_threshold.value,
                severity=AlertSeverity.medium.value,
                consumed_fraction=consumed,
            )
        if crossed_critical:
            alert_row = Alert(
                shipment_id=shipment.id,
                type=AlertType.shelf_life_threshold,
                severity=AlertSeverity.critical,
                message=f"Shelf life EXCEEDED: {consumed * 100:.1f}% consumed ({shipment.category.value})",
            )
            db.add(alert_row)
            new_alerts.append(alert_row)
            alerts_created += 1
            log_event(
                logger,
                logging.INFO,
                "alert_created",
                shipment_id=shipment.id,
                alert_type=AlertType.shelf_life_threshold.value,
                severity=AlertSeverity.critical.value,
                consumed_fraction=consumed,
            )

    db.commit()

    # Enqueue LLM alert reasoning (app/llm_orchestrator.py Role A) now that every new_alerts row
    # has a real, committed id -- one background task per alert, each opens its own DB session
    # (see run_alert_reasoning_background's docstring for why). Never awaited here; this returns
    # immediately regardless of how long Ollama takes or whether it's reachable at all.
    for alert_row in new_alerts:
        background_tasks.add_task(run_alert_reasoning_background, alert_row.id)

    return IngestResult(
        shipment_id=shipment.id,
        stored=len(new_rows),
        anomalies_flagged=anomalies_flagged,
        alerts_created=alerts_created,
        shelf_life_consumed_fraction=shipment.shelf_life_consumed_fraction,
        shelf_life_remaining_hours=shipment.shelf_life_remaining_hours,
    )

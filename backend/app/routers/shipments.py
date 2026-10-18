"""Shipment CRUD + reads (Phase2 plan §2.2). Read endpoints (list/detail/readings/alerts/report)
require JWT -- these back the admin panel (§5). Create/update are left open for the phone-bridge
setup wizard, same reasoning as devices.py.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.database import get_db
from app.models import Alert, Device, SensorReading, Shipment, ShipmentStatus, Truck
from app import load_planner
from app.llm_orchestrator import generate_compliance_report, llm_status
from app.ml import MODEL1_ACTIVE
from app.models import ProductCategory
from app.schemas import (
    AlertOut,
    ComplianceReportOut,
    FleetShipmentOut,
    LiveShipmentOut,
    SensorReadingOut,
    ShipmentCreatedOut,
    ShipmentCreateRequest,
    ShipmentOut,
    ShipmentUpdateRequest,
)

router = APIRouter(prefix="/shipments", tags=["shipments"])


@router.post("", response_model=ShipmentCreatedOut, status_code=201)
def create_shipment(body: ShipmentCreateRequest, db: Annotated[Session, Depends(get_db)]):
    truck = db.get(Truck, body.truck_id)
    if truck is None:
        raise HTTPException(status_code=404, detail="Truck not found")

    mixed = None
    if body.products:
        # Mixed load: Model 5 + policy vetoes must agree everything fits in ONE compartment, and
        # Model 4 picks the setpoint (using this truck's own measured temperature wobble).
        from app.routers.planner import _truck_sigma

        try:
            mixed = load_planner.plan_for_shipment(
                [(p.product_id, p.quantity_kg) for p in body.products], _truck_sigma(db, truck.id)
            )
        except load_planner.UnknownProductError as exc:
            raise HTTPException(status_code=422, detail=f"Unknown product_id: {exc.args[0]}")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=exc.args[0])

    shipment = Shipment(
        truck_id=body.truck_id,
        category=ProductCategory(mixed["category"]) if mixed else body.category,
        status=body.status,
        label=body.label,
        start_time=datetime.now(timezone.utc) if body.status == ShipmentStatus.in_transit else None,
        products=mixed["products"] if mixed else None,
        recommended_setpoint_c=mixed["recommended_setpoint_c"] if mixed else None,
        setpoint_band=mixed["setpoint_band"] if mixed else None,
        setpoint_method=mixed["setpoint_method"] if mixed else None,
    )
    db.add(shipment)
    db.commit()
    db.refresh(shipment)
    out = ShipmentCreatedOut.model_validate(shipment)
    if mixed:
        out.device_category = mixed["device_category"]
        out.device_category_within_1c = mixed["device_category_within_1c"]
    else:
        out.device_category = shipment.category.value
        out.device_category_within_1c = True
    return out


def ai_summary() -> dict:
    """Which AI components are live right now -- shown on the phone dashboard and admin panel."""
    llm = llm_status(live=False)
    return {
        "model0_device_rule": "live on the ESP32",
        "model1_anomaly": "active" if MODEL1_ACTIVE else "inactive (needs FROSTMIND's own labelled logs)",
        "model3_shelf_life": "active",
        "model4_setpoint": "active" if load_planner.MODEL4_ACTIVE else "physics-only",
        "model5_compatibility": "active" if load_planner.MODEL5_ACTIVE else "rules-only",
        "llm": f"active ({llm['model']})" if llm.get("model") else "unknown until the first explanation is requested",
    }


@router.get("/{shipment_id}/live", response_model=LiveShipmentOut)
def get_shipment_live(
    shipment_id: str,
    db: Annotated[Session, Depends(get_db)],
    x_device_key: Annotated[str | None, Header(alias="X-Device-Key")] = None,
):
    """Phone dashboard feed. The phone has no admin login, so this is authorised with the same
    device-scoped X-Device-Key it already uses for /ingest: only the device fitted to this
    shipment's truck can read it. Returns the shipment (incl. Model 3 + per-product shelf life,
    Model 4 setpoint), its latest reading, the last few alerts WITH their LLM explanations, and
    which AI components are live."""
    shipment = db.get(Shipment, shipment_id)
    if shipment is None:
        raise HTTPException(status_code=404, detail="Shipment not found")
    device = shipment.truck.device if shipment.truck else None
    if device is None or not x_device_key or x_device_key != device.provisioning_key:
        raise HTTPException(status_code=401, detail="Missing or invalid X-Device-Key header")
    latest = (
        db.query(SensorReading)
        .filter(SensorReading.shipment_id == shipment_id)
        .order_by(SensorReading.ts.desc())
        .first()
    )
    alerts = (
        db.query(Alert).filter(Alert.shipment_id == shipment_id).order_by(Alert.ts.desc()).limit(5).all()
    )
    return {
        "shipment": shipment,
        "latest_reading": latest,
        "alerts": alerts,
        "ai": ai_summary(),
    }


@router.get("", response_model=list[FleetShipmentOut])
def list_shipments(current_user: CurrentUser, db: Annotated[Session, Depends(get_db)]):
    """Fleet view (Phase2 plan §5): every truck/device, current shipment, status, last-seen --
    joined into one response so the admin web app doesn't need N+1 round trips.
    """
    shipments = db.query(Shipment).order_by(Shipment.created_at.desc()).all()
    out = []
    for s in shipments:
        truck = s.truck
        device = truck.device if truck else None
        latest = (
            db.query(SensorReading)
            .filter(SensorReading.shipment_id == s.id)
            .order_by(SensorReading.ts.desc())
            .first()
        )
        open_alerts = (
            db.query(Alert).filter(Alert.shipment_id == s.id, Alert.acknowledged.is_(False)).count()
        )
        # Most recent reading that actually carries a GPS fix (plan §5's correction: phone
        # Geolocation API) -- not necessarily `latest` above, which may itself lack GPS if the
        # phone denied/lost location permission on its most recent reading.
        latest_gps = (
            db.query(SensorReading)
            .filter(
                SensorReading.shipment_id == s.id,
                SensorReading.lat.isnot(None),
                SensorReading.lng.isnot(None),
            )
            .order_by(SensorReading.ts.desc())
            .first()
        )
        out.append(
            FleetShipmentOut(
                id=s.id,
                truck_id=s.truck_id,
                category=s.category,
                status=s.status,
                label=s.label,
                start_time=s.start_time,
                end_time=s.end_time,
                created_at=s.created_at,
                shelf_life_consumed_fraction=s.shelf_life_consumed_fraction,
                shelf_life_remaining_hours=s.shelf_life_remaining_hours,
                shelf_life_updated_at=s.shelf_life_updated_at,
                alert_rate_threshold_override=s.alert_rate_threshold_override,
                alert_deviation_threshold_override=s.alert_deviation_threshold_override,
                truck_label=truck.label if truck else "",
                truck_plate=truck.plate if truck else None,
                device_id=device.id if device else None,
                device_name=device.name if device else None,
                device_last_seen_at=device.last_seen_at if device else None,
                latest_temp_c=latest.temp_c if latest else None,
                latest_humidity=latest.humidity if latest else None,
                latest_door_open=latest.door_open if latest else None,
                latest_reading_ts=latest.ts if latest else None,
                open_alert_count=open_alerts,
                latest_lat=latest_gps.lat if latest_gps else None,
                latest_lng=latest_gps.lng if latest_gps else None,
            )
        )
    return out


@router.get("/{shipment_id}", response_model=ShipmentOut)
def get_shipment(shipment_id: str, current_user: CurrentUser, db: Annotated[Session, Depends(get_db)]):
    shipment = db.get(Shipment, shipment_id)
    if shipment is None:
        raise HTTPException(status_code=404, detail="Shipment not found")
    return shipment


@router.patch("/{shipment_id}", response_model=ShipmentOut)
def update_shipment(shipment_id: str, body: ShipmentUpdateRequest, db: Annotated[Session, Depends(get_db)]):
    shipment = db.get(Shipment, shipment_id)
    if shipment is None:
        raise HTTPException(status_code=404, detail="Shipment not found")

    if body.category is not None:
        shipment.category = body.category
    if body.label is not None:
        shipment.label = body.label
    if body.status is not None:
        if body.status == ShipmentStatus.in_transit and shipment.start_time is None:
            shipment.start_time = datetime.now(timezone.utc)
        if body.status == ShipmentStatus.delivered and shipment.end_time is None:
            shipment.end_time = datetime.now(timezone.utc)
        shipment.status = body.status
    # `is not None` (like the fields above) can't tell "not sent" apart from "sent as null" --
    # for the fields above that's fine (nothing clears a category/label/status back to empty),
    # but a threshold override needs "send null" to mean "clear it back to the category default",
    # not "leave whatever was there." model_fields_set distinguishes the two.
    if "alert_rate_threshold_override" in body.model_fields_set:
        shipment.alert_rate_threshold_override = body.alert_rate_threshold_override
    if "alert_deviation_threshold_override" in body.model_fields_set:
        shipment.alert_deviation_threshold_override = body.alert_deviation_threshold_override

    db.commit()
    db.refresh(shipment)
    return shipment


@router.get("/{shipment_id}/readings", response_model=list[SensorReadingOut])
def get_readings(
    shipment_id: str,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    limit: int = 500,
):
    shipment = db.get(Shipment, shipment_id)
    if shipment is None:
        raise HTTPException(status_code=404, detail="Shipment not found")
    return (
        db.query(SensorReading)
        .filter(SensorReading.shipment_id == shipment_id)
        .order_by(SensorReading.ts.desc())
        .limit(limit)
        .all()[::-1]
    )


@router.get("/{shipment_id}/alerts", response_model=list[AlertOut])
def get_shipment_alerts(shipment_id: str, current_user: CurrentUser, db: Annotated[Session, Depends(get_db)]):
    shipment = db.get(Shipment, shipment_id)
    if shipment is None:
        raise HTTPException(status_code=404, detail="Shipment not found")
    return db.query(Alert).filter(Alert.shipment_id == shipment_id).order_by(Alert.ts.desc()).all()


@router.get("/{shipment_id}/report")
def get_shipment_report(shipment_id: str, current_user: CurrentUser, db: Annotated[Session, Depends(get_db)]):
    """Exportable audit trail (Phase2 plan §5 "Reports/export" / §7 compliance evidence):
    temp/humidity/door history + alerts + category, as a downloadable CSV.
    """
    shipment = db.get(Shipment, shipment_id)
    if shipment is None:
        raise HTTPException(status_code=404, detail="Shipment not found")

    readings = (
        db.query(SensorReading).filter(SensorReading.shipment_id == shipment_id).order_by(SensorReading.ts).all()
    )
    alerts = db.query(Alert).filter(Alert.shipment_id == shipment_id).order_by(Alert.ts).all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["FROSTMIND shipment audit report"])
    writer.writerow(["shipment_id", shipment.id])
    writer.writerow(["truck_id", shipment.truck_id])
    writer.writerow(["category", shipment.category.value])
    writer.writerow(["status", shipment.status.value])
    writer.writerow(["start_time", shipment.start_time])
    writer.writerow(["end_time", shipment.end_time])
    writer.writerow(["shelf_life_consumed_fraction", shipment.shelf_life_consumed_fraction])
    writer.writerow(["shelf_life_remaining_hours", shipment.shelf_life_remaining_hours])
    writer.writerow([])
    writer.writerow(["-- readings --"])
    writer.writerow(
        ["ts", "temp_c", "humidity", "door_open", "rate_of_change", "anomaly_score", "is_anomaly", "lat", "lng"]
    )
    for r in readings:
        writer.writerow(
            [r.ts, r.temp_c, r.humidity, r.door_open, r.rate_of_change, r.anomaly_score, r.is_anomaly, r.lat, r.lng]
        )
    writer.writerow([])
    writer.writerow(["-- alerts --"])
    writer.writerow(["ts", "type", "severity", "message", "model1_score", "acknowledged"])
    for a in alerts:
        writer.writerow([a.ts, a.type.value, a.severity.value, a.message, a.model1_score, a.acknowledged])

    buf.seek(0)
    filename = f"frostmind_shipment_{shipment_id}_report.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{shipment_id}/compliance_report", response_model=ComplianceReportOut)
async def generate_shipment_compliance_report(
    shipment_id: str, current_user: CurrentUser, db: Annotated[Session, Depends(get_db)]
):
    """LLM orchestration Role B (see app/llm_orchestrator.py) -- an on-demand, human-readable
    incident narrative, generated fresh on every call (not cached/stored) since it's meant to
    reflect the shipment's current full history at request time. Complements the CSV report
    above rather than replacing it: the CSV is the raw audit data, this is prose synthesizing it.
    A `narrative: null` response means generation failed (Ollama unreachable/timeout/malformed
    output) -- the caller must surface that as "try again", never fabricate text client-side.
    """
    shipment = db.get(Shipment, shipment_id)
    if shipment is None:
        raise HTTPException(status_code=404, detail="Shipment not found")

    readings = (
        db.query(SensorReading).filter(SensorReading.shipment_id == shipment_id).order_by(SensorReading.ts).all()
    )
    alerts = db.query(Alert).filter(Alert.shipment_id == shipment_id).order_by(Alert.ts).all()

    narrative = await generate_compliance_report(shipment, readings, alerts)
    return ComplianceReportOut(shipment_id=shipment_id, narrative=narrative)

"""Load Planner endpoints -- where Models 4 and 5 are used in FROSTMIND.

GET  /products       the cleaned product catalog (public, like /categories -- reference data).
POST /planner/plan   admin-JWT protected like the other admin endpoints. Given the products (and
                     quantities) a dispatcher wants to ship, returns:
                       * every pair's compatibility (Model 5 probability + policy vetoes +
                         feasibility, with plain-English reasons),
                       * the products split into compatible groups (one compartment/truck each),
                       * each group's recommended reefer setpoint (Model 4, guarded by the
                         physics optimizer) plus the nearest FROSTMIND device category, whose
                         setpoint the ESP32 already applies via BLE `set_category`.

Reefer fluctuation sigma: explicit `sigma_c`, else the std of the chosen truck's most recent
readings (if it has enough), else the real-data default from reefer_fluctuation.json.
"""
from __future__ import annotations

from typing import Annotated

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import load_planner
from app.auth import CurrentUser
from app.config import PLANNER_MIN_READINGS_FOR_SIGMA
from app.database import get_db
from app.models import SensorReading, Shipment, Truck
from app.schemas import PlanRequest, PlanResponse, ProductOut

router = APIRouter(tags=["planner"])


@router.get("/products", response_model=list[ProductOut])
def list_products():
    return load_planner.list_products()


def _truck_sigma(db: Session, truck_id: str) -> float | None:
    readings = (
        db.query(SensorReading.temp_c)
        .join(Shipment, SensorReading.shipment_id == Shipment.id)
        .filter(Shipment.truck_id == truck_id)
        .order_by(SensorReading.ts.desc())
        .limit(500)
        .all()
    )
    if len(readings) < PLANNER_MIN_READINGS_FOR_SIGMA:
        return None
    return float(np.std([r[0] for r in readings]))


@router.post("/planner/plan", response_model=PlanResponse)
def plan(body: PlanRequest, current_user: CurrentUser, db: Annotated[Session, Depends(get_db)]):
    sigma, source = None, "default (real milk-transport data)"
    if body.sigma_c is not None:
        sigma, source = body.sigma_c, "request"
    elif body.truck_id:
        if db.get(Truck, body.truck_id) is None:
            raise HTTPException(status_code=404, detail="Truck not found")
        sigma = _truck_sigma(db, body.truck_id)
        source = "truck readings" if sigma is not None else "default (truck has too few readings)"
    try:
        result = load_planner.plan_load([(p.product_id, p.quantity_kg) for p in body.products], sigma)
    except load_planner.UnknownProductError as exc:
        raise HTTPException(status_code=422, detail=f"Unknown product_id: {exc.args[0]}")
    return {**result, "sigma_source": source}

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Truck
from app.schemas import TruckCreateRequest, TruckOut, TruckUpdateRequest

router = APIRouter(prefix="/trucks", tags=["trucks"])


@router.post("", response_model=TruckOut, status_code=201)
def create_truck(body: TruckCreateRequest, db: Annotated[Session, Depends(get_db)]):
    # device_id is UNIQUE on trucks (one truck per device) -- re-running the setup wizard
    # against an already-registered device (e.g. a retry, or re-opening the wizard after a
    # partial failure earlier in the flow) would otherwise hit an IntegrityError here. That
    # unhandled exception doesn't just 500 -- it escapes before CORSMiddleware can attach
    # headers to the error response, so the browser reports it to JS as a bare "Failed to
    # fetch" with no real error visible client-side. Same idempotent-on-conflict pattern as
    # devices.register_device: treat a repeat as "update and return the existing truck", not
    # a hard failure -- a user renaming the truck on a later run should still take effect.
    existing = db.query(Truck).filter(Truck.device_id == body.device_id).first()
    if existing is not None:
        existing.label = body.label
        existing.plate = body.plate
        db.commit()
        db.refresh(existing)
        return existing

    truck = Truck(label=body.label, plate=body.plate, device_id=body.device_id)
    db.add(truck)
    db.commit()
    db.refresh(truck)
    return truck


@router.get("", response_model=list[TruckOut])
def list_trucks(db: Annotated[Session, Depends(get_db)]):
    return db.query(Truck).order_by(Truck.created_at.desc()).all()


@router.get("/{truck_id}", response_model=TruckOut)
def get_truck(truck_id: str, db: Annotated[Session, Depends(get_db)]):
    truck = db.get(Truck, truck_id)
    if truck is None:
        raise HTTPException(status_code=404, detail="Truck not found")
    return truck


@router.patch("/{truck_id}", response_model=TruckOut)
def update_truck(truck_id: str, body: TruckUpdateRequest, db: Annotated[Session, Depends(get_db)]):
    truck = db.get(Truck, truck_id)
    if truck is None:
        raise HTTPException(status_code=404, detail="Truck not found")
    if body.label is not None:
        truck.label = body.label
    if body.plate is not None:
        truck.plate = body.plate
    if body.device_id is not None:
        truck.device_id = body.device_id
    db.commit()
    db.refresh(truck)
    return truck

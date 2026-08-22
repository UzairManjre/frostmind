"""Device registration + auto-pairing lifecycle (Phase2 plan §2.2, §3, §4 step 4).

Registration and pairing are left unauthenticated (no JWT) -- these are the endpoints the
phone-bridge setup wizard calls before any admin login concept applies (the wizard flow in
§4 has no login step). See backend/README.md "Auth boundaries" for the full reasoning; the
admin-panel read endpoints (fleet/shipment/alert views) are the ones actually protected.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.logging_config import get_logger, log_event
from app.models import Device, PairingState
from app.schemas import (
    DeviceOut,
    DeviceRegisterRequest,
    DeviceUpdateRequest,
    PairingStartResponse,
    PairingStatusOut,
    PairingStatusUpdate,
)

router = APIRouter(prefix="/devices", tags=["devices"])
logger = get_logger("frostmind.devices")


@router.post("/register", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
def register_device(body: DeviceRegisterRequest, db: Annotated[Session, Depends(get_db)]):
    existing = db.query(Device).filter(Device.mac_address == body.mac_address).first()
    if existing is not None:
        # Re-registering an already-known device is idempotent -- return it as-is rather
        # than erroring, since a driver re-running the wizard on the same device is a normal
        # flow, not a conflict.
        return existing

    device = Device(mac_address=body.mac_address, serial=body.serial, name=body.name)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


@router.get("", response_model=list[DeviceOut])
def list_devices(db: Annotated[Session, Depends(get_db)]):
    return db.query(Device).order_by(Device.created_at.desc()).all()


@router.get("/{device_id}", response_model=DeviceOut)
def get_device(device_id: str, db: Annotated[Session, Depends(get_db)]):
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.patch("/{device_id}", response_model=DeviceOut)
def update_device(device_id: str, body: DeviceUpdateRequest, db: Annotated[Session, Depends(get_db)]):
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if body.name is not None:
        device.name = body.name
    db.commit()
    db.refresh(device)
    return device


@router.post("/{device_id}/pairing/start", response_model=PairingStartResponse)
def start_pairing(device_id: str, db: Annotated[Session, Depends(get_db)]):
    """Records that auto-pairing (Phase2 plan §3) has started. The actual `{"cmd":"start_pairing"}`
    BLE write to the device is done client-side by the phone bridge (the backend has no BLE
    radio) -- this just gives the admin panel and the phone something to poll via
    GET /devices/{id}/pairing/status.
    """
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    previous_state = device.pairing_state
    device.pairing_state = PairingState.scanning
    device.pairing_started_at = datetime.now(timezone.utc)
    device.pairing_candidate_index = None
    device.pairing_total_candidates = None
    db.commit()
    db.refresh(device)
    log_event(
        logger,
        logging.INFO,
        "pairing_state_changed",
        device_id=device.id,
        from_state=previous_state.value,
        to_state=device.pairing_state.value,
    )
    return PairingStartResponse(
        device_id=device.id, pairing_state=device.pairing_state, pairing_started_at=device.pairing_started_at
    )


@router.post("/{device_id}/pairing/status", response_model=PairingStatusOut)
def report_pairing_status(device_id: str, body: PairingStatusUpdate, db: Annotated[Session, Depends(get_db)]):
    """Phone bridge calls this after relaying a `pairing_status` BLE TX notification, so the
    backend (and therefore the admin panel) has a live view of pairing progress without needing
    its own BLE connection.
    """
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    previous_state = device.pairing_state
    device.pairing_state = body.state
    device.pairing_candidate_index = body.candidate_index
    device.pairing_total_candidates = body.total
    if body.paired_protocol:
        device.paired_protocol = body.paired_protocol
    device.last_seen_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(device)
    if previous_state != device.pairing_state:
        log_event(
            logger,
            logging.INFO,
            "pairing_state_changed",
            device_id=device.id,
            from_state=previous_state.value,
            to_state=device.pairing_state.value,
        )
    return PairingStatusOut(
        device_id=device.id,
        state=device.pairing_state,
        candidate_index=device.pairing_candidate_index,
        total=device.pairing_total_candidates,
        paired_protocol=device.paired_protocol,
        started_at=device.pairing_started_at,
    )


@router.get("/{device_id}/pairing/status", response_model=PairingStatusOut)
def get_pairing_status(device_id: str, db: Annotated[Session, Depends(get_db)]):
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return PairingStatusOut(
        device_id=device.id,
        state=device.pairing_state,
        candidate_index=device.pairing_candidate_index,
        total=device.pairing_total_candidates,
        paired_protocol=device.paired_protocol,
        started_at=device.pairing_started_at,
    )

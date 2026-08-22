"""Fleet-wide alerts feed (Phase2 plan §5): anomaly detections + shelf-life-threshold breaches
across the whole fleet, not just one shipment. Requires JWT -- admin panel view.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.database import get_db
from app.models import Alert, AlertType
from app.schemas import AlertAckRequest, AlertOut

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[AlertOut])
def list_alerts(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    type: AlertType | None = None,
    acknowledged: bool | None = None,
    limit: int = 200,
):
    query = db.query(Alert)
    if type is not None:
        query = query.filter(Alert.type == type)
    if acknowledged is not None:
        query = query.filter(Alert.acknowledged == acknowledged)
    return query.order_by(Alert.ts.desc()).limit(limit).all()


@router.patch("/{alert_id}", response_model=AlertOut)
def ack_alert(alert_id: str, body: AlertAckRequest, db: Annotated[Session, Depends(get_db)]):
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.acknowledged = body.acknowledged
    db.commit()
    db.refresh(alert)
    return alert

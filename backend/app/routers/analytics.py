"""GET /analytics/fleet -- Prototype-to-Production plan §4's "fleet-level analytics/trends view":
"how many excursions this month," "which routes/trucks have the most alerts." Admin-JWT
protected like the other admin-read endpoints (fleet view, alerts feed, report export).

Design notes (so the numbers mean something specific, not just "whatever seemed easiest"):
- total_alerts / by_type are trailing-N-day counts (Alert.ts >= now - period_days), matching the
  plan's own "excursions this month" framing.
- by_type includes every AlertType, even ones with a zero count in the period, so callers get a
  stable set of keys to render (a bar chart/table row per type) rather than conditionally
  handling missing categories.
- by_truck includes every truck currently in the fleet (0 if it had no alerts in the period),
  sorted by alert_count descending, so "which trucks have the most alerts" is answerable at a
  glance and trucks with a clean record are visibly present, not silently omitted.
- shipments_active is a live snapshot (currently status=in-transit), not time-boxed by
  period_days -- it answers "how many shipments are on the road right now," which isn't a trend.
- shipments_completed is trend-scoped: shipments marked delivered (end_time set) within the
  trailing period_days -- "how many shipments wrapped up this month."
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.database import get_db
from app.models import Alert, AlertType, Shipment, ShipmentStatus, Truck
from app.schemas import AlertTypeCount, FleetAnalyticsOut, TruckAlertCount

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/fleet", response_model=FleetAnalyticsOut)
def fleet_analytics(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    days: int = 30,
):
    since = datetime.now(timezone.utc) - timedelta(days=days)

    period_alerts = db.query(Alert).filter(Alert.ts >= since).all()
    total_alerts = len(period_alerts)

    counts_by_type: dict[AlertType, int] = {t: 0 for t in AlertType}
    counts_by_truck: dict[str, int] = {}
    for alert in period_alerts:
        counts_by_type[alert.type] = counts_by_type.get(alert.type, 0) + 1
        truck_id = alert.shipment.truck_id if alert.shipment else None
        if truck_id:
            counts_by_truck[truck_id] = counts_by_truck.get(truck_id, 0) + 1

    by_type = [AlertTypeCount(type=t.value, count=counts_by_type.get(t, 0)) for t in AlertType]

    trucks = db.query(Truck).all()
    by_truck = sorted(
        (
            TruckAlertCount(truck_id=truck.id, truck_label=truck.label, alert_count=counts_by_truck.get(truck.id, 0))
            for truck in trucks
        ),
        key=lambda t: t.alert_count,
        reverse=True,
    )

    shipments_active = db.query(Shipment).filter(Shipment.status == ShipmentStatus.in_transit).count()
    shipments_completed = (
        db.query(Shipment)
        .filter(Shipment.status == ShipmentStatus.delivered, Shipment.end_time >= since)
        .count()
    )

    return FleetAnalyticsOut(
        period_days=days,
        total_alerts=total_alerts,
        by_type=by_type,
        by_truck=by_truck,
        shipments_active=shipments_active,
        shipments_completed=shipments_completed,
    )

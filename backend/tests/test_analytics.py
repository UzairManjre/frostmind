"""GET /analytics/fleet aggregates real Alert/Shipment/Truck data over the trailing N days, and
is admin-JWT protected like the other admin-read endpoints.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from helpers import admin_headers, create_shipment, create_truck, frozen_time, ingest_batch, register_device, setup_device_truck_shipment


def _ts_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def test_fleet_analytics_requires_admin_auth(client):
    resp = client.get("/analytics/fleet")
    assert resp.status_code == 401


def test_fleet_analytics_aggregates_real_data(client):
    headers = admin_headers(client)

    ctx1 = setup_device_truck_shipment(client, category="pasteurized_milk", label="Truck A")
    device1, shipment1 = ctx1["device"], ctx1["shipment"]

    device2 = register_device(client, mac="AA:BB:CC:DD:EE:02", name="Device 2")
    truck2 = create_truck(client, device2["id"], label="Truck B")
    shipment2 = create_shipment(client, truck2["id"], category="frozen_food_generic")

    base = datetime.now(timezone.utc)

    # Truck A: one device-flagged anomaly alert.
    r1 = {"ts": _ts_ms(base), "temp": 20.0, "hum": 50.0, "door": False, "roc": 5.0, "alert": True, "lat": None, "lng": None}
    resp1 = ingest_batch(client, device1["mac_address"], shipment1["id"], [r1], device1["provisioning_key"])
    assert resp1.status_code == 200 and resp1.json()["alerts_created"] == 1

    # Truck B: door-open-too-long alert (130s continuous, 66 readings 2s apart).
    readings2 = [
        {
            "ts": _ts_ms(base + timedelta(seconds=2 * i)),
            "temp": -18.0,
            "hum": 40.0,
            "door": True,
            "roc": 0.1,
            "alert": False,
            "lat": None,
            "lng": None,
        }
        for i in range(66)
    ]
    resp2 = ingest_batch(client, device2["mac_address"], shipment2["id"], readings2, device2["provisioning_key"])
    assert resp2.status_code == 200 and resp2.json()["alerts_created"] == 1

    resp = client.get("/analytics/fleet?days=30", headers=headers)
    assert resp.status_code == 200
    data = resp.json()

    assert data["period_days"] == 30
    assert data["total_alerts"] == 2

    by_type = {row["type"]: row["count"] for row in data["by_type"]}
    assert by_type["anomaly"] == 1
    assert by_type["door-open-too-long"] == 1
    assert by_type["shelf-life-threshold"] == 0  # present with a real zero, not omitted

    by_truck = {row["truck_label"]: row["alert_count"] for row in data["by_truck"]}
    assert by_truck["Truck A"] == 1
    assert by_truck["Truck B"] == 1

    assert data["shipments_active"] == 2
    assert data["shipments_completed"] == 0

    # Mark shipment1 delivered -> active drops, completed rises.
    client.patch(f"/shipments/{shipment1['id']}", json={"status": "delivered"}, headers=headers)
    data2 = client.get("/analytics/fleet?days=30", headers=headers).json()
    assert data2["shipments_active"] == 1
    assert data2["shipments_completed"] == 1


def test_fleet_analytics_period_days_excludes_old_alerts(client):
    headers = admin_headers(client)
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]

    # An alert timestamped far in the past (outside a 1-day window) shouldn't count, even though
    # it's stored via the same ingest path -- simulate by ingesting an alert-worthy reading with
    # a ts 10 days ago.
    old_ts = datetime.now(timezone.utc) - timedelta(days=10)
    r = {"ts": _ts_ms(old_ts), "temp": 25.0, "hum": 50.0, "door": False, "roc": 5.0, "alert": True, "lat": None, "lng": None}
    with frozen_time(old_ts):
        resp = ingest_batch(client, device["mac_address"], shipment["id"], [r], device["provisioning_key"])
    assert resp.status_code == 200 and resp.json()["alerts_created"] == 1

    data = client.get("/analytics/fleet?days=1", headers=headers).json()
    assert data["total_alerts"] == 0

    data_30 = client.get("/analytics/fleet?days=30", headers=headers).json()
    assert data_30["total_alerts"] == 1

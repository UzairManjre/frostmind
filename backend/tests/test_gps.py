"""GPS field plumbing (plan §5's correction: phone Geolocation API, not new hardware). Optional
lat/lng on each /ingest reading; GET /shipments surfaces each shipment's most recent *non-null*
GPS fix, which may not be the same reading as the literal latest one.
"""
from __future__ import annotations

from helpers import admin_headers, ingest_batch, setup_device_truck_shipment


def test_latest_gps_falls_back_to_most_recent_non_null_fix(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]
    headers = admin_headers(client)

    readings = [
        {"ts": 1_700_000_000_000, "temp": 4.0, "hum": 50.0, "door": False, "roc": None, "alert": False, "lat": None, "lng": None},
        {"ts": 1_700_000_002_000, "temp": 4.1, "hum": 50.0, "door": False, "roc": None, "alert": False, "lat": 12.34, "lng": 56.78},
        {"ts": 1_700_000_004_000, "temp": 4.2, "hum": 50.0, "door": False, "roc": None, "alert": False, "lat": None, "lng": None},
    ]
    resp = ingest_batch(client, device["mac_address"], shipment["id"], readings, device["provisioning_key"])
    assert resp.status_code == 200

    fleet = client.get("/shipments", headers=headers).json()
    row = next(s for s in fleet if s["id"] == shipment["id"])

    # Latest reading (ts=...004) has no GPS fix; latest_lat/lng must fall back to the reading at
    # ts=...002, not report null just because the very latest reading lacks one.
    assert row["latest_lat"] == 12.34
    assert row["latest_lng"] == 56.78
    assert row["latest_temp_c"] == 4.2  # still reflects the true latest reading for non-GPS fields


def test_no_gps_ever_reported_stays_null(client):
    ctx = setup_device_truck_shipment(client, category="frozen_food_generic")
    device, shipment = ctx["device"], ctx["shipment"]
    headers = admin_headers(client)

    resp = ingest_batch(
        client,
        device["mac_address"],
        shipment["id"],
        [{"ts": 1_700_000_000_000, "temp": -18.0, "hum": 40.0, "door": False, "roc": None, "alert": False, "lat": None, "lng": None}],
        device["provisioning_key"],
    )
    assert resp.status_code == 200

    fleet = client.get("/shipments", headers=headers).json()
    row = next(s for s in fleet if s["id"] == shipment["id"])
    assert row["latest_lat"] is None
    assert row["latest_lng"] is None

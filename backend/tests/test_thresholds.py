"""Configurable per-shipment alert thresholds (Prototype-to-Production plan §4): setting
alert_deviation_threshold_override / alert_rate_threshold_override via PATCH /shipments/{id}
changes /ingest's alert behavior; leaving them null leaves behavior exactly as before.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from helpers import admin_headers, ingest_batch, setup_device_truck_shipment


def _ts_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _reading(ts_ms: int, temp: float, roc: float | None = 0.5) -> dict:
    return {"ts": ts_ms, "temp": temp, "hum": 50.0, "door": False, "roc": roc, "alert": False, "lat": None, "lng": None}


def test_deviation_override_null_by_default_no_alert(client):
    ctx = setup_device_truck_shipment(client, category="pasteurized_milk")  # reference 4C
    device, shipment = ctx["device"], ctx["shipment"]
    assert shipment["alert_deviation_threshold_override"] is None

    base = datetime.now(timezone.utc)
    # 5C above the category's 4C reference, device alert=false -- with no override set, current
    # behavior is unchanged: nothing about a plain temperature deviation should trigger an alert
    # on its own.
    resp = ingest_batch(
        client, device["mac_address"], shipment["id"], [_reading(_ts_ms(base), 9.0)], device["provisioning_key"]
    )
    assert resp.status_code == 200
    assert resp.json()["alerts_created"] == 0


def test_deviation_override_set_triggers_alert(client):
    ctx = setup_device_truck_shipment(client, category="pasteurized_milk")
    device, shipment = ctx["device"], ctx["shipment"]
    headers = admin_headers(client)

    patch = client.patch(
        f"/shipments/{shipment['id']}", json={"alert_deviation_threshold_override": 2.0}, headers=headers
    )
    assert patch.status_code == 200
    assert patch.json()["alert_deviation_threshold_override"] == 2.0

    base = datetime.now(timezone.utc)
    resp = ingest_batch(
        client, device["mac_address"], shipment["id"], [_reading(_ts_ms(base), 9.0)], device["provisioning_key"]
    )
    assert resp.status_code == 200
    assert resp.json()["alerts_created"] == 1

    alerts = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    anomaly = [a for a in alerts if a["type"] == "anomaly"]
    assert len(anomaly) == 1
    assert "deviation-override" in anomaly[0]["message"]


def test_rate_override_set_triggers_alert(client):
    ctx = setup_device_truck_shipment(client, category="pasteurized_milk")
    device, shipment = ctx["device"], ctx["shipment"]
    headers = admin_headers(client)

    client.patch(f"/shipments/{shipment['id']}", json={"alert_rate_threshold_override": 1.0}, headers=headers)

    base = datetime.now(timezone.utc)
    resp = ingest_batch(
        client,
        device["mac_address"],
        shipment["id"],
        [_reading(_ts_ms(base), 5.0, roc=3.5)],
        device["provisioning_key"],
    )
    assert resp.status_code == 200
    assert resp.json()["alerts_created"] == 1

    alerts = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    assert any("rate-override" in a["message"] for a in alerts if a["type"] == "anomaly")


def test_rate_override_below_threshold_does_not_trigger(client):
    ctx = setup_device_truck_shipment(client, category="pasteurized_milk")
    device, shipment = ctx["device"], ctx["shipment"]
    headers = admin_headers(client)

    client.patch(f"/shipments/{shipment['id']}", json={"alert_rate_threshold_override": 5.0}, headers=headers)

    base = datetime.now(timezone.utc)
    resp = ingest_batch(
        client,
        device["mac_address"],
        shipment["id"],
        [_reading(_ts_ms(base), 5.0, roc=1.0)],
        device["provisioning_key"],
    )
    assert resp.status_code == 200
    assert resp.json()["alerts_created"] == 0

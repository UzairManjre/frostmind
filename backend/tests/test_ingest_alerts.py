"""/ingest's alert-generation logic: device-flagged-alert creation, the cooldown behavior (the
real bug fixed earlier -- a single batch with a long flagged/door-open stretch must create ONE
alert, not one per reading), and door-open-too-long alerts.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from helpers import admin_headers, frozen_time, ingest_batch, setup_device_truck_shipment


def _ts_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def test_device_flagged_alert_created_once_per_cooldown_window(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]
    base = datetime.now(timezone.utc)

    # 10 readings 2s apart (20s span total), every one device-flagged alert=true -- well inside
    # DEVICE_ALERT_COOLDOWN_SECONDS=60. This is exactly the shape that regressed before the
    # in-memory-cooldown fix (it produced ~10 alerts instead of 1).
    readings = [
        {
            "ts": _ts_ms(base + timedelta(seconds=2 * i)),
            "temp": 21.0,
            "hum": 55.0,
            "door": False,
            "roc": 4.0,
            "alert": True,
            "lat": None,
            "lng": None,
        }
        for i in range(10)
    ]
    with frozen_time(base):
        resp = ingest_batch(client, device["mac_address"], shipment["id"], readings, device["provisioning_key"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["anomalies_flagged"] == 10
    assert body["alerts_created"] == 1

    headers = admin_headers(client)
    alerts = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    anomaly_alerts = [a for a in alerts if a["type"] == "anomaly"]
    assert len(anomaly_alerts) == 1
    assert "device-rule" in anomaly_alerts[0]["message"]
    assert anomaly_alerts[0]["severity"] == "medium"

    # A reading well outside the cooldown window (70s after the last one) must produce a second,
    # independent alert -- proves the cooldown resets rather than permanently suppressing.
    later = base + timedelta(seconds=2 * 9 + 70)
    with frozen_time(later):
        resp2 = ingest_batch(
            client,
            device["mac_address"],
            shipment["id"],
            [
                {
                    "ts": _ts_ms(later),
                    "temp": 22.0,
                    "hum": 55.0,
                    "door": False,
                    "roc": 4.0,
                    "alert": True,
                    "lat": None,
                    "lng": None,
                }
            ],
            device["provisioning_key"],
        )
    assert resp2.status_code == 200
    assert resp2.json()["alerts_created"] == 1

    alerts_after = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    assert len([a for a in alerts_after if a["type"] == "anomaly"]) == 2


def test_door_open_too_long_alert_fires_once_past_threshold(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]
    base = datetime.now(timezone.utc)

    # Door held open continuously for 130s (DOOR_OPEN_ALERT_SECONDS=120), sampled every 2s (66
    # readings). Several trailing readings individually cross the 120s threshold, but
    # DOOR_ALERT_COOLDOWN_SECONDS=600 means only the first crossing creates an Alert.
    readings = [
        {
            "ts": _ts_ms(base + timedelta(seconds=2 * i)),
            "temp": 5.0,
            "hum": 55.0,
            "door": True,
            "roc": 0.1,
            "alert": False,
            "lat": None,
            "lng": None,
        }
        for i in range(66)
    ]
    resp = ingest_batch(client, device["mac_address"], shipment["id"], readings, device["provisioning_key"])
    assert resp.status_code == 200, resp.text

    headers = admin_headers(client)
    alerts = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    door_alerts = [a for a in alerts if a["type"] == "door-open-too-long"]
    assert len(door_alerts) == 1
    assert door_alerts[0]["severity"] == "high"
    # First reading to cross the 120s threshold is idx=60 (ts = base + 120s exactly).
    assert "120s" in door_alerts[0]["message"]


def test_normal_baseline_batch_produces_no_anomaly_or_door_alerts(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]
    base = datetime.now(timezone.utc)

    readings = [
        {
            "ts": _ts_ms(base + timedelta(seconds=2 * i)),
            "temp": 4.0 + 0.02 * i,
            "hum": 50.0,
            "door": False,
            "roc": 0.02,
            "alert": False,
            "lat": None,
            "lng": None,
        }
        for i in range(10)
    ]
    resp = ingest_batch(client, device["mac_address"], shipment["id"], readings, device["provisioning_key"])
    assert resp.status_code == 200
    body = resp.json()
    assert body["anomalies_flagged"] == 0
    assert body["alerts_created"] == 0

    headers = admin_headers(client)
    alerts = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    assert alerts == []

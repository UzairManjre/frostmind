"""Prototype-to-Production plan §2 A3: POST /ingest must require X-Device-Key matching the
device's stored provisioning_key. Every other field-facing endpoint stays open (unchanged,
untested here since that's the documented existing boundary, not new behavior).
"""
from __future__ import annotations

from helpers import ingest_batch, setup_device_truck_shipment


def _reading():
    return {
        "ts": 1_700_000_000_000,
        "temp": 4.0,
        "hum": 50.0,
        "door": False,
        "roc": None,
        "alert": False,
        "lat": None,
        "lng": None,
    }


def test_ingest_rejects_missing_device_key(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]

    resp = client.post(
        "/ingest",
        json={"device_mac": device["mac_address"], "shipment_id": shipment["id"], "readings": [_reading()]},
    )
    assert resp.status_code == 401


def test_ingest_rejects_wrong_device_key(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]

    resp = client.post(
        "/ingest",
        json={"device_mac": device["mac_address"], "shipment_id": shipment["id"], "readings": [_reading()]},
        headers={"X-Device-Key": "definitely-not-the-real-key"},
    )
    assert resp.status_code == 401


def test_ingest_accepts_correct_device_key(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]

    resp = ingest_batch(client, device["mac_address"], shipment["id"], [_reading()], device["provisioning_key"])
    assert resp.status_code == 200
    assert resp.json()["stored"] == 1


def test_ingest_rejects_correct_key_for_a_different_device(client):
    ctx1 = setup_device_truck_shipment(client, category="pasteurized_milk")
    from helpers import create_shipment, create_truck, register_device

    device1, shipment1 = ctx1["device"], ctx1["shipment"]
    device2 = register_device(client, mac="AA:BB:CC:DD:EE:99", name="Other device")

    resp = client.post(
        "/ingest",
        json={"device_mac": device1["mac_address"], "shipment_id": shipment1["id"], "readings": [_reading()]},
        headers={"X-Device-Key": device2["provisioning_key"]},
    )
    assert resp.status_code == 401

"""Shared test setup helpers -- register a device, wire it to a truck, start a shipment, log in
as admin. Plain functions (not fixtures) so each test can compose exactly the setup it needs.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from unittest.mock import patch

ADMIN_EMAIL = os.environ["FROSTMIND_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["FROSTMIND_ADMIN_PASSWORD"]


def admin_headers(client) -> dict:
    resp = client.post("/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def register_device(client, mac: str = "AA:BB:CC:DD:EE:01", name: str = "Test Device") -> dict:
    resp = client.post("/devices/register", json={"mac_address": mac, "serial": "SN-1", "name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


def create_truck(client, device_id: str, label: str = "Truck 1") -> dict:
    resp = client.post("/trucks", json={"label": label, "plate": "TEST-001", "device_id": device_id})
    assert resp.status_code == 201, resp.text
    return resp.json()


def create_shipment(
    client,
    truck_id: str,
    category: str = "pasteurized_milk",
    status: str = "in-transit",
    label: str = "Test shipment",
) -> dict:
    resp = client.post(
        "/shipments",
        json={"truck_id": truck_id, "category": category, "status": status, "label": label},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def setup_device_truck_shipment(client, category: str = "pasteurized_milk", **truck_kwargs) -> dict:
    """One-shot setup for the common case: a registered device, on a truck, running an
    in-transit shipment. Returns {"device": ..., "truck": ..., "shipment": ...}.
    """
    device = register_device(client)
    truck = create_truck(client, device["id"], **truck_kwargs)
    shipment = create_shipment(client, truck["id"], category=category)
    return {"device": device, "truck": truck, "shipment": shipment}


def reading(ts_ms: int, temp: float, hum: float = 50.0, door: bool | None = False, roc: float | None = None, alert: bool | None = False, lat: float | None = None, lng: float | None = None) -> dict:
    return {"ts": ts_ms, "temp": temp, "hum": hum, "door": door, "roc": roc, "alert": alert, "lat": lat, "lng": lng}


def ingest_batch(client, device_mac: str, shipment_id: str, readings: list[dict], device_key: str) -> "object":
    return client.post(
        "/ingest",
        json={"device_mac": device_mac, "shipment_id": shipment_id, "readings": readings},
        headers={"X-Device-Key": device_key},
    )


@contextmanager
def frozen_time(dt: datetime):
    """Patch /ingest's `datetime.now()` so a test can control the server's perceived receipt
    time directly. Needed because /ingest anchors every reading's stored `ts` to real arrival
    time (see app/routers/ingest.py's `received_at` -- the device's own `ts` is millis()-since-
    boot, not wall-clock, so it can no longer be used to fake "this reading is 10 days old" the
    way earlier tests assumed; that assumption matched a real bug that's since been fixed).
    `dt` must be timezone-aware (UTC), matching every `datetime.now(timezone.utc)` call site.
    """

    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return dt

    with patch("app.routers.ingest.datetime", _FrozenDatetime):
        yield

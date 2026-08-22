"""Model 3 (shelf life) gets correctly invoked from /ingest and updates the shipment's
shelf_life_consumed_fraction / shelf_life_remaining_hours -- cross-checked against
scripts/model3_shelf_life.py's own function (same code app/ml.py imports unmodified), not just
"some value came back."
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from model3_shelf_life import PRODUCT_LIBRARY, shelf_life_consumed_fraction  # noqa: E402

from helpers import admin_headers, ingest_batch, create_shipment, create_truck, register_device


def test_model3_invoked_and_updates_shipment_for_pasteurized_milk(client):
    device = register_device(client)
    truck = create_truck(client, device["id"])
    shipment = create_shipment(client, truck["id"], category="pasteurized_milk")
    assert shipment["shelf_life_consumed_fraction"] is None  # nothing ingested yet

    ref_time = datetime.fromisoformat(shipment["start_time"])
    # A 48h exposure history at 6C, sampled every 4h -- pasteurized_milk is rated at 4C, so this
    # is a real (mild) excursion that should consume a measurable, non-trivial fraction.
    ts_list = [ref_time + timedelta(hours=h) for h in range(0, 49, 4)]
    readings = [
        {
            "ts": int(t.timestamp() * 1000),
            "temp": 6.0,
            "hum": 60.0,
            "door": False,
            "roc": None,
            "alert": False,
            "lat": None,
            "lng": None,
        }
        for t in ts_list
    ]

    resp = ingest_batch(client, device["mac_address"], shipment["id"], readings, device["provisioning_key"])
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["shelf_life_consumed_fraction"] is not None
    assert 0.0 < body["shelf_life_consumed_fraction"] < 1.0
    assert body["shelf_life_remaining_hours"] is not None
    assert body["shelf_life_remaining_hours"] > 0

    # Cross-check against Model 3's own function directly, using the exact ref_time the backend
    # used (shipment.start_time), so this proves the *real* Arrhenius integration ran, not just
    # that some plausible-looking float came back.
    product = PRODUCT_LIBRARY["pasteurized_milk"]
    temps = [6.0] * len(ts_list)
    hours = [(t - ref_time).total_seconds() / 3600.0 for t in ts_list]
    expected = shelf_life_consumed_fraction(temps, hours, product)
    assert body["shelf_life_consumed_fraction"] == pytest.approx(expected, rel=1e-4)

    # The shipment row itself (not just the /ingest response) is updated.
    detail = client.get(f"/shipments/{shipment['id']}", headers=admin_headers(client))
    assert detail.status_code == 200
    assert detail.json()["shelf_life_consumed_fraction"] == pytest.approx(body["shelf_life_consumed_fraction"])
    assert detail.json()["shelf_life_updated_at"] is not None


def test_shelf_life_stays_null_before_any_ingest(client):
    device = register_device(client, mac="AA:BB:CC:DD:EE:03")
    truck = create_truck(client, device["id"])
    shipment = create_shipment(client, truck["id"], category="frozen_food_generic")
    assert shipment["shelf_life_consumed_fraction"] is None
    assert shipment["shelf_life_remaining_hours"] is None

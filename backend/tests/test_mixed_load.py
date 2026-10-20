"""Mixed-load shipments end to end: Model 5 decides whether the products can share one
compartment, Model 4 sets the setpoint, /ingest tracks shelf life per product and flags drift
from the recommended setpoint, and the phone's device-key-authorised /live view exposes all of it
(plus the LLM explanations). Also covers GET /ai/status.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from helpers import admin_headers, create_truck, ingest_batch, reading, register_device


def _ts_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _device_truck(client, mac="AA:BB:CC:DD:EE:10"):
    device = register_device(client, mac=mac)
    truck = create_truck(client, device["id"])
    return device, truck


def _mixed(client, truck_id, products):
    return client.post(
        "/shipments",
        json={"truck_id": truck_id, "status": "in-transit", "label": "mixed", "products": [{"product_id": p, "quantity_kg": q} for p, q in products]},
    )


def test_compatible_products_make_one_mixed_shipment(client):
    _, truck = _device_truck(client)
    resp = _mixed(client, truck["id"], [("apples", 300), ("pears", 100), ("grapes", 50)])
    assert resp.status_code == 201, resp.text
    s = resp.json()
    assert [p["product_id"] for p in s["products"]] == ["apples", "pears", "grapes"]
    assert -1.5 <= s["recommended_setpoint_c"] <= 1.5
    assert s["setpoint_method"] in ("ml", "physics", "physics_fallback")
    assert s["category"] == "fresh_produce_generic"  # heaviest product's category, not the device preset
    assert s["device_category"] in ("seafood_fresh_chilled", "meat_poultry_chilled")


def test_incompatible_products_are_rejected_with_reasons(client):
    _, truck = _device_truck(client)
    resp = _mixed(client, truck["id"], [("lettuce", 100), ("bananas_ripe", 100)])
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert len(detail["groups"]) == 2
    assert detail["clashes"] and detail["clashes"][0]["why"]


def test_shipment_needs_category_or_products(client):
    _, truck = _device_truck(client)
    resp = client.post("/shipments", json={"truck_id": truck["id"]})
    assert resp.status_code == 422


def test_ingest_tracks_shelf_life_per_product_and_flags_setpoint_drift(client):
    device, truck = _device_truck(client)
    s = _mixed(client, truck["id"], [("lettuce", 100), ("spinach", 40)]).json()
    base = datetime.now(timezone.utc)
    readings = [reading(_ts_ms(base + timedelta(minutes=10 * i)), temp=9.0) for i in range(6)]  # ~9 C vs ~0 C setpoint
    resp = ingest_batch(client, device["mac_address"], s["id"], readings, device["provisioning_key"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["alerts_created"] >= 1

    live = client.get(f"/shipments/{s['id']}/live", headers={"X-Device-Key": device["provisioning_key"]})
    assert live.status_code == 200, live.text
    body = live.json()
    per = {p["product_id"]: p for p in body["shipment"]["product_shelf_life"]}
    assert set(per) == {"lettuce", "spinach"}
    assert all(p["consumed_fraction"] > 0 for p in per.values())
    # the shipment-level number is the most perishable product's
    assert body["shipment"]["shelf_life_consumed_fraction"] == max(p["consumed_fraction"] for p in per.values())
    assert any("recommended-setpoint" in a["message"] for a in body["alerts"])
    assert body["latest_reading"]["temp_c"] == 9.0
    assert body["ai"]["model5_compatibility"]


def test_live_view_requires_the_trucks_device_key(client):
    device, truck = _device_truck(client)
    s = _mixed(client, truck["id"], [("apples", 10)]).json()
    assert client.get(f"/shipments/{s['id']}/live").status_code == 401
    assert client.get(f"/shipments/{s['id']}/live", headers={"X-Device-Key": "wrong"}).status_code == 401
    other = register_device(client, mac="AA:BB:CC:DD:EE:99", name="Other")
    assert client.get(f"/shipments/{s['id']}/live", headers={"X-Device-Key": other["provisioning_key"]}).status_code == 401


def test_classic_single_category_shipment_still_works(client):
    _, truck = _device_truck(client)
    resp = client.post("/shipments", json={"truck_id": truck["id"], "category": "vaccine_generic"})
    assert resp.status_code == 201
    assert resp.json()["products"] is None and resp.json()["device_category"] == "vaccine_generic"


def test_ai_status_lists_every_component(client):
    resp = client.get("/ai/status")
    assert resp.status_code == 200
    keys = [c["key"] for c in resp.json()["components"]]
    assert keys == ["model0", "model1", "model3", "model4", "model5", "llm"]
    m5 = next(c for c in resp.json()["components"] if c["key"] == "model5")
    assert m5["metrics"]["ROC-AUC on unseen products"] is not None


def test_llm_test_endpoint_requires_admin_and_reports_failure_honestly(client):
    assert client.post("/ai/llm/test").status_code == 401
    resp = client.post("/ai/llm/test", headers=admin_headers(client))
    assert resp.status_code == 200
    assert resp.json()["ok"] is False  # tests run with Ollama mocked as unreachable

"""/products and /planner/plan -- the Load Planner that serves Model 4 (mixed-load setpoint) and
Model 5 (co-shipment compatibility). Checks the answers make postharvest sense, not just that
something came back, and that the planner degrades to physics/rules when the pkls are missing.
"""
from __future__ import annotations

import pytest

from app import load_planner
from helpers import admin_headers, create_truck, register_device


def _plan(client, *pids, **extra):
    body = {"products": [{"product_id": p, "quantity_kg": 100} for p in pids], **extra}
    resp = client.post("/planner/plan", json=body, headers=admin_headers(client))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _group_of(plan, pid):
    return next(g for g in plan["groups"] if any(p["product_id"] == pid for p in g["products"]))


def test_plan_is_public_for_the_phone_app(client):
    # The phone wizard has no admin login; the plan is a pure calculation over the public catalog.
    resp = client.post("/planner/plan", json={"products": [{"product_id": "apples"}]})
    assert resp.status_code == 200


def test_products_lists_the_catalog(client):
    resp = client.get("/products")
    assert resp.status_code == 200
    ids = {p["product_id"] for p in resp.json()}
    assert {"apples", "lettuce", "milk_pasteurized", "vaccines_refrigerated", "frozen_vegetables"} <= ids
    assert len(ids) >= 150


def test_health_reports_planner_model_status(client):
    body = client.get("/health").json()
    assert "model4_status" in body and "model5_status" in body


def test_apples_and_pears_share_one_cold_group(client):
    plan = _plan(client, "apples", "pears")
    assert len(plan["groups"]) == 1
    g = plan["groups"][0]
    assert g["feasible"] and -1.5 <= g["recommended_setpoint_c"] <= 1.5
    assert plan["pairs"][0]["compatible"] is True


def test_bananas_and_lettuce_are_split(client):
    plan = _plan(client, "bananas_ripe", "lettuce")
    assert len(plan["groups"]) == 2
    assert plan["pairs"][0]["compatible"] is False
    assert _group_of(plan, "bananas_ripe")["recommended_setpoint_c"] >= 12
    assert _group_of(plan, "lettuce")["recommended_setpoint_c"] <= 2


def test_ethylene_reason_is_explained(client):
    plan = _plan(client, "apples", "kiwi_unripe")
    assert "Ethylene" in " ".join(plan["pairs"][0]["reasons"])


def test_vaccines_never_ride_with_food(client):
    plan = _plan(client, "vaccines_refrigerated", "poultry_fresh")
    pair = plan["pairs"][0]
    assert pair["compatible"] is False and pair["vetoes"]
    vac = _group_of(plan, "vaccines_refrigerated")
    assert vac["recommended_setpoint_c"] == pytest.approx(5.0, abs=0.1)
    assert vac["device_category"] == "vaccine_generic" and vac["device_category_within_1c"]


def test_warm_compartment_is_not_mapped_to_a_cold_device_category(client):
    plan = _plan(client, "bananas_ripe")
    g = plan["groups"][0]
    assert g["device_category_within_1c"] is False
    assert any("no matching FROSTMIND device category" in w for w in plan["warnings"])


def test_frozen_and_chilled_are_split(client):
    plan = _plan(client, "frozen_vegetables", "milk_pasteurized")
    assert len(plan["groups"]) == 2
    assert _group_of(plan, "frozen_vegetables")["recommended_setpoint_c"] <= -18


def test_setpoints_sit_inside_their_safe_range(client):
    plan = _plan(client, "apples", "lettuce", "bananas_ripe", "milk_pasteurized", "vaccines_refrigerated", "ice_cream", sigma_c=0.6)
    assert plan["sigma_c"] == 0.6 and plan["sigma_source"] == "request"
    for g in plan["groups"]:
        assert g["feasible"]
        lo, hi = g["safe_range_c"]
        sp = g["recommended_setpoint_c"]
        assert (lo is None or sp >= lo - 1e-6) and (hi is None or sp <= hi + 1e-6)


def test_unknown_product_is_422(client):
    resp = client.post("/planner/plan", json={"products": [{"product_id": "unobtainium"}]}, headers=admin_headers(client))
    assert resp.status_code == 422


def test_truck_without_readings_falls_back_to_default_sigma(client):
    device = register_device(client)
    truck = create_truck(client, device["id"])
    plan = _plan(client, "apples", truck_id=truck["id"])
    assert plan["sigma_source"].startswith("default")
    assert plan["sigma_c"] == pytest.approx(load_planner.DEFAULT_SIGMA_C)


def test_without_pkls_planner_uses_physics_and_rules(client, monkeypatch):
    monkeypatch.setattr(load_planner, "_model4", None)
    monkeypatch.setattr(load_planner, "_model5", None)
    monkeypatch.setattr(load_planner, "MODEL4_ACTIVE", False)
    monkeypatch.setattr(load_planner, "MODEL5_ACTIVE", False)
    plan = _plan(client, "apples", "pears", "bananas_ripe")
    assert plan["model4_active"] is False and plan["model5_active"] is False
    assert all(g["method"] == "physics" for g in plan["groups"])
    assert all(p["probability"] is None for p in plan["pairs"])
    # the tropical fruit still never shares a compartment with the cold-stored fruit
    assert [p["product_id"] for p in _group_of(plan, "bananas_ripe")["products"]] == ["bananas_ripe"]

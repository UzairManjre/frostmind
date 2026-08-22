"""app/llm_orchestrator.py -- mocks the Ollama HTTP call throughout (no real local model
required to run this suite; CI/anyone without Ollama pulled can still run it). Per the plan's own
§7 guidance, the parse-fallback path is tested explicitly since it's the most likely real failure
mode in practice (a local model not perfectly following `format:"json"`), not just the timeout/
unreachable paths that are easier to imagine but less likely to actually happen.
"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from app.llm_orchestrator import assess_alert, generate_compliance_report
from helpers import admin_headers, ingest_batch, reading, setup_device_truck_shipment


def _mock_ollama_client(*, content: str | None = None, raise_exc: Exception | None = None):
    """Patches app.llm_orchestrator.httpx.AsyncClient so `async with AsyncClient(...) as c:
    await c.post(...)` returns a response whose `.json()` gives back an Ollama-chat-shaped body
    with `content` as the assistant message, or raises `raise_exc` from the post() call itself
    (simulating unreachable/timeout at the transport level).
    """
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    if raise_exc is not None:
        mock_client.post = AsyncMock(side_effect=raise_exc)
    else:
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"message": {"role": "assistant", "content": content}})
        mock_client.post = AsyncMock(return_value=mock_resp)

    return patch("app.llm_orchestrator.httpx.AsyncClient", return_value=mock_client)


class _FakeAlert:
    type = MagicMock(value="anomaly")
    severity = MagicMock(value="medium")
    message = "Anomaly alert [device-rule]"


class _FakeShipment:
    category = MagicMock(value="pasteurized_milk")
    status = MagicMock(value="in-transit")
    start_time = None
    end_time = None
    shelf_life_consumed_fraction = 0.5
    shelf_life_remaining_hours = 12.0


def test_assess_alert_returns_parsed_dict_on_well_formed_response():
    good = json.dumps(
        {
            "assessment": "Temperature spiked well above the rated range.",
            "recommended_action": "Inspect the unit and check the door seal.",
            "narrative": "This is the first excursion this trip; stored severity looks appropriate.",
        }
    )
    with _mock_ollama_client(content=good):
        result = asyncio.run(assess_alert(_FakeAlert(), _FakeShipment(), recent_readings=[], alert_history=[]))
    assert result is not None
    assert result["assessment"].startswith("Temperature spiked")
    assert "seal" in result["recommended_action"]
    assert "severity" in result["narrative"]


def test_assess_alert_returns_none_on_malformed_json():
    # The realistic failure mode per the plan's §7 note: format:"json" isn't a hard guarantee,
    # a local model can still emit prose or truncated/invalid JSON.
    with _mock_ollama_client(content="Sure, here's my analysis: the temperature is high."):
        result = asyncio.run(assess_alert(_FakeAlert(), _FakeShipment(), recent_readings=[], alert_history=[]))
    assert result is None


def test_assess_alert_returns_none_on_missing_keys():
    incomplete = json.dumps({"assessment": "Something happened."})  # missing recommended_action/narrative
    with _mock_ollama_client(content=incomplete):
        result = asyncio.run(assess_alert(_FakeAlert(), _FakeShipment(), recent_readings=[], alert_history=[]))
    assert result is None


def test_assess_alert_returns_none_on_timeout():
    with _mock_ollama_client(raise_exc=httpx.TimeoutException("timed out")):
        result = asyncio.run(assess_alert(_FakeAlert(), _FakeShipment(), recent_readings=[], alert_history=[]))
    assert result is None


def test_assess_alert_returns_none_when_unreachable():
    with _mock_ollama_client(raise_exc=httpx.ConnectError("connection refused")):
        result = asyncio.run(assess_alert(_FakeAlert(), _FakeShipment(), recent_readings=[], alert_history=[]))
    assert result is None


def test_compliance_report_returns_text_on_success():
    with _mock_ollama_client(content="The shipment remained within range for the duration of transit."):
        result = asyncio.run(generate_compliance_report(_FakeShipment(), readings=[], alerts=[]))
    assert result == "The shipment remained within range for the duration of transit."


def test_compliance_report_returns_none_on_empty_response():
    with _mock_ollama_client(content="   "):
        result = asyncio.run(generate_compliance_report(_FakeShipment(), readings=[], alerts=[]))
    assert result is None


def test_ingest_alert_survives_llm_failure_end_to_end(client):
    """The pipeline-never-breaks contract, exercised through the real /ingest endpoint (not just
    the orchestrator in isolation). TestClient runs BackgroundTasks synchronously, so this
    actually exercises run_alert_reasoning_background -- with Ollama mocked to fail, the Alert
    row must still exist with the deterministic fields intact and llm_* columns simply null,
    never a 500 or a missing alert.
    """
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]

    with _mock_ollama_client(raise_exc=httpx.ConnectError("connection refused")):
        resp = ingest_batch(
            client,
            device["mac_address"],
            shipment["id"],
            [reading(1000, temp=25.0, alert=True)],
            device["provisioning_key"],
        )
    assert resp.status_code == 200
    assert resp.json()["alerts_created"] == 1

    headers = admin_headers(client)
    alerts = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    assert len(alerts) == 1
    assert alerts[0]["message"]  # deterministic fields intact
    assert alerts[0]["llm_assessment"] is None
    assert alerts[0]["llm_recommended_action"] is None
    assert alerts[0]["llm_narrative"] is None


def test_ingest_alert_gets_llm_fields_populated_when_ollama_succeeds(client):
    ctx = setup_device_truck_shipment(client)
    device, shipment = ctx["device"], ctx["shipment"]

    good = json.dumps(
        {
            "assessment": "Reading is well outside the safe range for this category.",
            "recommended_action": "Check the refrigeration unit immediately.",
            "narrative": "Consistent with the stored medium severity given this is an isolated reading.",
        }
    )
    with _mock_ollama_client(content=good):
        resp = ingest_batch(
            client,
            device["mac_address"],
            shipment["id"],
            [reading(1000, temp=25.0, alert=True)],
            device["provisioning_key"],
        )
    assert resp.status_code == 200

    headers = admin_headers(client)
    alerts = client.get(f"/shipments/{shipment['id']}/alerts", headers=headers).json()
    assert len(alerts) == 1
    assert "safe range" in alerts[0]["llm_assessment"]
    assert "refrigeration" in alerts[0]["llm_recommended_action"]
    assert "medium severity" in alerts[0]["llm_narrative"]


def test_compliance_report_endpoint_requires_admin_auth(client):
    ctx = setup_device_truck_shipment(client)
    resp = client.post(f"/shipments/{ctx['shipment']['id']}/compliance_report")
    assert resp.status_code == 401


def test_compliance_report_endpoint_returns_narrative(client):
    ctx = setup_device_truck_shipment(client)
    headers = admin_headers(client)
    with _mock_ollama_client(content="No excursions were recorded during this shipment."):
        resp = client.post(f"/shipments/{ctx['shipment']['id']}/compliance_report", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["shipment_id"] == ctx["shipment"]["id"]
    assert body["narrative"] == "No excursions were recorded during this shipment."


def test_compliance_report_endpoint_returns_null_narrative_on_llm_failure(client):
    ctx = setup_device_truck_shipment(client)
    headers = admin_headers(client)
    with _mock_ollama_client(raise_exc=httpx.ConnectError("connection refused")):
        resp = client.post(f"/shipments/{ctx['shipment']['id']}/compliance_report", headers=headers)
    assert resp.status_code == 200  # failure is a null narrative, not an HTTP error
    assert resp.json()["narrative"] is None

"""LLM orchestration -- local Ollama, two roles, neither of which replaces Models 1-3 or touches
actuation. See `FROSTMIND_LLM_Orchestration_Plan.md` for the full design; this module is that
plan's §2/§4 implementation.

**What this is for:** synthesizing the structured outputs Models 1-3 and the alert pipeline
already produce into a human-readable decision and explanation -- something a threshold rule
can't do. It is a bad tool for the precise numerical time-series reasoning those models already
do correctly, and it doesn't attempt any of that here.

**Role A -- alert reasoning.** Triggered from app/routers/ingest.py as a FastAPI BackgroundTask
the moment an Alert row is created (never awaited inline -- local inference takes real seconds,
and the ESP32 waiting on /ingest's response must not be blocked on it). Gathers the alert, Model
3's current shelf-life output, the shipment's category, recent readings, and recent alert
history; asks Ollama for a structured assessment; writes it onto the Alert row's
llm_assessment/llm_recommended_action/llm_narrative columns.

**Role B -- compliance report.** Same Ollama integration, a "generate report" action instead --
assembles a shipment's full history into a formatted incident narrative. See
generate_compliance_report() / app/routers/shipments.py's report endpoint.

**The one hard boundary:** neither role ever fires an IR command or touches Device/Shipment
control state. LLM output is read-only explanation/recommendation surfaced to a human in the
admin panel. The deterministic path (the ESP32's on-device threshold rule today, Model 1 once
it's live) stays the only thing that can trigger a physical action -- an LLM is materially less
predictable than a validated threshold or a trained classifier, and a bad demo answer in the UI
is a completely different failure class from the wrong physical command firing.

**Reliability contract, load-bearing:** every public function here returns `None` (Role A) or
raises nothing visible to the caller on any failure -- Ollama unreachable, timeout, malformed
JSON, model returns prose instead of the requested schema. A malformed/absent LLM response must
never break the alert pipeline; the deterministic alert data (type/severity/message) already
written by app/routers/ingest.py stands on its own with or without an LLM narrative layered on
top. Every failure path is logged (structured, via app/logging_config) so a real outage is
diagnosable, never silent to an operator, even though it's silent to the pipeline.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import httpx

from app.config import OLLAMA_MODEL, OLLAMA_TIMEOUT_SECONDS, OLLAMA_URL
from app.logging_config import get_logger, log_event

_logger = get_logger("frostmind.llm")

ALERT_SYSTEM_PROMPT = """You are a cold-chain logistics assistant helping a human operator decide what to do about an alert from a refrigerated shipment monitor. You are given the alert, the shipment's product category and shelf-life state (already computed by a real kinetic model -- trust those numbers, do not recompute or second-guess them), and recent sensor history.

Respond with ONLY a JSON object, no other text, with exactly these keys:
  "assessment": one or two sentences, what actually happened and why it matters for this specific product.
  "recommended_action": one or two sentences, what a human operator should concretely do right now.
  "narrative": a short paragraph (2-4 sentences) giving the fuller picture -- how this fits the recent history, your own read on how serious it actually is (state it explicitly, e.g. "this is more/less serious than the stored severity suggests because...", or confirm the stored severity looks right), and anything else a human reviewing this later would want to know.

You do not control any physical device. Nothing you say triggers an action automatically -- a human reads this and decides. Be concrete and specific to the numbers given, not generic advice."""

COMPLIANCE_SYSTEM_PROMPT = """You are a cold-chain logistics assistant writing a compliance incident report for a completed or in-progress shipment, for a human reviewer (regulatory/audit context). You are given the shipment's category, its full alert history, and summary temperature/door statistics already computed by the system (trust these numbers).

Write a clear, factual incident narrative in plain prose (not JSON, not bullet points) covering: what happened over the course of the shipment, in chronological order; which excursions/alerts occurred and their real-world significance for this product category; and an overall conclusion about the shipment's integrity. Be factual and specific to the numbers given -- this is a record that may be read by someone who was not present, not a sales narrative. If nothing notable happened, say so plainly rather than manufacturing concern."""


def _build_alert_prompt(alert, shipment, shelf_life_consumed, shelf_life_remaining_hours, recent_readings, alert_history) -> str:
    lines = [
        f"Alert type: {alert.type.value}, stored severity: {alert.severity.value}",
        f"Alert message: {alert.message}",
        f"Shipment category: {shipment.category.value}",
        f"Shelf life consumed: {shelf_life_consumed * 100:.1f}%" if shelf_life_consumed is not None else "Shelf life consumed: not yet computed",
        f"Shelf life remaining: {shelf_life_remaining_hours:.1f} hours" if shelf_life_remaining_hours is not None else "Shelf life remaining: not yet computed",
        "",
        "Recent readings (oldest to newest):",
    ]
    for r in recent_readings:
        lines.append(f"  temp={r.temp_c}C hum={r.humidity} door={'open' if r.door_open else 'closed'} device_flagged={r.device_reported_alert}")
    lines.append("")
    lines.append(f"Recent alert history for this shipment ({len(alert_history)} prior alerts):")
    for a in alert_history:
        lines.append(f"  {a.type.value} ({a.severity.value}): {a.message}")
    return "\n".join(lines)


def _build_compliance_prompt(shipment, readings, alerts) -> str:
    temps = [r.temp_c for r in readings if r.temp_c is not None]
    lines = [
        f"Shipment category: {shipment.category.value}",
        f"Status: {shipment.status.value}",
        f"Start time: {shipment.start_time.isoformat() if shipment.start_time else 'not started'}",
        f"End time: {shipment.end_time.isoformat() if shipment.end_time else 'not ended'}",
        f"Total readings logged: {len(readings)}",
        f"Temperature range observed: {min(temps):.1f}C to {max(temps):.1f}C" if temps else "Temperature range observed: no readings",
        f"Shelf life consumed at last update: {shipment.shelf_life_consumed_fraction * 100:.1f}%" if shipment.shelf_life_consumed_fraction is not None else "Shelf life consumed: not computed",
        "",
        f"Full alert history ({len(alerts)} alerts, chronological):",
    ]
    for a in alerts:
        lines.append(f"  [{a.ts.isoformat()}] {a.type.value} ({a.severity.value}): {a.message}")
    if not alerts:
        lines.append("  (none)")
    return "\n".join(lines)


async def _call_ollama(system_prompt: str, user_prompt: str, want_json: bool) -> dict | str | None:
    """Shared low-level call. Returns the parsed JSON dict (want_json=True), the raw text
    (want_json=False), or None on ANY failure -- unreachable, timeout, non-2xx, malformed JSON
    when JSON was requested. Every None path is logged with enough detail to diagnose a real
    outage; callers never need to log the failure themselves, just handle None.
    """
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
    }
    if want_json:
        payload["format"] = "json"

    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_SECONDS) as client:
            resp = await client.post(OLLAMA_URL, json=payload)
            resp.raise_for_status()
            body = resp.json()
    except httpx.TimeoutException:
        log_event(_logger, logging.WARNING, "llm_call_timeout", model=OLLAMA_MODEL, timeout_s=OLLAMA_TIMEOUT_SECONDS)
        return None
    except Exception as exc:  # noqa: BLE001 - deliberately broad, see module docstring's reliability contract
        log_event(_logger, logging.WARNING, "llm_call_failed", model=OLLAMA_MODEL, error=str(exc))
        return None

    content = body.get("message", {}).get("content", "")
    if not want_json:
        return content

    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        # Local models occasionally don't perfectly follow the schema even with format:"json" --
        # log the raw content so this is diagnosable, then fall back same as any other failure.
        log_event(_logger, logging.WARNING, "llm_response_not_json", model=OLLAMA_MODEL, error=str(exc), raw=content[:500])
        return None


async def assess_alert(alert, shipment, recent_readings, alert_history) -> dict | None:
    """Role A. Returns {"assessment": str, "recommended_action": str, "severity_opinion": str}
    or None on any failure (see module docstring's reliability contract) -- caller
    (app/routers/ingest.py's background task) must handle None by simply not writing the
    llm_* columns, leaving the deterministic alert data as the complete record.
    """
    prompt = _build_alert_prompt(
        alert,
        shipment,
        shipment.shelf_life_consumed_fraction,
        shipment.shelf_life_remaining_hours,
        recent_readings,
        alert_history,
    )
    result = await _call_ollama(ALERT_SYSTEM_PROMPT, prompt, want_json=True)
    if not isinstance(result, dict):
        return None
    if not all(k in result for k in ("assessment", "recommended_action", "narrative")):
        log_event(_logger, logging.WARNING, "llm_response_missing_keys", model=OLLAMA_MODEL, keys=list(result.keys()))
        return None
    return result


async def generate_compliance_report(shipment, readings, alerts) -> str | None:
    """Role B. Returns the narrative as plain text, or None on any failure -- caller
    (the compliance-report endpoint) must handle None by telling the admin the report couldn't
    be generated right now (e.g. Ollama unreachable), never by fabricating a narrative.
    """
    prompt = _build_compliance_prompt(shipment, readings, alerts)
    result = await _call_ollama(COMPLIANCE_SYSTEM_PROMPT, prompt, want_json=False)
    if not result or not result.strip():
        return None
    return result.strip()


RECENT_READINGS_FOR_CONTEXT = 10
RECENT_ALERTS_FOR_CONTEXT = 5


async def run_alert_reasoning_background(alert_id: str) -> None:
    """The actual FastAPI BackgroundTask target -- app/routers/ingest.py calls
    `background_tasks.add_task(run_alert_reasoning_background, alert.id)` once per newly-created
    Alert, after its own db.commit() (so the Alert row has a real id and is actually persisted
    before this runs -- background tasks execute after the response is sent, well after the
    request-scoped session from Depends(get_db) has already been closed, so this opens its own
    short-lived session rather than reusing anything from the request).

    Deliberately takes just an id, not the ORM objects themselves -- those are bound to the
    request's now-closed session and touching them here would raise DetachedInstanceError.
    """
    from app.database import SessionLocal  # local import: avoids a circular import with database.py at module load
    from app.models import Alert, SensorReading

    db = SessionLocal()
    try:
        alert = db.get(Alert, alert_id)
        if alert is None:  # pragma: no cover - defensive, shouldn't happen given the commit-then-enqueue order
            return
        shipment = alert.shipment

        recent_readings = (
            db.query(SensorReading)
            .filter(SensorReading.shipment_id == shipment.id)
            .order_by(SensorReading.ts.desc())
            .limit(RECENT_READINGS_FOR_CONTEXT)
            .all()
        )
        recent_readings.reverse()  # oldest-to-newest, matches _build_alert_prompt's expectation

        alert_history = (
            db.query(Alert)
            .filter(Alert.shipment_id == shipment.id, Alert.id != alert.id)
            .order_by(Alert.ts.desc())
            .limit(RECENT_ALERTS_FOR_CONTEXT)
            .all()
        )

        result = await assess_alert(alert, shipment, recent_readings, alert_history)
        if result is None:
            return  # already logged inside _call_ollama/assess_alert; alert stands on its own
        alert.llm_assessment = result.get("assessment")
        alert.llm_recommended_action = result.get("recommended_action")
        alert.llm_narrative = result.get("narrative")
        db.commit()
        log_event(_logger, logging.INFO, "llm_alert_reasoning_stored", alert_id=alert_id)
    finally:
        db.close()

"""AI status + verification -- one place to see (and prove) which AI components are actually live.

GET  /ai/status     every AI component: what it does, live status, its measured scores (read from
                    the models/*_metrics.json files the training scripts wrote) and live usage
                    counts from the database. Public, read-only, like /health.
POST /ai/llm/test   admin-JWT: sends a tiny prompt to the local LLM and returns the reply, model
                    and latency -- a one-click check that the explanation layer really works.
"""
from __future__ import annotations

import json
import time
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import load_planner
from app.auth import CurrentUser
from app.config import MODELS_DIR
from app.database import get_db
from app.llm_orchestrator import _call_ollama, llm_status
from app.ml import MODEL1_ACTIVE, PRODUCT_LIBRARY
from app.models import Alert, Shipment

router = APIRouter(prefix="/ai", tags=["ai"])


def _metrics(name: str) -> dict:
    path = MODELS_DIR / f"{name}_metrics.json"
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001 - a missing metrics file just means "no scores to show"
        return {}


def _mean(block: dict, key: str):
    v = block.get(key)
    return v.get("mean") if isinstance(v, dict) else v


@router.get("/status")
def ai_status(db: Annotated[Session, Depends(get_db)]):
    total_alerts = db.query(Alert).count()
    explained = db.query(Alert).filter(Alert.llm_assessment.isnot(None)).count()
    with_shelf = db.query(Shipment).filter(Shipment.shelf_life_consumed_fraction.isnot(None)).count()
    mixed = db.query(Shipment).filter(Shipment.products.isnot(None)).count()

    m1 = _metrics("model1_random_forest_shipment_supervised")
    m1_milk = _metrics("model1_isolation_forest_milk")
    m4 = _metrics("model4_mixed_setpoint")
    m4_test = (m4.get("product_disjoint_test") or {}).get(m4.get("model", ""), {})
    m4_base = (m4.get("product_disjoint_test") or {}).get("baseline_range_midpoint", {})
    m5 = _metrics("model5_compatibility")
    m5_test = (m5.get("cold_start_test") or {}).get(m5.get("model", ""), {})
    m5_rule = (m5.get("cold_start_test") or {}).get("rule_topt_within_2c", {})
    llm = llm_status(live=True)

    components = [
        {
            "key": "model0",
            "name": "Model 0 -- On-device threshold rule",
            "kind": "Deterministic rule (ESP32 firmware)",
            "status": "live",
            "what": "Flags fast temperature change, drift from the setpoint, or a door open too long, every ~2 s, and fires the paired AC IR command.",
            "where": "ESP32 firmware -> 'alert' flag in every reading -> anomaly alerts",
            "metrics": {},
            "usage": {},
        },
        {
            "key": "model1",
            "name": "Model 1 -- Anomaly detector",
            "kind": "Isolation Forest / Random Forest (scikit-learn)",
            "status": "live" if MODEL1_ACTIVE else "inactive",
            "what": "Scores each reading for unusual temperature behaviour.",
            "where": "/ingest (scores every reading once models/model1_isolation_forest_frostmind.pkl exists)",
            "note": None if MODEL1_ACTIVE else "Validated offline on 4 datasets; switched off for live data until it is retrained on FROSTMIND's own labelled logs (wrong temperature domain otherwise).",
            "metrics": {
                "supervised RF ROC-AUC (shipment data)": m1.get("roc_auc"),
                "supervised RF accuracy": m1.get("accuracy"),
                "Isolation Forest ROC-AUC (real milk data)": m1_milk.get("roc_auc"),
            },
            "usage": {},
        },
        {
            "key": "model3",
            "name": "Model 3 -- Shelf-life estimator",
            "kind": "Arrhenius kinetics (physics model)",
            "status": "live",
            "what": "Integrates the shipment's whole temperature history into % of shelf life used and hours left; per product for mixed loads.",
            "where": "/ingest on every batch -> fleet table, shipment page, phone dashboard, shelf-life alerts",
            "metrics": {"product categories": len(PRODUCT_LIBRARY), "catalog products (per-product shelf life)": len(load_planner.CATALOG)},
            "usage": {"shipments with live shelf life": with_shelf},
        },
        {
            "key": "model4",
            "name": "Model 4 -- Mixed-load setpoint",
            "kind": "Gradient boosting (ML) guarded by a physics optimizer",
            "status": "live" if load_planner.MODEL4_ACTIVE else "physics-only",
            "what": "Recommends one reefer temperature for several products at once, allowing for the truck's real temperature wobble.",
            "where": "Load Planner (admin + phone), POST /shipments with products, setpoint-deviation alerts",
            "metrics": {
                "MAE on unseen products (C)": m4_test.get("mae_c"),
                "within +/-0.5 C of optimum (%)": m4_test.get("within_0_5c_pct"),
                "R2": m4_test.get("r2"),
                "simple-rule baseline MAE (C)": m4_base.get("mae_c"),
            },
            "usage": {"mixed-load shipments": mixed},
        },
        {
            "key": "model5",
            "name": "Model 5 -- Co-shipment compatibility",
            "kind": "Random forest (ML) + regulatory vetoes",
            "status": "live" if load_planner.MODEL5_ACTIVE else "rules-only",
            "what": "Decides which products can share a compartment (ethylene, chilling, temperature, humidity) and explains why not.",
            "where": "Load Planner (admin + phone), POST /shipments with products (rejects incompatible mixes)",
            "metrics": {
                "ROC-AUC on unseen products": _mean(m5_test, "roc_auc"),
                "accuracy": _mean(m5_test, "accuracy"),
                "MCC": _mean(m5_test, "mcc"),
                "best hand-written rule ROC-AUC": _mean(m5_rule, "roc_auc"),
            },
            "usage": {"catalog products": len(load_planner.CATALOG)},
        },
        {
            "key": "llm",
            "name": "LLM -- Alert explanations & compliance reports",
            "kind": "Local LLM via Ollama (no cloud)",
            "status": "live" if llm.get("reachable") and llm.get("model") else "unavailable",
            "what": "Writes a plain-English assessment + recommended action for every alert, and a compliance report on request. Never controls anything.",
            "where": "Background task after each alert -> Alerts page, shipment page, phone dashboard; 'Generate report' on the shipment page",
            "note": None if llm.get("reachable") else "Start Ollama (ollama serve) and pull an instruction model, e.g. `ollama pull gemma3`.",
            "metrics": {"model in use": llm.get("model"), "configured model": llm.get("configured_model")},
            "usage": {"alerts": total_alerts, "alerts with an AI explanation": explained},
        },
    ]
    return {"components": components, "llm": llm}


@router.post("/llm/test")
async def llm_test(current_user: CurrentUser):
    started = time.monotonic()
    reply = await _call_ollama(
        "You are the FROSTMIND cold-chain assistant. Answer in one short sentence.",
        "A vaccine shipment rated 2-8 C read 11 C for 20 minutes. What should the operator do first?",
        want_json=False,
    )
    latency_ms = int((time.monotonic() - started) * 1000)
    status = llm_status(live=False)
    return {"ok": bool(reply), "model": status.get("model"), "latency_ms": latency_ms, "reply": (reply or "").strip()[:600] or None}

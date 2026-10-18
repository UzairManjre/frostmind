"""Load Planner: serves Model 4 (mixed-load setpoint) and Model 5 (co-shipment compatibility).

All feature engineering, physics and grouping come from scripts/common/products.py (the same
module the training scripts use), imported via SCRIPTS_DIR exactly like app/ml.py imports
model3_shelf_life -- so live scoring can't drift from what the models were trained on.

Loading follows app/ml.py's _load_model1() pattern: each .pkl is looked for once at import time;
a missing or unloadable file degrades to "not active" instead of crashing the backend:
  * no Model 5 pkl -> pairs judged by the policy vetoes + feasibility + the better of the two
    rule baselines Model 5 was benchmarked against (optimal temperatures within 2 C; see
    models/model5_compatibility_metrics.json), and `probability` is null;
  * no Model 4 pkl -> setpoints come straight from the physics optimizer, method "physics".
/health and every plan response say which of these is actually happening.

Guarded ML (Model 4): the student's prediction is clipped into the chance-constrained safe
interval, and if it still disagrees with the physics optimizer by more than
MODEL4_MAX_DISAGREEMENT_C the optimizer's answer is served (method "physics_fallback").
"""
from __future__ import annotations

import json
import logging
import math
import sys

import numpy as np
import pandas as pd

from app.config import (
    MODEL4_MAX_DISAGREEMENT_C,
    MODEL4_METRICS_PATH,
    MODEL4_PKL_PATH,
    MODEL5_METRICS_PATH,
    MODEL5_PKL_PATH,
    PRODUCT_CATALOG_PATH,
    REEFER_FLUCTUATION_PATH,
    SCRIPTS_DIR,
)
from app.logging_config import get_logger, log_event

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import common.products as P  # noqa: E402
from model3_shelf_life import PRODUCT_LIBRARY  # noqa: E402

_logger = get_logger("frostmind.load_planner")


class UnknownProductError(KeyError):
    pass


def _load_pkl(pkl_path, metrics_path, name: str):
    """Returns (model, metrics_dict) or (None, {}) -- never raises."""
    if not pkl_path.exists():
        return None, {}
    try:
        import joblib

        model = joblib.load(pkl_path)
    except Exception as exc:  # pragma: no cover - defensive; missing deps / corrupt file
        log_event(_logger, logging.WARNING, f"{name}_load_failed", pkl_path=str(pkl_path), error=str(exc))
        return None, {}
    metrics = {}
    if metrics_path.exists():
        try:
            metrics = json.loads(metrics_path.read_text())
        except Exception as exc:  # pragma: no cover - defensive; malformed metrics json
            log_event(_logger, logging.WARNING, f"{name}_metrics_load_failed", error=str(exc))
    log_event(_logger, logging.INFO, f"{name}_loaded", pkl_path=str(pkl_path))
    return model, metrics


CATALOG = P.load_catalog(PRODUCT_CATALOG_PATH) if PRODUCT_CATALOG_PATH.exists() else pd.DataFrame()
_POS = {pid: i for i, pid in enumerate(CATALOG["product_id"])} if len(CATALOG) else {}

DEFAULT_SIGMA_C = 0.3
if REEFER_FLUCTUATION_PATH.exists():
    DEFAULT_SIGMA_C = float(json.loads(REEFER_FLUCTUATION_PATH.read_text()).get("default_sigma_c", DEFAULT_SIGMA_C))

_model4, _model4_metrics = _load_pkl(MODEL4_PKL_PATH, MODEL4_METRICS_PATH, "model4")
_model5, _model5_metrics = _load_pkl(MODEL5_PKL_PATH, MODEL5_METRICS_PATH, "model5")
MODEL4_ACTIVE = _model4 is not None
MODEL5_ACTIVE = _model5 is not None
MODEL5_THRESHOLD = float(_model5_metrics.get("calibrated_threshold", 0.5))


def _num(x):
    """float, with NaN/inf -> None so responses stay valid JSON."""
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def list_products() -> list[dict]:
    out = []
    for _, r in CATALOG.iterrows():
        out.append(
            {
                "product_id": r["product_id"],
                "name": r["name"],
                "category": r["category"],
                "safety_class": r["safety_class"],
                "frostmind_category": r["frostmind_category"],
                "t_min_c": _num(r["t_min_c"]),
                "t_max_c": _num(r["t_max_c"]),
                "t_opt_c": _num(r["t_opt_c"]),
                "rh_min": _num(r["rh_min"]),
                "rh_max": _num(r["rh_max"]),
                "chilling_sensitive": bool(r["chilling_sensitive"]),
                "ethylene_production": int(r["ethylene_production"]),
                "ethylene_sensitivity": int(r["ethylene_sensitivity"]),
                "compat_groups": r["compat_groups"],
                "source": r["source"],
            }
        )
    return out


def nearest_device_category(setpoint_c: float) -> tuple[str, float]:
    """The FROSTMIND category whose reference temperature is closest to the setpoint -- the
    device can already apply that via its BLE `set_category` command (firmware unchanged)."""
    key = min(PRODUCT_LIBRARY, key=lambda k: abs(PRODUCT_LIBRARY[k].reference_temp_c - setpoint_c))
    return key, PRODUCT_LIBRARY[key].reference_temp_c


# ---------------------------------------------------------------------------------------------
# Model 4
# ---------------------------------------------------------------------------------------------
def recommend_setpoint(products: pd.DataFrame, weights, sigma: float, model=None) -> dict:
    model = _model4 if model is None and MODEL4_ACTIVE else model
    teacher = P.optimize_setpoint(products, weights, sigma)
    out = {
        "feasible": teacher["feasible"],
        "physics_setpoint_c": teacher["setpoint_c"],
        "student_setpoint_c": None,
        "safe_range_c": [_num(teacher["safe_lo_c"]), _num(teacher["safe_hi_c"])],
        "band_c": [teacher["band_lo_c"], teacher["band_hi_c"]],
    }
    if not teacher["feasible"]:
        out.update(recommended_setpoint_c=None, method="infeasible")
        setpoint = teacher["setpoint_c"]
    else:
        setpoint, method = teacher["setpoint_c"], "physics"
        if model is not None:
            feats = pd.DataFrame([P.load_features(products, weights, sigma)])
            student = round(float(P.student_predict(model, feats)[0]), 2)
            out["student_setpoint_c"] = student
            if abs(student - teacher["setpoint_c"]) <= MODEL4_MAX_DISAGREEMENT_C:
                setpoint, method = student, "ml"
            else:
                method = "physics_fallback"
        out.update(recommended_setpoint_c=setpoint, method=method)
    losses = P.expected_loss_matrix(products, np.array([setpoint]), sigma)[:, 0]
    w = np.asarray(weights, dtype=float)
    out["expected_loss_pct_per_day"] = round(100 * float((w / w.sum()) @ losses), 4)
    out["per_product_loss_pct_per_day"] = [round(100 * float(x), 4) for x in losses]
    dev_key, dev_temp = nearest_device_category(setpoint)
    # The ESP32 only knows the 6 category setpoints (-18, 0, 2, 3, 4, 5 C). If none is within
    # 1 C, applying the "nearest" one would be wrong (e.g. bananas at 13.5 C -> 5 C = chilling
    # injury), so say so instead of pretending the device can do it.
    out.update(
        device_category=dev_key,
        device_category_setpoint_c=dev_temp,
        device_category_within_1c=bool(abs(dev_temp - setpoint) <= 1.0),
    )
    return out


# ---------------------------------------------------------------------------------------------
# Model 5
# ---------------------------------------------------------------------------------------------
def score_pairs(products: pd.DataFrame, sigma: float, model=None) -> list[dict]:
    model = _model5 if model is None and MODEL5_ACTIVE else model
    n = len(products)
    ia, ib = zip(*[(i, j) for i in range(n) for j in range(i + 1, n)]) if n > 1 else ((), ())
    if not ia:
        return []
    feats = P.pair_feature_frame(products, list(ia), list(ib))
    proba = model.predict_proba(feats[P.PAIR_FEATURE_COLS])[:, 1] if model is not None else None
    pairs = []
    for k, (i, j) in enumerate(zip(ia, ib)):
        a, b = products.iloc[i], products.iloc[j]
        f = feats.iloc[k]
        vetoes = P.policy_vetoes(a, b)
        lo, hi = P.feasible_interval(products.iloc[[i, j]], sigma)
        feasible = lo <= hi
        if proba is not None:
            p = float(proba[k])
            physical_ok = p >= MODEL5_THRESHOLD
        else:
            p = None
            physical_ok = bool(f["topt_diff_c"] <= 2.0)
        reasons = P.pair_reasons(a, b, f)
        if not feasible:
            reasons.append("No single setpoint keeps both inside their legal/safe limits (Model 4 feasibility check).")
        pairs.append(
            {
                "i": i,
                "j": j,
                "a": a["product_id"],
                "b": b["product_id"],
                "probability": None if p is None else round(p, 4),
                "compatible": bool(not vetoes and feasible and physical_ok),
                "extrapolated": not (a["safety_class"] == "produce" and b["safety_class"] == "produce"),
                "vetoes": vetoes,
                "reasons": reasons,
                "warnings": P.pair_warnings(a, b),
                "_topt_diff": float(f["topt_diff_c"]),
            }
        )
    return pairs


def plan_load(items: list[tuple[str, float]], sigma: float | None = None) -> dict:
    """items: [(product_id, quantity_kg), ...]. Duplicate product ids are merged."""
    qty: dict[str, float] = {}
    for pid, q in items:
        if pid not in _POS:
            raise UnknownProductError(pid)
        qty[pid] = qty.get(pid, 0.0) + float(q)
    pids = list(qty)
    products = CATALOG.iloc[[_POS[p] for p in pids]].reset_index(drop=True)
    weights = np.array([qty[p] for p in pids])
    sigma = max(float(sigma if sigma is not None else DEFAULT_SIGMA_C), P.SIGMA_FLOOR)

    pairs = score_pairs(products, sigma)
    incompatible = {(p["i"], p["j"]) for p in pairs if not p["compatible"]}
    by_pair = {(p["i"], p["j"]): p for p in pairs}

    # Colour, then repair: a colour class is pairwise-compatible, but pairwise-feasible doesn't
    # always mean jointly feasible once sigma margins stack up -- split the worst pair and recolour.
    for _ in range(len(pids) ** 2 + 1):
        groups = P.dsatur_groups(len(pids), incompatible)
        bad = None
        for g in groups:
            if len(g) > 1:
                lo, hi = P.feasible_interval(products.iloc[g], sigma)
                if lo > hi:
                    bad = g
                    break
        if bad is None:
            break
        worst = max(((a, b) for x, a in enumerate(bad) for b in bad[x + 1 :]), key=lambda ab: by_pair[ab]["_topt_diff"])
        incompatible.add(worst)

    group_out = []
    for gid, g in enumerate(groups, start=1):
        sub = products.iloc[g]
        rec = recommend_setpoint(sub, weights[g], sigma)
        group_out.append(
            {
                "group_id": gid,
                "products": [
                    {
                        "product_id": sub.iloc[k]["product_id"],
                        "name": sub.iloc[k]["name"],
                        "quantity_kg": float(weights[g][k]),
                        "expected_loss_pct_per_day": rec["per_product_loss_pct_per_day"][k],
                    }
                    for k in range(len(g))
                ],
                **{k: v for k, v in rec.items() if k != "per_product_loss_pct_per_day"},
            }
        )

    warnings = sorted({w for p in pairs for w in p["warnings"]})
    for g in group_out:
        if g["feasible"] and not g["device_category_within_1c"]:
            warnings.append(
                f"Compartment {g['group_id']}: {g['recommended_setpoint_c']:.1f} C has no matching FROSTMIND device category "
                f"(nearest is {g['device_category_setpoint_c']:.0f} C) -- set the reefer/AC setpoint manually."
            )
    if any(p["extrapolated"] for p in pairs) and MODEL5_ACTIVE:
        warnings.append(
            "Pairs involving non-produce items are outside Model 5's expert-labelled training data (produce only); "
            "for those, rely on the policy vetoes and the feasibility check."
        )
    return {
        "sigma_c": sigma,
        "model4_active": MODEL4_ACTIVE,
        "model5_active": MODEL5_ACTIVE,
        "compatibility_threshold": MODEL5_THRESHOLD if MODEL5_ACTIVE else None,
        "groups": group_out,
        "pairs": [{k: v for k, v in p.items() if not k.startswith("_") and k not in ("i", "j")} for p in pairs],
        "warnings": warnings,
    }

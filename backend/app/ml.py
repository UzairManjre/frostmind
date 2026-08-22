"""Model 3 (shelf life) integration, plus a deliberately-unimplemented seam for Model 1.

Model 3: imports scripts/model3_shelf_life.py directly and calls it -- no reimplementation of
the Arrhenius math here.

Model 1 status -- read this before wiring anything to score_with_model1(): NONE of the
pre-trained `models/model1_*.pkl` files are suitable for scoring live /ingest telemetry, for two
separate reasons, not one:

1. Feature-schema mismatch (the obvious one). `model1_isolation_forest_shipment.pkl` /
   `model1_random_forest_shipment_supervised.pkl` (scripts/train_model1_shipment*.py) are trained
   on 22 SESSION-LEVEL AGGREGATE features computed over an entire completed multi-day shipment
   (transit_days, temp_mean_c/max_c/min_c/std_c, door_opens, carrier_id, origin_zone,
   vibration_index, feature_x1..3, ...) -- not the per-reading stream /ingest actually receives.
   Calling .decision_function() on that model with live rolling-window features would be a
   straightforward input-shape error.

2. Domain/distribution mismatch (the less obvious one, applies even to the rolling-window
   models). `model1_isolation_forest_milk.pkl` / `model1_isolation_forest_nab.pkl`
   (scripts/train_model1_milk.py, scripts/train_model1_nab.py) DO use a compatible *shape*
   (roll_mean, roll_std, rate_of_change over a small window) -- but roll_mean is a raw Celsius
   value, and IsolationForest has no notion that -18C (frozen_food_generic) and 5C
   (vaccine_generic) are both "normal for their own category." A model whose entire training
   distribution sits in one narrow band (milk-transport temperatures, roughly 0-15C; NAB's
   machine-metric range) would flag effectively every reading from FROSTMIND's other 5 product
   categories as anomalous by construction, not because anything is actually wrong. That's a
   worse failure mode than not scoring at all -- confidently wrong beats not run, only when
   "confidently wrong" isn't the actual behavior.

So: this module does NOT load or call any model1_*.pkl against live data. Per the MVP plan's own
staging (§4: "Right now: no trained model. A threshold rule... The MVP's real job, beyond the
demo, is to generate that first dataset"), the ESP32 firmware's on-device rate-of-change/
deviation threshold rule -- surfaced in every BLE reading as the `alert` boolean -- IS the
system's current real detection mechanism, by design, not a placeholder being silently passed
off as something fancier. app/routers/ingest.py persists that flag directly into Alert rows.
See backend/README.md's "Model 1 status" section for the full writeup.

The one model genuinely trained on FROSTMIND's own feature schema is
scripts/train_model1_frostmind.py -- but it needs data/frostmind_logs/frostmind_log.csv, which
does not exist yet (no real hardware logs have been collected; scripts/README.md documents this
script as not runnable yet). `scripts/export_frostmind_log.py` (added alongside this pass)
exports real logged /ingest readings into that CSV schema, but `session_label` is a human,
session-level judgment (this session was a clean baseline vs. an induced door/hairdryer/power-cut
anomaly clip) that can't be inferred automatically -- so a real .pkl still needs a human to
physically run those sessions. This pass does NOT fabricate that data or train a fake model.

**What this pass DOES do (the "make the seam hot" part):** the block below now actually checks,
at import time, whether `models/model1_isolation_forest_frostmind.pkl` exists on disk. If it does
(it doesn't yet, verified in this pass), it loads it and every call to score_with_model1() from
here on actually scores real feature values against it. If it doesn't -- today's real state --
score_with_model1() stays the exact same documented no-op it always was, and
app/routers/ingest.py's behavior is byte-for-byte unchanged (see MODEL1_ACTIVE below, which
app/routers/ingest.py checks to decide alert-message wording only, not whether to call the
function -- it always calls it, so nothing needs to change caller-side the day a real .pkl shows
up). See backend/README.md's "Model 1 status" section for what's hot vs. still human work.
"""
from __future__ import annotations

import json
import logging
import sys

import numpy as np

from app.config import MODEL1_METRICS_PATH, MODEL1_PKL_PATH, SCRIPTS_DIR
from app.logging_config import get_logger, log_event

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from model3_shelf_life import PRODUCT_LIBRARY, remaining_hours_at_current_temp, shelf_life_consumed_fraction  # noqa: E402

_logger = get_logger("frostmind.ml")

# Feature order Model 1 was trained on -- see scripts/train_model1_frostmind.py's FEATURE_COLS.
MODEL1_FEATURE_COLS = ["roll_mean", "roll_std", "rate_of_change", "door_open_dur"]


def _load_model1(pkl_path, metrics_path):
    """Loads a model1_isolation_forest_frostmind-shaped .pkl + its calibrated threshold from
    disk. Returns (model, threshold) or (None, None) if the file doesn't exist or fails to load
    (missing joblib/scikit-learn, a corrupt file, etc. -- any of which should degrade to "not
    running" rather than crash the whole backend at import time).

    Split out from module-level code (rather than inlined) so tests can call this directly
    against a temp path without needing to reload the whole module / touch real files under
    models/.
    """
    if not pkl_path.exists():
        return None, None
    try:
        import joblib

        model = joblib.load(pkl_path)
    except Exception as exc:  # pragma: no cover - defensive; missing deps / corrupt file
        log_event(
            _logger, logging.WARNING, "model1_load_failed", pkl_path=str(pkl_path), error=str(exc)
        )
        return None, None

    threshold = None
    if metrics_path.exists():
        try:
            threshold = json.loads(metrics_path.read_text()).get("calibrated_threshold")
        except Exception as exc:  # pragma: no cover - defensive; malformed metrics json
            log_event(
                _logger,
                logging.WARNING,
                "model1_metrics_load_failed",
                metrics_path=str(metrics_path),
                error=str(exc),
            )
    if threshold is None:
        threshold = 0.0  # decision_function's own sign convention: >=0 roughly means "outlier"

    log_event(_logger, logging.INFO, "model1_loaded", pkl_path=str(pkl_path), threshold=threshold)
    return model, threshold


_model1, _model1_threshold = _load_model1(MODEL1_PKL_PATH, MODEL1_METRICS_PATH)

# True only once a real models/model1_isolation_forest_frostmind.pkl has been loaded. Checked by
# app/main.py's /health and app/routers/ingest.py's alert messages so nothing ever claims Model 1
# is running when it isn't -- see this module's docstring.
MODEL1_ACTIVE = _model1 is not None


def _score(model, threshold: float, roll_mean: float, roll_std: float, rate_of_change: float, door_open_dur: float) -> tuple[float, bool]:
    import pandas as pd

    x = pd.DataFrame([[roll_mean, roll_std, rate_of_change, door_open_dur]], columns=MODEL1_FEATURE_COLS)
    score = float(-model.decision_function(x)[0])
    return score, bool(score >= threshold)


def score_with_model1(
    roll_mean: float, roll_std: float, rate_of_change: float, door_open_dur: float
) -> tuple[float | None, bool | None]:
    """Seam for Model 1 ML scoring, called on every /ingest reading (app/routers/ingest.py)
    regardless of whether a model is loaded.

    Returns (None, None) -- today's real state -- if no models/model1_isolation_forest_frostmind.pkl
    was found at import time. Once that file exists (produced by
    scripts/train_model1_frostmind.py against real hardware-logged sessions), this automatically
    scores every call against it and returns (anomaly_score, is_anomaly) instead -- no caller-side
    or code changes needed; only the .pkl needs to show up on disk before the app is (re)started.
    """
    if _model1 is None:
        return None, None
    return _score(_model1, _model1_threshold, roll_mean, roll_std, rate_of_change, door_open_dur)


def compute_shelf_life(category: str, temps_c: list[float], hours: list[float], current_temp_c: float):
    """Model 3: returns (consumed_fraction, remaining_hours) for a shipment's full
    temp-exposure history so far, using the category's ArrheniusProduct from PRODUCT_LIBRARY.
    """
    if category not in PRODUCT_LIBRARY:
        raise KeyError(f"Unknown product category: {category}")
    if len(temps_c) < 2:
        return 0.0, None

    product = PRODUCT_LIBRARY[category]
    temps_arr = np.asarray(temps_c, dtype=float)
    hours_arr = np.asarray(hours, dtype=float)
    consumed = shelf_life_consumed_fraction(temps_arr, hours_arr, product)
    remaining = remaining_hours_at_current_temp(temps_arr, hours_arr, product, current_temp_c)
    return consumed, remaining

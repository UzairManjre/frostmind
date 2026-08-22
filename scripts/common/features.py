"""Shared rolling-window feature engineering and evaluation for Model 1 (anomaly detector).

Mirrors the feature set and semi-supervised training recipe from §4 of the MVP plan: train an
Isolation Forest on normal-only rows, then score held-out normal + anomaly rows against it.
"""
from __future__ import annotations

import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    balanced_accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)


def rolling_features(series: pd.Series, window: int = 10) -> pd.DataFrame:
    """Rolling mean/std + rate of change for a single temperature series (one session)."""
    return pd.DataFrame(
        {
            "roll_mean": series.rolling(window).mean(),
            "roll_std": series.rolling(window).std(),
            "rate_of_change": series.diff(),
        }
    )


def calibrate_and_evaluate(model, x_calib, y_calib, x_test, y_test) -> dict:
    """Calibrate a decision threshold on one held-out split, report final metrics on a
    SEPARATE held-out split -- so the reported accuracy isn't threshold-tuned on the same rows
    it's measured on (that would be a leak). The IsolationForest itself never sees labels;
    only the operating threshold is chosen using them, same as calibrating a z-score cutoff
    against real data, which the plan's own "Deployment" note calls out as a legitimate move.

    Threshold picked via Youden's J (max TPR - FPR) on the calibration split -- the standard
    way to pick an operating point off an ROC curve when you want one threshold, not a curve.
    """
    y_calib = pd.Series(y_calib).astype(int).values
    y_test = pd.Series(y_test).astype(int).values

    calib_scores = -model.decision_function(x_calib)  # higher = more anomalous
    fpr, tpr, thresholds = roc_curve(y_calib, calib_scores)
    threshold = float(thresholds[(tpr - fpr).argmax()])

    test_scores = -model.decision_function(x_test)
    preds = (test_scores >= threshold).astype(int)

    has_both_classes = len(set(y_test)) > 1

    return {
        "calibrated_threshold": threshold,
        "roc_auc": roc_auc_score(y_test, test_scores) if has_both_classes else float("nan"),
        "average_precision": average_precision_score(y_test, test_scores) if has_both_classes else float("nan"),
        "accuracy": accuracy_score(y_test, preds),
        "balanced_accuracy": balanced_accuracy_score(y_test, preds),
        "precision": precision_score(y_test, preds, zero_division=0),
        "recall": recall_score(y_test, preds, zero_division=0),
        "f1": f1_score(y_test, preds, zero_division=0),
        "n_calib": int(len(y_calib)),
        "n_test": int(len(y_test)),
        "n_anomaly_test": int(y_test.sum()),
    }

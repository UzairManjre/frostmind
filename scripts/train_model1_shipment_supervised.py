"""
Model 1, supervised variant -- trained directly on the shipment dataset's real `silent_failure`
labels, instead of the semi-supervised "train on normal only" recipe the other scripts use.

Why this exists alongside train_model1_shipment.py: that script mirrors what FROSTMIND's own
deployment will actually look like (mostly unlabeled logs, few confirmed anomalies), so it's
the honest baseline for the real system. This dataset happens to have full ground-truth labels
for all 8,000 shipments, so there's no reason to throw that away -- a supervised classifier
uses it directly and does noticeably better (accuracy ~82% vs. ~74%, ROC-AUC ~0.91 vs. ~0.81).
Present it as "what's achievable when labels exist," not as what runs on-device.
"""
import json
import sys
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split

sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "kaggle_cold_chain_shipment_silent_failure"
OUT = ROOT / "models"
OUT.mkdir(exist_ok=True)

FEATURE_COLS = [
    "transit_days", "door_opens", "temp_mean_c", "temp_max_c", "temp_min_c", "temp_std_c",
    "temp_recovery_rate", "rh_mean", "rh_std", "rh_max", "package_type", "product_volume_l",
    "fill_ratio", "carrier_id", "origin_zone", "dest_zone", "leg_count", "sensor_gap_hours",
    "vibration_index", "feature_x1", "feature_x2", "feature_x3",
]


def main():
    df = pd.read_csv(DATA / "shipment-sensor-dataset.csv")
    x = df[FEATURE_COLS]
    y = df["silent_failure"]

    x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=0.3, random_state=42, stratify=y)
    print(f"Train: {len(x_train)} shipments ({y_train.mean() * 100:.1f}% silent-failure)")
    print(f"Test: {len(x_test)} shipments ({y_test.mean() * 100:.1f}% silent-failure)")

    model = RandomForestClassifier(n_estimators=300, max_depth=8, class_weight="balanced", random_state=42)
    model.fit(x_train, y_train)

    preds = model.predict(x_test)
    proba = model.predict_proba(x_test)[:, 1]
    metrics = {
        "accuracy": accuracy_score(y_test, preds),
        "balanced_accuracy": balanced_accuracy_score(y_test, preds),
        "roc_auc": roc_auc_score(y_test, proba),
        "precision": precision_score(y_test, preds, zero_division=0),
        "recall": recall_score(y_test, preds, zero_division=0),
        "f1": f1_score(y_test, preds, zero_division=0),
        "n_train": int(len(x_train)),
        "n_test": int(len(x_test)),
        "n_anomaly_test": int(y_test.sum()),
        "top_features": pd.Series(model.feature_importances_, index=FEATURE_COLS)
        .sort_values(ascending=False)
        .head(8)
        .round(4)
        .to_dict(),
    }
    print(json.dumps(metrics, indent=2))

    joblib.dump(model, OUT / "model1_random_forest_shipment_supervised.pkl")
    (OUT / "model1_random_forest_shipment_supervised_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"Saved model -> {OUT / 'model1_random_forest_shipment_supervised.pkl'}")


if __name__ == "__main__":
    main()

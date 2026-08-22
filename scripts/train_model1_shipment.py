"""
Model 1 (anomaly detector) applied to the Kaggle Cold Chain Shipment Silent Failure dataset.

This dataset is SIMULATED (8,000 synthetic shipments, per the author's own description — see
data/kaggle_cold_chain_shipment_silent_failure/README.md), not real-world data. It's included
because its target (silent_failure: a failure with no alarm raised) is conceptually identical
to what FROSTMIND's anomaly detector needs to catch, and it has explicit ground-truth labels
FROSTMIND's own logs won't have much of yet. Note: the downloaded CSV only contains the
`silent_failure` target column, not the `label` (any-failure) column the Kaggle page describes.

One row = one full shipment's aggregated session statistics (not a raw time series), so this
validates Model 1 at the "session-level" granularity FROSTMIND will also produce once you save
labeled sessions per §4's Stage 2 data collection plan (normal baseline vs. induced-anomaly clips).
"""
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.model_selection import train_test_split

import sys

sys.path.insert(0, str(Path(__file__).parent))
from common.features import calibrate_and_evaluate

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

    normal = df[df["silent_failure"] == 0]
    anomaly = df[df["silent_failure"] == 1]
    normal_train, normal_eval = train_test_split(normal, test_size=0.3, random_state=42)

    print(f"Total: {len(df)} shipments, {len(anomaly)} silent-failure ({len(anomaly) / len(df) * 100:.1f}%)")
    print(f"Train (normal only): {len(normal_train)} shipments")
    print(f"Eval: {len(normal_eval)} held-out normal + {len(anomaly)} silent-failure shipments")

    model = IsolationForest(contamination=0.02, random_state=42, n_estimators=200)
    model.fit(normal_train[FEATURE_COLS])

    eval_df = pd.concat([normal_eval, anomaly])
    eval_df["anomaly"] = (eval_df["silent_failure"] == 1).astype(int)
    eval_calib, eval_test = train_test_split(
        eval_df, test_size=0.5, random_state=42, stratify=eval_df["anomaly"]
    )
    print(f"  -> split into {len(eval_calib)} calibration rows, {len(eval_test)} test rows")

    metrics = calibrate_and_evaluate(
        model,
        eval_calib[FEATURE_COLS], eval_calib["anomaly"],
        eval_test[FEATURE_COLS], eval_test["anomaly"],
    )
    print(json.dumps(metrics, indent=2))

    joblib.dump(model, OUT / "model1_isolation_forest_shipment.pkl")
    (OUT / "model1_isolation_forest_shipment_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"Saved model -> {OUT / 'model1_isolation_forest_shipment.pkl'}")


if __name__ == "__main__":
    main()

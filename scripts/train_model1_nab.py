"""
Model 1 (anomaly detector) — Stage 2 checkpoint, validated against the NAB machine-temperature
benchmark before being applied to FROSTMIND's own logged sessions (per the plan's suggestion to
report a real number against an established benchmark first).

Trains an Isolation Forest on the normal lead-in period of NAB's real machine-temperature
series (the field's standard benchmark for this exact problem class), then evaluates recall on
the 4 labeled anomaly windows (including the catastrophic-failure window) and false-positive
rate on held-out normal data later in the same series.

Note: this is a SIMPLIFIED point-based evaluation (row-by-row inside vs. outside the labeled
windows), not the official NAB scoring algorithm (which is windowed and rewards early
detection). Good enough for an honest recall/FPR/ROC-AUC checkpoint, not an NAB leaderboard claim.
"""
import json
import sys
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.model_selection import train_test_split

sys.path.insert(0, str(Path(__file__).parent))
from common.features import calibrate_and_evaluate, rolling_features

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "NAB_machine_temperature"
OUT = ROOT / "models"
OUT.mkdir(exist_ok=True)

WINDOW = 10  # samples (~50 min at this series' 5-min cadence)
FEATURE_COLS = ["roll_mean", "roll_std", "rate_of_change"]


def main():
    df = pd.read_csv(DATA / "machine_temperature_system_failure.csv", parse_dates=["timestamp"])
    labels = json.loads((DATA / "machine_temperature_labels.json").read_text())
    windows = [(pd.Timestamp(a), pd.Timestamp(b)) for a, b in labels["anomaly_windows"]]

    df["anomaly"] = 0
    for start, end in windows:
        df.loc[(df["timestamp"] >= start) & (df["timestamp"] <= end), "anomaly"] = 1

    feats = rolling_features(df["value"], window=WINDOW)
    df = pd.concat([df, feats], axis=1).dropna().reset_index(drop=True)

    first_anomaly_start = min(w[0] for w in windows)
    train_df = df[df["timestamp"] < first_anomaly_start]
    eval_df = df[df["timestamp"] >= first_anomaly_start]

    eval_calib, eval_test = train_test_split(
        eval_df, test_size=0.5, random_state=42, stratify=eval_df["anomaly"]
    )

    print(f"Series: {df['timestamp'].min()} to {df['timestamp'].max()} ({len(df)} rows)")
    print(f"Train (normal lead-in, before first anomaly window): {len(train_df)} rows")
    print(f"Eval: {len(eval_df)} rows, {eval_df['anomaly'].sum()} inside the {len(windows)} labeled anomaly windows")
    print(f"  -> split into {len(eval_calib)} calibration rows, {len(eval_test)} test rows")

    model = IsolationForest(contamination=0.02, random_state=42, n_estimators=200)
    model.fit(train_df[FEATURE_COLS])

    metrics = calibrate_and_evaluate(
        model,
        eval_calib[FEATURE_COLS], eval_calib["anomaly"],
        eval_test[FEATURE_COLS], eval_test["anomaly"],
    )
    print(json.dumps(metrics, indent=2))

    joblib.dump(model, OUT / "model1_isolation_forest_nab.pkl")
    (OUT / "model1_isolation_forest_nab_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"Saved model -> {OUT / 'model1_isolation_forest_nab.pkl'}")


if __name__ == "__main__":
    main()

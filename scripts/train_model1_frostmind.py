"""
Model 1 (anomaly detector) -- the actual Stage 2 training script for FROSTMIND's own logged
sessions, per §4 of the MVP plan. Point this at your real `logToSerial` CSV output once you've
captured a normal-baseline run plus your induced-anomaly clips (door held open, hairdryer near
the sensor, AC unplugged) with session-level labels.

Expects a CSV at data/frostmind_logs/frostmind_log.csv with columns:
    ts, temp, humidity, door, rate_of_change, session_label
where door is 1=open/0=closed and session_label is a free-text label per session
("normal", "door_open", "compressor_fault", "power_loss", ...) -- everything other than
"normal" is treated as an anomaly session for eval purposes.

Until that file exists, this can't run -- it's not something to fake with synthetic values,
per the plan's own point that the model has nothing to learn from until real sessions are logged.
"""
import json
import sys
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import IsolationForest

sys.path.insert(0, str(Path(__file__).parent))
from common.features import evaluate_semi_supervised

ROOT = Path(__file__).resolve().parents[1]
LOG_PATH = ROOT / "data" / "frostmind_logs" / "frostmind_log.csv"
OUT = ROOT / "models"
OUT.mkdir(exist_ok=True)

WINDOW = 10
FEATURE_COLS = ["roll_mean", "roll_std", "rate_of_change", "door_open_dur"]


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("ts").reset_index(drop=True)
    df["roll_mean"] = df["temp"].rolling(WINDOW).mean()
    df["roll_std"] = df["temp"].rolling(WINDOW).std()
    if "rate_of_change" not in df.columns or df["rate_of_change"].isna().all():
        df["rate_of_change"] = df["temp"].diff()
    df["door_open_dur"] = df["door"].rolling(WINDOW).sum()
    return df


def main():
    if not LOG_PATH.exists():
        print(f"No log found at {LOG_PATH}.")
        print("This script trains on FROSTMIND's own hardware logs, which don't exist yet.")
        print("Per the MVP plan (build order step 4): run the combined SHT31 + reed-switch logging")
        print("sketch for a real stretch of time to get a normal baseline, then capture 5-10")
        print("induced-anomaly clips (door held open / hairdryer near sensor / AC unplugged),")
        print(f"and save the combined CSV to {LOG_PATH} with columns:")
        print("  ts, temp, humidity, door, rate_of_change, session_label")
        sys.exit(1)

    df = pd.read_csv(LOG_PATH, parse_dates=["ts"])
    df = build_features(df).dropna().reset_index(drop=True)
    df["anomaly"] = (df["session_label"] != "normal").astype(int)

    normal = df[df["anomaly"] == 0]
    anomaly = df[df["anomaly"] == 1]
    split = int(len(normal) * 0.7)
    train_df, eval_normal = normal.iloc[:split], normal.iloc[split:]
    eval_df = pd.concat([eval_normal, anomaly])

    print(f"Train (normal only): {len(train_df)} rows")
    print(f"Eval: {len(eval_normal)} held-out normal + {len(anomaly)} anomaly rows")

    model = IsolationForest(contamination=0.02, random_state=42, n_estimators=200)
    model.fit(train_df[FEATURE_COLS])

    metrics = evaluate_semi_supervised(model, eval_df[FEATURE_COLS], eval_df["anomaly"].values)
    print(json.dumps(metrics, indent=2))

    joblib.dump(model, OUT / "model1_isolation_forest_frostmind.pkl")
    (OUT / "model1_isolation_forest_frostmind_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"Saved model -> {OUT / 'model1_isolation_forest_frostmind.pkl'}")


if __name__ == "__main__":
    main()

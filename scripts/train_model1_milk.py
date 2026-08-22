"""
Model 1 (anomaly detector) applied to the Kaggle "Data Sets Cold Chain Milk" dataset.

Real (not simulated) cold-chain temperature logs — 92 separate shipment/session files, each a
short time series with a genuine per-timestamp label ("ACEPTABLE" / "ALERTA", i.e. within-spec
vs. alert) already assigned by the original data collector. That real per-row ground truth is
what lets this be scored the same way as the NAB and shipment checkpoints.

Sessions are split 70/30 for train/eval (not rows) so the eval set is genuinely held-out
shipments, not just held-out timestamps from sessions the model has already partly seen.
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
DATA = ROOT / "data" / "kaggle_cold_chain_milk"
OUT = ROOT / "models"
OUT.mkdir(exist_ok=True)

WINDOW = 5
FEATURE_COLS = ["roll_mean", "roll_std", "rate_of_change"]


def load_all_sessions() -> pd.DataFrame:
    frames = []
    for path in sorted(DATA.glob("Datos (*).xlsx"), key=lambda p: int(p.stem.split("(")[1].rstrip(")"))):
        raw = pd.read_excel(path)
        raw.columns = ["minutos", "temp", "temp_max", "temp_min", "status"]
        raw["temp"] = pd.to_numeric(raw["temp"], errors="coerce")
        raw["minutos"] = pd.to_numeric(raw["minutos"], errors="coerce")
        raw = raw.dropna(subset=["temp", "minutos"])
        raw["session_id"] = path.stem
        raw["anomaly"] = (raw["status"].astype(str).str.strip().str.upper() == "ALERTA").astype(int)
        frames.append(raw[["session_id", "minutos", "temp", "anomaly"]])
    return pd.concat(frames, ignore_index=True)


def main():
    df = load_all_sessions()
    print(
        f"Loaded {df['session_id'].nunique()} sessions, {len(df)} total readings, "
        f"{df['anomaly'].mean() * 100:.1f}% ALERTA rows"
    )

    feat_frames = []
    for _, g in df.groupby("session_id", sort=False):
        g = g.sort_values("minutos").reset_index(drop=True)
        g = pd.concat([g, rolling_features(g["temp"], window=WINDOW)], axis=1)
        feat_frames.append(g)
    df = pd.concat(feat_frames, ignore_index=True).dropna().reset_index(drop=True)

    sessions = pd.Series(df["session_id"].unique()).sample(frac=1.0, random_state=42).tolist()
    split = int(len(sessions) * 0.7)
    train_sessions, eval_sessions = set(sessions[:split]), set(sessions[split:])

    train_df = df[df["session_id"].isin(train_sessions) & (df["anomaly"] == 0)]
    eval_df = df[df["session_id"].isin(eval_sessions)]

    eval_calib, eval_test = train_test_split(
        eval_df, test_size=0.5, random_state=42, stratify=eval_df["anomaly"]
    )

    print(f"Train (normal rows from {len(train_sessions)} sessions): {len(train_df)}")
    print(f"Eval ({len(eval_sessions)} held-out sessions): {len(eval_df)} rows, {eval_df['anomaly'].sum()} anomaly rows")
    print(f"  -> split into {len(eval_calib)} calibration rows, {len(eval_test)} test rows")

    model = IsolationForest(contamination=0.02, random_state=42, n_estimators=200)
    model.fit(train_df[FEATURE_COLS])

    metrics = calibrate_and_evaluate(
        model,
        eval_calib[FEATURE_COLS], eval_calib["anomaly"],
        eval_test[FEATURE_COLS], eval_test["anomaly"],
    )
    print(json.dumps(metrics, indent=2))

    joblib.dump(model, OUT / "model1_isolation_forest_milk.pkl")
    (OUT / "model1_isolation_forest_milk_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"Saved model -> {OUT / 'model1_isolation_forest_milk.pkl'}")


if __name__ == "__main__":
    main()

"""
Light EDA for the Kaggle "Temperature Readings: IoT Devices" dataset.

General (non-cold-chain) IoT temperature data with no anomaly labels at all, so it can't be
scored the same way as the other three Model 1 checkpoints (NAB / milk / shipment). Lowest
priority per the original sourcing notes — only useful as extra unlabeled normal-baseline
volume if the cold-chain-specific sets aren't enough on their own. This script just profiles it
so you know what's actually in it before deciding whether it's worth using at all.
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "kaggle_iot_temperature"
OUT = ROOT / "models"
OUT.mkdir(exist_ok=True)


def main():
    df = pd.read_csv(DATA / "IOT-temp.csv")
    df["noted_date"] = pd.to_datetime(df["noted_date"], format="%d-%m-%Y %H:%M")
    df.columns = [c.replace("/", "_") for c in df.columns]

    summary = {
        "rows": len(df),
        "date_range": [str(df["noted_date"].min()), str(df["noted_date"].max())],
        "temp_stats_by_location": df.groupby("out_in")["temp"].describe().to_dict(),
        "note": "No anomaly labels present in this dataset -- profiling only, not a trained/evaluated checkpoint.",
    }
    print(json.dumps(summary, indent=2, default=str))
    (OUT / "iot_temp_profile.json").write_text(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()

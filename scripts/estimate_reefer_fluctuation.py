"""
Estimate how much a real reefer's temperature fluctuates around its setpoint (sigma, deg C) --
the one piece of REAL sensor data Model 4 depends on. A load with a narrow safe band (vaccines
2-8 C, lettuce just above freezing) needs its setpoint centred further from the limits on a
wobbly reefer than on a stable one, so sigma is an input to both the physics optimizer and the
ML student.

Source: the Kaggle cold-chain milk dataset (real transport logs, 92 sessions) already used for
Model 1 -- loaded with train_model1_milk.load_all_sessions() so both models read it the same way.
  * normal sigma  = std of the ACEPTABLE (in-spec) readings of each session
  * stress sigma  = std of all readings of sessions that contain ALERTA excursions
FROSTMIND's own DB (backend/frostmind.db) holds bench-test readings at ~29 C, not reefer data,
so it's only used for the sensor noise floor (std of reading-to-reading differences / sqrt(2)).

Output: data/product_catalog/reefer_fluctuation.json (percentiles + the per-session sigmas that
train_model4_mixed_setpoint.py samples from).
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

from common.products import SIGMA_FLOOR  # noqa: E402
from train_model1_milk import load_all_sessions  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "product_catalog" / "reefer_fluctuation.json"
DB = ROOT / "backend" / "frostmind.db"
MIN_ROWS = 30


def pct(values, qs=(10, 25, 50, 75, 90)):
    return {f"p{q}": round(float(np.percentile(values, q)), 3) for q in qs}


def frostmind_noise_floor() -> dict | None:
    if not DB.exists():
        return None
    con = sqlite3.connect(DB)
    try:
        rows = con.execute("SELECT shipment_id, temp_c FROM sensor_readings ORDER BY shipment_id, ts").fetchall()
    finally:
        con.close()
    diffs, prev_ship, prev_t = [], None, None
    for ship, t in rows:
        if ship == prev_ship and prev_t is not None:
            diffs.append(t - prev_t)
        prev_ship, prev_t = ship, t
    if len(diffs) < 10:
        return None
    d = np.asarray(diffs)
    d = d[np.abs(d) < 1.0]  # drop real temperature moves (door/heat tests); keep jitter only
    return {"readings": len(rows), "sensor_noise_sigma_c": round(float(d.std() / np.sqrt(2)), 3)}


def main():
    df = load_all_sessions()
    normal, stress = [], []
    for _, g in df.groupby("session_id"):
        ok = g.loc[g["anomaly"] == 0, "temp"]
        if len(ok) >= MIN_ROWS:
            normal.append(float(ok.std()))
        if g["anomaly"].any() and len(g) >= MIN_ROWS:
            stress.append(float(g["temp"].std()))
    normal = np.asarray(normal)
    stress = np.asarray(stress)
    normal_clipped = np.maximum(normal, SIGMA_FLOOR)

    result = {
        "source": "data/kaggle_cold_chain_milk (92 real transport sessions)",
        "method": "per-session std of in-spec (ACEPTABLE) readings = normal sigma; std of sessions with ALERTA excursions = stress sigma",
        "sigma_floor_c": SIGMA_FLOOR,
        "n_sessions_normal": int(len(normal)),
        "n_sessions_stress": int(len(stress)),
        "normal_sigma_raw": pct(normal),
        "normal_sigma_clipped": pct(normal_clipped),
        "stress_sigma": pct(stress),
        "default_sigma_c": round(float(np.median(normal_clipped)), 3),
        "frostmind_db": frostmind_noise_floor(),
        "normal_sigmas_clipped": [round(float(x), 4) for x in sorted(normal_clipped)],
        "stress_sigmas": [round(float(x), 4) for x in sorted(stress)],
    }
    OUT.write_text(json.dumps(result, indent=2))
    printable = {k: v for k, v in result.items() if not k.endswith("sigmas") and not k.endswith("sigmas_clipped")}
    print(json.dumps(printable, indent=2))
    print(f"Saved -> {OUT}")


if __name__ == "__main__":
    main()

"""Run every Model 1 training/validation checkpoint that has real data available right now,
plus the Model 3 shelf-life formula demo, plus the Model 4/5 Load Planner pipeline
(product data download -> cleaning -> sigma -> Model 5 -> Model 4).

Model 2 (root-cause classifier) is intentionally excluded -- it's blocked on the INA219
hardware, not on effort (see plan §3). train_model1_frostmind.py (FROSTMIND's own hardware
logs) is included automatically once data/frostmind_logs/frostmind_log.csv exists.
"""
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
PYTHON = sys.executable

CHECKS = [
    ("Model 1 vs NAB (real, established benchmark)", "train_model1_nab.py"),
    ("Model 1 vs Kaggle cold-chain milk (real)", "train_model1_milk.py"),
    ("Model 1 vs Kaggle shipment silent-failure (simulated)", "train_model1_shipment.py"),
    ("Model 1 supervised vs Kaggle shipment silent-failure", "train_model1_shipment_supervised.py"),
    ("IoT-temp profiling (unlabeled, EDA only)", "explore_iot_temp.py"),
    ("Model 3 shelf-life formula demo", "model3_shelf_life.py"),
    # Models 4/5 (Load Planner) -- data pipeline first, then the two models.
    ("Models 4/5 data: download product-storage sources", "fetch_product_data.py"),
    ("Models 4/5 data: clean + merge product catalog", "build_product_catalog.py"),
    ("Models 4/5 data: real reefer fluctuation sigma (milk dataset)", "estimate_reefer_fluctuation.py"),
    ("Model 5 co-shipment compatibility (McGregor expert labels)", "train_model5_compatibility.py"),
    ("Model 4 mixed-load setpoint (physics teacher -> ML student)", "train_model4_mixed_setpoint.py"),
]


def main():
    frostmind_log = SCRIPTS_DIR.parent / "data" / "frostmind_logs" / "frostmind_log.csv"
    if frostmind_log.exists():
        CHECKS.insert(3, ("Model 1 vs FROSTMIND's own logs", "train_model1_frostmind.py"))

    for title, script in CHECKS:
        print("\n" + "=" * 70)
        print(title)
        print("=" * 70)
        subprocess.run([PYTHON, str(SCRIPTS_DIR / script)], check=True)


if __name__ == "__main__":
    main()

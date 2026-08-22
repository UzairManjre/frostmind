# FROSTMIND training scripts

Implements the model plan from §3-4 of `FROSTMIND_MVP_Implementation_and_AI_Plan (1).md`:
Model 1 (anomaly detector) is trainable now, so it's built and validated against every real
dataset on hand. Model 3 (shelf-life) is a formula, not a trained model, so it's implemented
too. **Model 2 (root-cause classifier) is intentionally not here** — it needs the INA219
power-draw signal, which is explicitly deferred hardware, not a scripting gap.

## Setup

A venv already exists at `../.venv` with everything installed. To rebuild it from scratch:

```
py -m venv .venv
.venv\Scripts\python.exe -m pip install -r scripts\requirements.txt
```

## What each script does

| Script | Model | Data | Real or simulated |
|---|---|---|---|
| `train_model1_nab.py` | 1 | NAB machine-temperature | Real — the field's standard benchmark |
| `train_model1_milk.py` | 1 | Kaggle cold-chain milk (92 sessions) | Real — genuine per-row ACEPTABLE/ALERTA labels |
| `train_model1_shipment.py` | 1 (semi-supervised) | Kaggle cold-chain shipment silent-failure | **Simulated** — 8,000 synthetic shipments, see that folder's README |
| `train_model1_shipment_supervised.py` | 1 (supervised) | same shipment dataset, using its real labels directly | **Simulated** — best accuracy of anything here, see caveat below |
| `explore_iot_temp.py` | — | Kaggle IoT temperature | Real, unlabeled — profiling only, no model trained |
| `model3_shelf_life.py` | 3 | None (Arrhenius formula, illustrative Ea/A) | N/A |
| `train_model1_frostmind.py` | 1 | `data/frostmind_logs/frostmind_log.csv` | Real, once you log it — **not runnable yet**, no file exists |
| `train_all.py` | — | runs everything above in sequence | — |

Run any script directly, e.g. `..\.venv\Scripts\python.exe train_model1_nab.py`, or
`train_all.py` to run the full set. Trained models land in `../models/*.pkl`, metrics in
`../models/*_metrics.json`.

## How Model 1 is trained and scored, everywhere

Same training recipe as the plan's own code sample: fit `IsolationForest(contamination=0.02)`
on **normal-only** rows/sessions (the model itself never sees a label). Scoring is then
calibrated properly — the held-out anomaly+normal data is split in half: one half picks an
operating threshold (max TPR-FPR off the ROC curve), the other half is untouched until the
final metrics are computed on it. That's what makes "accuracy" here a real number instead of
the trivially-high-but-useless accuracy you'd get by just predicting "normal" every time (these
datasets are 11-30% anomalies, so a do-nothing model already scores 85-90% "accuracy").

Current results (from the last run — re-run to refresh):

| Dataset | Accuracy | Balanced accuracy | ROC-AUC | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| NAB machine-temperature (semi-supervised) | 85.6% | 71.6% | 0.770 | 38.8% | 53.6% | 0.450 |
| Cold-chain milk (semi-supervised) | 83.8% | 89.3% | 0.851 | 60.2% | 100% | 0.751 |
| Shipment silent-failure (semi-supervised) | 74.2% | 74.1% | 0.809 | 70.5% | 73.3% | 0.719 |
| **Shipment silent-failure (supervised)** | **82.3%** | **84.3%** | **0.913** | 53.1% | 87.5% | 0.661 |

The milk model's 100% recall is a real result, not a bug — its `ALERTA` label looks like it was
originally assigned by a simple temperature-threshold rule, so it's an easy target for anything
that can see rolling temperature stats. Don't oversell it as proof of a hard problem solved.

**The supervised shipment row is the one to lead with if you want an "accuracy ~80%, here's a
usable model" headline** — it's trained directly on the shipment dataset's real `silent_failure`
column (`train_model1_shipment_supervised.py`, a `RandomForestClassifier`) instead of the
semi-supervised "normal-only" recipe. Be precise about what it demonstrates: it
proves the *signal in the sensor features* genuinely predicts silent failure (top predictors:
`temp_max_c`, `transit_days`, `door_opens`, `rh_std`) — it is NOT what will run against
FROSTMIND's own hardware logs on day one, because you won't have thousands of labeled
failure/normal sessions like this benchmark does. The semi-supervised rows above are the honest
stand-in for that real deployment scenario; the supervised row is the "what's achievable with
labels" ceiling.

## The NAB evaluation isn't the official NAB score

`train_model1_nab.py` labels a row "anomaly" if its timestamp falls inside one of NAB's 4
labeled windows, and scores plain recall/precision/ROC-AUC from that. NAB's own leaderboard
uses a different, windowed scoring algorithm that rewards early detection — don't present these
numbers as an NAB benchmark leaderboard score, just as "validated against NAB's labeled real
failure data."

## Once you have real FROSTMIND hardware logs

`train_model1_frostmind.py` implements the plan's exact §4 recipe (`roll_mean`, `roll_std`,
`rate_of_change`, `door_open_dur` features) against your own logged sessions. It currently
exits with instructions instead of running, because `data/frostmind_logs/frostmind_log.csv`
doesn't exist yet. Once you've logged a normal baseline + 5-10 induced-anomaly clips per the
plan's build order, save the combined CSV there (columns: `ts, temp, humidity, door,
rate_of_change, session_label`) and run it directly, or via `train_all.py` (it's auto-included
once the file exists).

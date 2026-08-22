# Data Sets Cold Chain Milk

**Downloaded** (manually, via your own Kaggle login) 2026-08-21.

- URL: https://www.kaggle.com/datasets/u201411546/data-sets-cold-chain-milk
- Real (not synthetic) food cold-chain temperature-and-time data, Spanish-labeled.

## Contents

92 files, `Datos (1).xlsx` … `Datos (92).xlsx` — one per shipment/session. Each has 5 columns:

- `Minutos` — minutes elapsed
- `Temperatura` — temperature reading (°C)
- `Temperatura Máxima (°C)`, `Temperatura Mínima (°C)` — session-level max/min bounds
- `¿Valor Correcto?` — per-row label, real ground truth: `ACEPTABLE` (within spec) or `ALERTA`
  (alert). Across all 92 files, ~28.6% of rows are `ALERTA`.

A couple of rows contain garbage values (e.g. `@` where a temperature should be) — the loader
in `../../scripts/train_model1_milk.py` coerces and drops those.

## Used by

`scripts/train_model1_milk.py` — trains Model 1 (Isolation Forest) on `ACEPTABLE`-only rows
from a 70% split of sessions, evaluates recall/FPR/ROC-AUC on the held-out 30% of sessions
(both their normal and `ALERTA` rows). See `scripts/README.md` for current results.

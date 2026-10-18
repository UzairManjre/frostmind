# FROSTMIND — supplementary datasets

External data used to validate Model 1 (anomaly detector) and source Model 3 (shelf-life)
constants, per `../FROSTMIND_MVP_Implementation_and_AI_Plan (1).md`, while the MVP's own
logged sessions are still thin on induced-anomaly data. Training/eval scripts that consume all
of this live in `../scripts/` — see `../scripts/README.md` for how to run them and current results.

| Folder | Real or simulated | Used for |
|---|---|---|
| `NAB_machine_temperature/` | Real — genuine machine failure, the field's standard benchmark | Model 1 checkpoint |
| `kaggle_cold_chain_milk/` | Real — genuine per-row alert labels | Model 1 checkpoint |
| `kaggle_cold_chain_shipment_silent_failure/` | **Simulated** — corrects the original "real failure labels" framing, see its README | Model 1 checkpoint |
| `kaggle_iot_temperature/` | Real, but **unlabeled** | EDA only, no model |
| `references/` | N/A — citation only | Backs Model 3's simulation-first framing and shelf-life kinetics |
| `frostmind_logs/` | Real, once you log it — **empty for now** | Model 1, once hardware logs exist |
| `product_catalog/` | Real public storage tables (USDA HB66, Engineering ToolBox, McGregor/USDA AH-668, VT Extension) + cited regulatory bands; cleaned by `scripts/build_product_catalog.py` | Models 4 & 5 (Load Planner) — see its README |

Model 2 (root-cause classifier) has no data folder here — it needs the INA219 power-draw
signal, which is explicitly deferred hardware, not something any of these datasets can
substitute for.

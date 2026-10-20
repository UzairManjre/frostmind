# Product catalog: data for Model 4 (mixed-load setpoint) and Model 5 (co-shipment compatibility)

Everything in this folder is either a **raw snapshot of a public source** (`raw/`) or **generated from those snapshots** by a script. Nothing here was typed in by hand, except `raw/non_produce_manual.csv`, which has a citation on every row. Rebuild it all with:

```
.venv\Scripts\python.exe scripts\fetch_product_data.py            # download raw/*.html (+ SHA-256 in raw/SOURCES.json)
.venv\Scripts\python.exe scripts\build_product_catalog.py         # clean + merge -> product_catalog_clean.csv, cleaning_report.json
.venv\Scripts\python.exe scripts\estimate_reefer_fluctuation.py   # real sigma from the milk dataset -> reefer_fluctuation.json
```

## Sources

| # | File in `raw/` | Source | What it contributes |
|---|---|---|---|
| S1 | `S1_engineeringtoolbox_fruits_vegetables.html` | Engineering ToolBox, *Fruits and Vegetables – Optimal Storage Conditions* | Main produce features: temperature range (°F), chill point, freezing point, RH, **ethylene production and sensitivity**, storage life (125 rows) |
| S2 | `S2_umaine_bulletin_4135.html` | UMaine Extension Bulletin 4135, which reproduces **USDA Agriculture Handbook 66** (Hardenburg, Watada & Wang) | Cross-check of S1 (agreement statistics), gap filling, and the HB66 **"lowest safe temperature" chilling-injury table** |
| S3 | `S3_fao_mcgregor_compatibility_groups.html` | FAO *Small-Scale Postharvest Handling Practices* ch. 7, reproducing **McGregor 1989, USDA Agricultural Handbook 668** | The 7 mixed-load compatibility groups. These are **Model 5's expert labels** and Model 4's external validation. Never used as features. |
| S4 | `S4_vt_extension_348-960_food_storage.html` | Virginia Tech Extension pub. 348-960 (USDA FoodKeeper-style storage times) | Refrigerated and frozen shelf life for dairy, eggs, meat, poultry, seafood and frozen foods |
| — | `non_produce_manual.csv` | FDA Food Code 2022 (≤5 °C TCS cold holding; ≤7 °C shell eggs), CDC Vaccine Storage & Handling Toolkit (2–8 °C; −50 to −15 °C; −90 to −60 °C), USP ⟨659⟩ | Temperature bands for the 35 non-produce products. The agencies' sites block scripted downloads (HTTP 403), and each band is one regulatory number, so these rows are hand-entered with a per-row citation. |

## Outputs

| File | What |
|---|---|
| `product_catalog_clean.csv` | **155 products** (120 produce, 35 dairy/eggs/meat/poultry/seafood/frozen/pharma), 24 columns. Schema below. |
| `cleaning_report.json` | Every cleaning step with row counts, duplicate conflicts, S1-vs-HB66 agreement, McGregor matching, imputation counts, validation result |
| `reefer_fluctuation.json` | Per-session temperature σ from the real milk-transport logs (normal vs. excursion sessions), plus the default σ |
| `compatibility_pairs_labelled.csv` | Model 5 training pairs (both products McGregor-labelled): features + label |
| `mixed_load_scenarios_{train,test}.csv.gz` | Model 4's simulated mixed loads (real products, real σ), labelled by the physics teacher, with a product-disjoint split |

## Schema of `product_catalog_clean.csv`

| Column | Meaning |
|---|---|
| `product_id`, `name` | Slug and display name |
| `category` | fruit / vegetable / dairy / eggs / meat / poultry / seafood / frozen / pharma |
| `frostmind_category` | Which of FROSTMIND's 6 device categories it belongs to (links to Model 3's constants) |
| `safety_class` | produce / ready_to_eat / raw_animal / frozen / pharma. Drives the policy vetoes |
| `t_min_c`, `t_max_c`, `t_opt_c` | Recommended storage range (°C). `t_opt` is the midpoint |
| `rh_min`, `rh_max` | Recommended relative humidity (%) |
| `freeze_point_c` | Highest freezing point (°C) |
| `chilling_sensitive`, `chill_threshold_c` | Chilling-injury flag and limit (HB66 lowest safe temperature, else the S1 chill point) |
| `shelf_life_days` | Storage life at recommended conditions (geometric midpoint of the published range) |
| `q10` | Temperature coefficient, derived from Model 3's activation energy for the product's FROSTMIND category |
| `ethylene_production` | 0 none, 1 very low, 2 low, 3 medium, 4 high |
| `ethylene_sensitivity` | 0 no, 1 yes, 2 very |
| `hard_lo_c`, `hard_hi_c` | Regulatory hard limits (pharma band, FDA ≤5 °C, frozen ≤ −17.8 °C) |
| `compat_groups` | McGregor group set, e.g. `1;2` (**label column**) |
| `source`, `source_url`, `notes` | Provenance |
| `imputed_fields` | Every value that was not read directly from the product's own row, and where it came from |

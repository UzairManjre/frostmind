# FROSTMIND — AI Models, Simple Overview

Five components. For each: what kind of model it is, what it uses as input, how it was trained (method + score), and how we use it (or would).

---

## Model 0 — Threshold Rule (on-device)

- **Type:** Deterministic rule, not ML.
- **Uses:** Rolling temperature slope (rate of change over last 6 readings), deviation from setpoint, door-open duration. Computed on the ESP32 every ~2 seconds.
- **Training:** None needed — it's fixed logic, no dataset required.
- **How we use it:** Runs live on the ESP32 right now. When it trips, it fires the paired IR command at the AC (power on, cool, fan high), with a 5-minute cooldown so it doesn't spam. **This is the only component allowed to trigger a physical action today.**

---

## Model 1 — Anomaly Detector

- **Type:** Unsupervised ML — Isolation Forest (`scikit-learn`).
- **Uses:** Rolling mean temp, rolling std, rate of change, door-open duration (10-reading window).
- **Training:** Trained only on normal (non-anomalous) data, `contamination=0.02`. Validated on 4 outside datasets:

  | Dataset | Real/simulated | Accuracy | ROC-AUC |
  |---|---|---|---|
  | NAB machine-temperature | Real | 85.6% | 0.770 |
  | Kaggle cold-chain milk | Real | 83.8% | 0.851 |
  | Kaggle shipment failure (semi-supervised) | Simulated | 74.2% | 0.809 |
  | Kaggle shipment failure (supervised, RandomForest) | Simulated | 82.3% | 0.913 |

- **How we use it:** Built and validated, but **not turned on yet** against our own sensor data — it needs real logged sessions from our hardware first, and we haven't collected any. Model 0's threshold rule is doing this job live in the meantime.

---

## Model 2 — Root-Cause Classifier

- **Type:** Not built. Would be a supervised ML classifier.
- **Uses:** Would need AC power-draw data (from an INA219 current sensor) — not installed on our hardware.
- **Training:** None — no sensor, no dataset exists for this signal.
- **How we'd use it:** Would explain *why* an alert happened — compressor fault vs. door left open vs. power cut — instead of just flagging that something's wrong. On hold until the hardware is sourced.

---

## Model 3 — Shelf-Life Estimator

- **Type:** Physics formula (Arrhenius chemical kinetics), not ML.
- **Uses:** A shipment's full temperature history + its product category.
- **Training:** None needed — it's math, using standard published constants for 6 product categories (vaccines, milk, produce, meat, frozen food, seafood).
- **How we use it:** Runs live on every reading. Outputs % of shelf life used and hours remaining, shown on the dashboard.

---

## LLM Layer — Local Reasoning

- **Type:** Local LLM (quantized Gemma model via Ollama) — pretrained, not trained by us.
- **Uses:** The outputs of the models above (the alert, shelf-life %, recent readings) as text input.
- **Training:** None — we only prompt it, no fine-tuning.
- **How we use it:** Runs in the background after every alert, writes a plain-English explanation + recommended action onto the dashboard, and generates a compliance report on request. **Never controls anything itself** — read-only explanation for a human.

---

## Model 4: Mixed-Load Setpoint Recommender ("ideal temperature for several products at once")

- **Type:** A physics-informed optimizer (the "teacher") plus a trained ML regressor (the "student", `HistGradientBoostingRegressor`) distilled from it.
- **Uses:**
  - the products in one compartment and their kg;
  - each product's storage range, chilling limit, freezing point, shelf life and Q10, from a new 155-product catalog built from USDA Handbook 66, Engineering ToolBox, VT Extension, FDA, CDC and USP;
  - the truck's temperature wobble σ, measured from real reefer logs.
- **Training:** 16,000 simulated mixed loads of real products, each labelled by the teacher, tested on 4,000 loads made only of products the student never saw.
  - Result: **MAE 0.16 °C, R² 0.999, 93.6% within ±0.5 °C.** The rule baselines score MAE 1.3–1.4 °C.
  - External check against USDA's published McGregor group temperatures: it agrees for the cold groups; for some warm groups the published sources themselves disagree.
- **How we use it:** `POST /planner/plan` and the admin panel's **Load Planner** page give each compartment's recommended setpoint.
  - The ML answer is served only if it agrees with the physics optimizer to within 0.5 °C (guarded ML).
  - The planner also names the nearest FROSTMIND device category that the ESP32 can apply, or warns if none is close.

## Model 5: Co-Shipment Compatibility Classifier ("which products can ship together")

- **Type:** Supervised ML: a random-forest classifier (`scikit-learn`) over 13 physical pair features (temperature overlap, humidity, ethylene producer × sensitive, chilling and freezing risk, …).
- **Uses:** Any two products from the catalog.
- **Training:** 5,671 produce pairs labelled by USDA expert compatibility groups (McGregor 1989, Agricultural Handbook 668). It is evaluated on products it never saw, over 30 random splits.
  - Result: **ROC-AUC 0.930, accuracy 86.7%, F1 0.822, MCC 0.717**, against 0.84 AUC for the best hand-written rule.
- **How we use it:**
  - the Load Planner scores every pair of an order;
  - regulatory vetoes are added on top (medicines never with food; raw meat apart from ready-to-eat food);
  - the order is split into compatible compartments with graph colouring (DSatur);
  - every "keep apart" comes with a plain-English reason.

Full details: `FROSTMIND_Model4_Model5_Submission.md` / `.docx`.

# FROSTMIND backend

FastAPI + SQLAlchemy backend for FROSTMIND Phase 2 (see `../FROSTMIND_Phase2_Implementation_Plan.md`
§2, §6 Phase B). Implements the `Device` / `Truck` / `Shipment` / `SensorReading` / `Alert` / `User`
data model, the device-registration + auto-pairing lifecycle, shipment CRUD, the batched
`/ingest` endpoint (device-key auth + device-threshold-flag persistence + Model 3 shelf-life
update + configurable alert thresholds + optional GPS), fleet-wide analytics, and admin-panel
reads (fleet view, alerts feed, report export).

**This pass implements `FROSTMIND_Prototype_to_Production_Plan.md`'s Phase A3, the Model 1 seam,
and the backend half of Phase B** -- device-key auth on `/ingest`, a pytest suite, structured
JSON logging, Model 1's self-activating seam (still inactive -- see below), configurable
per-shipment alert thresholds, `GET /analytics/fleet`, and GPS field plumbing. See the dedicated
sections below for each; the "Deviations from the plan doc" list right below covers what
predates this pass.

## Deviations from the plan doc

1. **SQLite instead of PostgreSQL.** The plan's stack table (§2.3) calls for Postgres; this
   environment has no Postgres server available, so `DATABASE_URL` defaults to a local SQLite
   file (`backend/frostmind.db`, created automatically on first run). All models and queries go
   through the SQLAlchemy ORM only -- no raw SQL, no SQLite-specific functions/types anywhere in
   `app/` -- so switching to Postgres later is a one-line change:
   ```
   set FROSTMIND_DATABASE_URL=postgresql+psycopg2://user:pass@host/dbname
   ```
   (or edit `app/config.py`'s default). Nothing else in the codebase needs to change.

2. **Model 1 status: not wired up to live `/ingest` scoring at all -- see the dedicated section
   below.** This is the biggest deviation from the task's original instructions (which suggested
   defaulting to `model1_isolation_forest_shipment.pkl`) and deserves the detail given below
   rather than a one-line note.

3. **Auth boundaries are pragmatic, not strictly "everything behind JWT".** The plan's setup
   wizard (§4) has no login step -- a driver registers a device and starts a shipment without
   ever authenticating as the admin user. So: `POST /auth/login`, device registration/pairing,
   and truck/shipment create+update are left **unauthenticated** (device-facing, field-facing);
   the **admin-panel read endpoints** (`GET /shipments`, `GET /shipments/{id}`,
   `GET /shipments/{id}/readings`, `GET /shipments/{id}/alerts`, `GET /shipments/{id}/report`,
   `GET /alerts`, `GET /analytics/fleet`) require a JWT bearer token from `/auth/login`.
   **`POST /ingest` is the one exception, and as of this pass it now requires device auth** (plan
   §2 A3) -- see "Device auth on /ingest" below. Every other field-facing endpoint stays
   deliberately open, since only `/ingest` writes sensor data on behalf of a specific device.

4. **`door:true` polarity assumption.** The BLE/ingest contract only specifies a boolean field
   named `door` with no documented sign, and firmware is being built by a separate agent with no
   shared channel to confirm it. This backend assumes `door:true` means **door open** (see
   `DOOR_TRUE_MEANS_OPEN` in `app/config.py`) -- if the real firmware sends the opposite
   convention, flip that one constant; nothing else needs to change.

5. **Report export is CSV, not PDF.** Simplest reliable dependency-free format for a downloadable
   audit trail; a PDF renderer was judged not worth the added dependency weight for an MVP.

## Device auth on `/ingest` (plan §2 A3)

`Device.provisioning_key` was already generated at registration and returned once in
`DeviceOut.provisioning_key` (`POST /devices/register`) -- it just wasn't checked anywhere. As of
this pass it is enforced on `POST /ingest`:

- Every `/ingest` call must include a header **`X-Device-Key: <provisioning_key>`** matching the
  resolved device's stored key.
- Missing header, empty header, or a key that doesn't match that specific device -> **`401`**
  (`{"detail": "Missing or invalid X-Device-Key header"}`), logged as a structured
  `device_auth_rejected` event (see "Structured logging" below) with the reason
  (`missing_header` / `key_mismatch`).
- Device resolution (`device_mac`/`device_id` -> 404 if unknown) happens *before* the key check,
  same as before -- an unregistered device still gets `404`, not `401`, since there's no key to
  check against yet.
- No other endpoint changed. Device registration, truck/shipment create+update stay open per
  deviation #3 above -- this is the one write path that acts on behalf of a specific device, so
  it's the one that gets a device-scoped check.
- The phone-bridge is expected to send this exact header, with the value it received once at
  registration time (`ctx.device.provisioning_key` on its side) -- see
  `backend/tests/test_device_auth.py` for the enforced contract (valid key passes; missing/wrong
  key gets `401`; another device's valid key against this device also gets `401`).

## Model 1 status (read this before touching `/ingest`'s alerting)

**No pre-trained `models/model1_*.pkl` is loaded or scored against live `/ingest` telemetry.**
This was an explicit correction made mid-build (see `app/ml.py`'s module docstring for the full
version) after re-examining what each `.pkl` was actually trained on. Two separate, independent
problems rule all four of them out, not just one:

1. **Feature-schema mismatch.** `model1_isolation_forest_shipment.pkl` and
   `model1_random_forest_shipment_supervised.pkl` (`scripts/train_model1_shipment*.py`) are
   trained on 22 **session-level aggregate** features computed over an entire *completed*
   multi-day shipment (`transit_days`, `temp_mean_c`/`max_c`/`min_c`/`std_c`, `door_opens`,
   `carrier_id`, `origin_zone`, `vibration_index`, `feature_x1..3`, ...) -- not the per-reading
   stream `/ingest` actually receives every ~2s. Several of those columns (carrier ID,
   origin/destination zone, vibration index, 3 unnamed latent features) have no corresponding
   real signal anywhere in this system at all; scoring live data against this model would mean
   fabricating most of its input vector.

2. **Temperature-domain mismatch -- the less obvious one, and the reason the *rolling-window*
   models are ALSO unsuitable.** `model1_isolation_forest_milk.pkl` /
   `model1_isolation_forest_nab.pkl` (`scripts/train_model1_milk.py`,
   `scripts/train_model1_nab.py`) do use a shape-compatible rolling-window feature set
   (`roll_mean`, `roll_std`, `rate_of_change`) -- an earlier version of this backend actually
   used the milk one on exactly that reasoning. But `roll_mean` is a **raw Celsius value**, and
   `IsolationForest` has no notion that -18C (`frozen_food_generic`) and 5C (`vaccine_generic`)
   are both "normal for their own category" -- its entire training distribution sits in one
   narrow band (milk-transport temperatures, roughly 0-15C). Scoring any of FROSTMIND's other 5
   product categories against it would flag effectively **every reading** as anomalous by
   construction, not because anything is actually wrong. That's a worse failure mode than not
   scoring at all: a dashboard that's confidently wrong is more dangerous than one that's
   honestly not running yet.

**What's actually running instead:** per the MVP plan's own staging (§2/§4: *"Right now: no
trained model. A threshold rule... The MVP's real job, beyond the demo, is to generate that
first dataset"*), the ESP32 firmware's own on-device rate-of-change/deviation threshold rule --
surfaced as the `alert` boolean already present in every BLE reading -- **is** the system's real
current detection mechanism. `POST /ingest` (`app/routers/ingest.py`) persists that flag
directly: `SensorReading.is_anomaly = bool(device_reported_alert)`, and creates an `Alert` row
(type `anomaly`, severity `medium`, `model1_score` left `null`) the first time it goes true in a
cooldown window, with a message that says plainly it's a device-rule alert, not Model 1 output.
This is a deliberate scoping decision, documented here so it isn't silently passed off as more
than it is -- not a bug or an oversight.

**The seam, as of this pass, is HOT (self-activating) but still genuinely inactive -- these are
not in tension.** "Hot" means wired into the request path so it needs zero further code changes;
it does not mean a model is running, because none exists yet. Concretely:

- `app/ml.py`, at **import time**, checks whether `models/model1_isolation_forest_frostmind.pkl`
  exists on disk. It doesn't (verified freshly in this pass -- see "Verified in this pass"
  below), so `MODEL1_ACTIVE = False` and `score_with_model1()` returns `(None, None)`, exactly as
  before.
- `app/routers/ingest.py` now **calls** `score_with_model1()` on every reading once a full
  10-reading rolling window of history exists (matching `scripts/train_model1_frostmind.py`'s
  `WINDOW=10`), computing the same `roll_mean`/`roll_std`/`rate_of_change`/`door_open_dur`
  features that script trains on. Today this call is a no-op round trip (always gets back
  `(None, None)`), so `is_anomaly`/`anomaly_score`/alert-creation behavior is **byte-for-byte
  unchanged** from before this pass.
- The day a real `models/model1_isolation_forest_frostmind.pkl` exists (dropped in by
  `scripts/train_model1_frostmind.py` after real hardware sessions are collected and labeled --
  see below) and the backend is restarted, `app/ml.py` loads it automatically and every
  subsequent `/ingest` call actually scores against it -- **no code changes anywhere**, not in
  `app/ml.py`, not in `app/routers/ingest.py`. `GET /health`'s `model1_status` and each
  Alert's message text both flip to reflect this automatically too (see `MODEL1_ACTIVE`).
- `backend/tests/test_model1_seam.py` proves both halves: (a) the real current state (no pkl ->
  `MODEL1_ACTIVE is False`, `score_with_model1()` stays `(None, None)`), and (b) the
  loading/scoring *mechanism* itself works, using a throwaway synthetic `IsolationForest` written
  only to a pytest `tmp_path` -- **not** a real trained Model 1, never written under `models/`.

**What still needs a human, and can't be shortcut:** a real `.pkl` needs
`data/frostmind_logs/frostmind_log.csv`, which needs real hardware sessions -- a normal baseline
run plus 5-10 induced-anomaly clips (door held open, hairdryer near the sensor, AC unplugged),
physically run with the phone-bridge + backend live, per
`FROSTMIND_MVP_Implementation_and_AI_Plan.md` §4. That has NOT happened as of this pass. Two new
pieces exist to make that step easier once someone does run those sessions, but neither invents
the sessions themselves:

1. **`scripts/export_frostmind_log.py`** (new) -- reads `SensorReading` rows straight from the
   SQLite DB and writes them into the exact CSV schema
   `scripts/train_model1_frostmind.py` expects (`ts, temp, humidity, door, rate_of_change,
   session_label`). `session_label` is a human, session-level judgment (this run was "normal" vs.
   "which anomaly was induced") that cannot be inferred from the data -- pass `--label` to stamp
   one export batch's rows with a single label, or leave it blank and fill it in by hand before
   combining sessions. `--shipment-id` and `--append` let you export one session (one shipment)
   at a time and combine them into one training CSV. See the script's own docstring for the full
   workflow. Verified against the real dev DB (read-only; 1801 pre-existing readings exported
   correctly, `--label`/`--append`/missing-DB-file behavior all checked) -- see "Verified in this
   pass" below.
2. **`app/ml.py`'s self-activating load**, described above.

| Model | Status |
|---|---|
| Model 1 (anomaly detector) | **Seam is hot, model is not loaded.** `score_with_model1()` is called on every `/ingest` reading and will score for real the moment `models/model1_isolation_forest_frostmind.pkl` exists (`app/ml.py`'s `MODEL1_ACTIVE`); today it still returns `(None, None)`, so live alerts still come entirely from the device's own threshold-rule flag (see above) plus the configurable-threshold-override check (see below). |
| Model 3 (shelf life) | Active. `scripts/model3_shelf_life.py` imported directly (not reimplemented), called with the shipment's assigned category (`PRODUCT_LIBRARY` key) and its full accumulated temperature/time history on every `/ingest` batch. |

## Data model

`app/models.py` -- SQLAlchemy 2.0 declarative models: `User`, `Device` (with pairing-lifecycle
fields), `Truck`, `Shipment` (with `shelf_life_consumed_fraction` / `shelf_life_remaining_hours`,
refreshed every ingest, plus the new **`alert_rate_threshold_override`** /
**`alert_deviation_threshold_override`** nullable floats -- see "Configurable alert thresholds"
below), `SensorReading` (with `anomaly_score` populated by `score_with_model1()` when active --
currently always `null`, see "Model 1 status" -- `is_anomaly` reflecting device-flag / Model 1 /
threshold-override sources combined, and new nullable **`lat`** / **`lng`** GPS columns), `Alert`.

## Configurable alert thresholds (plan §4, backend half)

`Shipment.alert_rate_threshold_override` and `Shipment.alert_deviation_threshold_override`
(both `float | None`, default `null`) are settable via `PATCH /shipments/{id}` (extended request
schema, no new endpoint). Behavior:

- **Both null (the default -- unchanged from before this pass):** `/ingest`'s alert logic is
  exactly what it always was -- device-reported `alert` flag (+ Model 1 once active) only.
- **`alert_deviation_threshold_override` set:** a reading whose `temp_c` differs from the
  shipment's category reference temperature (`PRODUCT_LIBRARY[category].reference_temp_c`) by
  more than the override (in °C) is *also* flagged anomalous.
- **`alert_rate_threshold_override` set:** a reading whose `|rate_of_change|` exceeds the
  override is *also* flagged anomalous.
- Either source, when it fires, shares the same `AlertType.anomaly` bucket and the same
  `DEVICE_ALERT_COOLDOWN_SECONDS` (60s) cooldown as device-flagged/Model 1 alerts -- deliberately
  one "something's wrong" cooldown, not one per source, matching the existing cooldown design.
  The Alert's `message` names exactly which source(s) fired (e.g.
  `"Anomaly alert [device-rule, deviation-override(|9.0C - ref| > 2.0C)]"`), so nothing is ever
  ambiguous about why an alert exists.
- Verified live (see "Verified in this pass"): PATCHing `alert_deviation_threshold_override` from
  null to `2.0` measurably changes `/ingest`'s behavior for the exact same input reading (0 alerts
  -> 1 alert), and the reverse (rate override below the actual rate -> no alert) also holds.

## Fleet analytics (plan §4, backend half)

**`GET /analytics/fleet?days=30`** (default 30, admin-JWT-protected like the other admin-read
endpoints) -- aggregates real `Alert`/`Shipment`/`Truck` data over the trailing N days:

```json
{
  "period_days": 30,
  "total_alerts": 0,
  "by_type": [{"type": "anomaly", "count": 0}],
  "by_truck": [{"truck_id": "...", "truck_label": "...", "alert_count": 0}],
  "shipments_active": 0,
  "shipments_completed": 0
}
```

Design notes (see `app/routers/analytics.py`'s module docstring for the same reasoning inline):

- `total_alerts` / `by_type`: count of `Alert` rows with `ts >= now - days`. `by_type` always
  includes **every** `AlertType` (`anomaly`, `shelf-life-threshold`, `door-open-too-long`), even
  with a `0` count, so callers get a stable set of keys rather than conditionally handling
  missing categories.
- `by_truck`: every truck currently in the fleet (`0` if no alerts in the period), sorted by
  `alert_count` descending -- trucks with a clean record are visibly present, not omitted.
- `shipments_active` is a live snapshot (`status == "in-transit"` right now), not time-boxed by
  `days` -- "how many shipments are on the road right now" isn't a trend.
- `shipments_completed` IS trend-scoped: shipments marked `delivered` (`end_time` set) within the
  trailing `days` -- "how many shipments wrapped up this month."

## GPS field plumbing (plan §5's correction: phone Geolocation API, not new hardware)

`SensorReading.lat` / `SensorReading.lng` (both `float | None`) are accepted optionally on each
reading object in `POST /ingest`'s `readings` array (`lat`/`lng` fields on `ReadingIn`, mirroring
the phone-bridge's Geolocation API contract -- omitted/`null` when permission is denied or a fix
isn't available, never required). `GET /shipments` (the fleet view) now includes each shipment's
**`latest_lat`** / **`latest_lng`** -- the most recent reading that actually carries a non-null
GPS fix, which may not be the literal latest reading (that one might itself lack GPS). Both stay
`null` if no reading for that shipment has ever carried GPS. This lets the web app render a map
without a second round trip. `SensorReadingOut` (the raw per-reading schema) and the CSV report
also carry `lat`/`lng` through for completeness.

## API surface

- `POST /auth/login`, `GET /auth/me`
- `POST /devices/register`, `GET /devices`, `GET /devices/{id}`, `PATCH /devices/{id}`
- `POST /devices/{id}/pairing/start` -- marks pairing state `scanning` (the actual BLE
  `{"cmd":"start_pairing"}` write happens phone-side; the backend has no BLE radio)
- `POST /devices/{id}/pairing/status` -- phone bridge relays observed `pairing_status` BLE TX
  notifications here so the admin panel can poll pairing progress without its own BLE connection
- `GET /devices/{id}/pairing/status`
- `POST /trucks`, `GET /trucks`, `GET /trucks/{id}`, `PATCH /trucks/{id}`
- `POST /shipments`, `GET /shipments` (fleet view, joined
  truck/device/latest-reading/latest-GPS-fix/open-alert-count), `GET /shipments/{id}`,
  `PATCH /shipments/{id}` (now also accepts `alert_rate_threshold_override` /
  `alert_deviation_threshold_override`), `GET /shipments/{id}/readings`,
  `GET /shipments/{id}/alerts`, `GET /shipments/{id}/report` (CSV, now includes `lat`/`lng`
  columns)
- `POST /ingest` -- batched `SensorReading` ingest. **Requires header `X-Device-Key:
  <provisioning_key>`** matching the resolved device (401 if missing/wrong -- see "Device auth on
  /ingest" above). Persists the device's threshold-rule `alert` flag, Model 1's score when active
  (currently always inactive -- see "Model 1 status"), and configurable-threshold-override checks
  (see above) all into `is_anomaly`/`anomaly_score`; updates Model 3 shelf-life-consumed for the
  shipment; creates `Alert` rows for anomalies (any of the three sources), door-open-too-long, and
  shelf-life-threshold crossings (rate-limited with a cooldown so one long flagged/door-open
  stretch in a batch doesn't spam dozens of duplicate alerts); accepts optional `lat`/`lng` per
  reading
- `GET /alerts` (fleet-wide feed, filterable by `type`/`acknowledged`), `PATCH /alerts/{id}`
  (acknowledge)
- `GET /analytics/fleet?days=30` -- fleet-wide alert/shipment trends (admin-JWT); see "Fleet
  analytics" above
- `GET /categories` -- the 6 `PRODUCT_LIBRARY` categories, for the setup wizard's dropdown
- `POST /shipments` also accepts `products: [{product_id, quantity_kg}]` instead of `category` -- a
  mixed load: checked by Model 5 + policy vetoes (422 with the groups if they can't share one
  compartment), Model 4's setpoint stored; `/ingest` then tracks shelf life per product and flags
  readings more than 3 C from that setpoint
- `GET /shipments/{id}/live` -- phone dashboard feed, authorised with that truck's device
  `X-Device-Key`: shipment (incl. per-product shelf life + setpoint), latest reading, last 5 alerts
  with LLM explanations, AI status
- `GET /ai/status` -- every AI component's live status, measured scores and usage counts (public);
  `POST /ai/llm/test` -- admin-JWT one-click LLM round trip (reply, model, latency)
- `GET /products` -- the 155-product Load Planner catalog (public reference data, like `/categories`)
- `POST /planner/plan` -- public (pure calculation; the phone wizard uses it). Takes `{products:[{product_id, quantity_kg}], truck_id?, sigma_c?}` and returns pairwise compatibility (Model 5 probability, policy vetoes, reasons), the compatible groups, and each group's recommended setpoint (Model 4, guarded by the physics optimizer) plus the nearest FROSTMIND device category. See "Load Planner" below.
- `GET /health` -- `model1_status` honestly reflects whether a real Model 1 `.pkl` was found and
  loaded at startup (`"active (scoring live /ingest readings)"` vs.
  `"not-yet-wired (device threshold rule is the live anomaly signal)"`) -- never overclaims

Interactive docs at `http://127.0.0.1:8000/docs` once running.

## Load Planner (Models 4 and 5)

`app/load_planner.py` serves the two models behind `POST /planner/plan`. The admin panel's **Load Planner** page (`web/src/app/planner/page.tsx`) is the UI.

- **Shared code, no skew.** All features, physics and grouping come from `scripts/common/products.py`, imported via `SCRIPTS_DIR` the same way `app/ml.py` imports `model3_shelf_life`.
- **Graceful loading.** This follows the `_load_model1()` pattern. `models/model4_mixed_setpoint.pkl` and `models/model5_compatibility.pkl` are looked up once at import time.
  - If Model 5 is missing, pairs are judged by the policy vetoes, the feasibility check, and the rule "optimal temperatures within 2 °C", with `probability: null`.
  - If Model 4 is missing, setpoints come from the physics optimizer (`method: "physics"`).
  - `/health` reports `model4_status` / `model5_status` honestly.
- **Guarded ML.** The Model 4 student's setpoint is clipped into the chance-constrained safe range. If it differs from the physics optimizer by more than `MODEL4_MAX_DISAGREEMENT_C` (0.5 °C), the optimizer's answer is served instead (`method: "physics_fallback"`).
- **Policy is not ML.** "Medicines never with food" (WHO/EU GDP) and "raw animal food apart from produce/ready-to-eat" (FDA Food Code 3-302.11) are hard vetoes applied on top of Model 5. They were never used as training labels.
- **σ (reefer fluctuation)** is chosen in this order:
  1. the request's `sigma_c`;
  2. the std of the truck's last 500 readings (needs ≥30);
  3. the real-data default in `data/product_catalog/reefer_fluctuation.json`.
- **Device mapping.** Each group reports the nearest of the 6 firmware categories, which the ESP32 applies through BLE `set_category`, plus `device_category_within_1c`. If no category is within 1 °C (e.g. bananas at 13.5 °C), the response warns that the setpoint must be set manually, instead of pretending the device can apply it.
- **Tests:** `tests/test_products.py` covers the physics sanity targets, feature symmetry, the label-leakage guard, DSatur and the student's shift-invariance. `tests/test_planner.py` covers the API behaviour and the no-pkl fallback.

## Tests

`backend/tests/` -- pytest + FastAPI's `TestClient`, against a throwaway temp-file SQLite DB
(`conftest.py` points `FROSTMIND_DATABASE_URL` at a fresh `tempfile.mkstemp()`-created file
*before* `app.database`/`app.main` are ever imported, so the real dev `backend/frostmind.db` is
never touched -- verified by hashing it before/after the full suite ran). Tables are dropped and
recreated (and the default admin re-seeded) before every test function, so tests never see
leftover state from each other.

```bash
cd backend
..\.venv\Scripts\python.exe -m pip install -r requirements.txt   # adds pytest
..\.venv\Scripts\python.exe -m pytest tests/ -v
```

22 tests, all passing as of this pass:

| File | Covers |
|---|---|
| `test_device_auth.py` | §1: valid `X-Device-Key` passes, missing/wrong key gets 401, one device's key rejected against another device |
| `test_ingest_alerts.py` | Device-flagged alert creation + the exact cooldown bug fixed earlier today (a 10-reading/20s flagged run must create exactly 1 alert, not 10), a second alert after the cooldown window, door-open-too-long firing at the 120s threshold, and a clean baseline batch producing zero alerts |
| `test_shelf_life.py` | Model 3 is actually invoked from `/ingest` and updates the shipment row -- cross-checked numerically against `scripts/model3_shelf_life.py`'s own function with the exact same inputs (not just "some value came back") |
| `test_thresholds.py` | Deviation/rate threshold overrides are inert when null (current behavior unchanged) and measurably change alert behavior when set |
| `test_analytics.py` | `GET /analytics/fleet` requires admin auth, aggregates real seeded alert/shipment/truck data correctly (including the always-present-even-at-zero `by_type` keys), and respects the `days` window |
| `test_gps.py` | `latest_lat`/`latest_lng` fall back to the most recent reading that actually has a fix, not the literal latest reading |
| `test_model1_seam.py` | Real current state (`MODEL1_ACTIVE is False`, seam stays a no-op) plus the load/score *mechanism* itself, using a throwaway synthetic model in a pytest `tmp_path` (never written under `models/`, never claimed to be a real trained Model 1) |
| `test_error_logging.py` | An unhandled exception is caught by the global handler, turned into a clean 500, and logged as a structured `unhandled_request_error` JSON event |

## Structured logging (plan §3)

`app/logging_config.py` -- stdlib `logging` only (no new dependency), one JSON object per line to
stdout via `configure_logging()` (called once at import in `app/main.py`). Use
`log_event(logger, level, "short_event_name", **context)` for a consistent
`{ts, level, logger, message, ...context}` shape. Wired into:

- **Request handling errors** -- `app/main.py`'s `@app.exception_handler(Exception)` catches
  anything that isn't already an `HTTPException` (those keep FastAPI's normal 4xx handling),
  logs `unhandled_request_error` with `path`/`method`/`error`/`error_type`, and returns a clean
  `500 {"detail": "Internal server error"}` instead of leaking a stack trace.
- **`/ingest` alert creation** -- every `Alert` row created (anomaly, door-open-too-long,
  shelf-life-threshold) logs `alert_created` with `shipment_id`/`alert_type`/`severity` and
  source-specific context (e.g. `sources` for anomaly alerts, `open_duration_s` for door alerts).
- **Device-auth rejections** -- `device_auth_rejected` with `device_id`/`reason`.
- **Pairing state changes** -- `pairing_state_changed` with `device_id`/`from_state`/`to_state`,
  logged from both `POST /devices/{id}/pairing/start` and `POST /devices/{id}/pairing/status`.

Verified live (see "Verified in this pass"): ran the real server, hit it with the auth/threshold/
door-open/pairing scenarios above via `httpx`, and confirmed each expected JSON line actually
appeared in the process's stdout -- not just that the logging code exists.

## Run it

From the **project root** (`AIOT project/`), reusing the existing `.venv` (already has
numpy/pandas/scikit-learn/joblib/pytest installed):

```bash
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Or with a fresh venv:

```bash
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --reload
```

On first startup the app creates `backend/frostmind.db` (SQLite) and seeds a default admin user:

- email: `admin@frostmind.local`
- password: `frostmind-admin`

(Override via `FROSTMIND_ADMIN_EMAIL` / `FROSTMIND_ADMIN_PASSWORD` env vars before first run.)

## What was actually verified (not just written)

Ran `uvicorn app.main:app` on `127.0.0.1:8123` and drove the full flow with an `httpx` script:
health check -> `/categories` -> admin login -> `/auth/me` -> device register -> truck create ->
shipment create -> pairing start/status-push/status-get/matched -> mark shipment in-transit ->
two `/ingest` batches (a normal baseline, then one with an injected 4C->21C temperature spike
flagged `alert:true` by the simulated device, plus a 138s continuous door-open run) -> shipment
detail/readings/alerts -> fleet view -> fleet alerts feed -> alert acknowledge -> CSV report
download -> negative-path checks (401 on an unauthenticated admin-read call, 404 on `/ingest`
for an unregistered device).

Confirmed:
- Server boots clean, tables auto-create, admin user auto-seeds.
- The device-flagged batch (10 readings with `alert:true`) produces `is_anomaly=true` on exactly
  those readings, `anomaly_score=null` throughout (no model scored anything), and exactly 1
  `Alert` row (type `anomaly`, severity `medium`, message explicitly stating it's a device-rule
  alert and that Model 1 ML scoring isn't wired up) -- the other 9 flagged readings fall inside
  the 60s cooldown window, as intended. The normal baseline batch produces zero anomaly alerts.
- Model 3 (`scripts/model3_shelf_life.py`, imported unmodified) returns a sane
  `shelf_life_consumed_fraction` / `shelf_life_remaining_hours` for the `pasteurized_milk`
  category shipment and updates after every ingest batch.
- The door-open-too-long alert correctly fires once the continuous-open run passes 120s.
- `GET /health` reports `model1_status` honestly instead of naming a model that isn't running.
- `GET /shipments` etc. correctly return `401` without a bearer token; `/ingest` correctly
  returns `404` for an unregistered device.
- CSV report download returns `text/csv` with a populated readings + alerts section.
- **Bug found and fixed earlier in this verification process** (before the Model 1 scoping was
  corrected, but the underlying fix is unrelated to that and still applies): the door/anomaly
  alert cooldown originally re-queried the DB session mid-loop, which (with `autoflush=False`)
  couldn't see alerts added earlier in the same request -- a single batch with a long
  door-open/flagged stretch created a new alert on almost every reading instead of respecting
  the cooldown. Fixed by tracking the last-alert timestamp per type in memory across the loop,
  seeded once from the DB before it starts.

## Verified in this pass (device auth, tests, logging, Model 1 seam, thresholds, analytics, GPS)

Two layers, same as the original verification: the pytest suite (22 tests, all passing --
`..\.venv\Scripts\python.exe -m pytest tests/ -v` from `backend/`), and a *second*, independent
live run: started `uvicorn app.main:app` on `127.0.0.1:8199` against a **throwaway DB**
(`FROSTMIND_DATABASE_URL` pointed at a scratch file, specifically so the real dev
`backend/frostmind.db` -- which another session had open/locked at the time, confirming it's
actively in use elsewhere -- was never touched), then drove it with a fresh `httpx` script
covering every piece of new surface, independently of what the pytest suite already covers:

- Device auth: missing `X-Device-Key` -> 401, wrong key -> 401, correct key -> 200 and reading
  stored, one device's valid key rejected against a different device's `/ingest` call.
- Configurable thresholds: identical 9C reading against a `pasteurized_milk` shipment (4C
  reference) produced **0 alerts** with `alert_deviation_threshold_override` unset, then **1
  alert** (message containing `deviation-override(|9.0C - ref| > 2.0C)`) after `PATCH
  /shipments/{id}` set it to `2.0` -- confirms the override actually changes behavior, not just
  that the field exists.
- GPS: a 3-reading batch where only the middle reading carries `lat`/`lng` -> `GET /shipments`'s
  `latest_lat`/`latest_lng` correctly reported that middle reading's fix, not `null` (which a
  naive "just use the last reading" implementation would have returned).
- Door-open-too-long: 66 readings/130s continuous open -> exactly 1 alert at the 120s crossing.
- Fleet analytics: `GET /analytics/fleet` (both 401 without auth and 200 with it),
  `total_alerts`/`by_type`/`by_truck` all matched the real alerts just created via the calls
  above (1 deviation-override anomaly + 1 door-open-too-long, correctly attributed to the right
  truck), `shipments_active` reflected the real in-transit shipment.
- CSV report download still works and now includes `lat`/`lng` columns.
- Structured logging: grepped the live server's stdout and found real `device_auth_rejected`,
  `alert_created` (with the correct `sources` list), and -- via a separate pairing-endpoint call
  against the same live server -- `pairing_state_changed` (`idle`->`scanning`->`matched`) JSON
  lines, not just confirmed the logging code compiles.
- `scripts/export_frostmind_log.py` run directly against the real dev DB (read-only): exported
  1801 pre-existing readings correctly; `--label`/`--append` combined two labeled batches into
  one CSV without a duplicate header; pointing `--db` at a nonexistent file exits 1 with a clear
  message instead of a stack trace. The dev DB's contents were unaffected (the script only opens
  a read-only `sqlite3.connect` cursor).
- Unhandled-exception logging: a dedicated pytest test (`test_error_logging.py`) forces a real
  `RuntimeError` inside a request, asserts the response is a clean `500
  {"detail": "Internal server error"}`, and asserts the structured `unhandled_request_error` log
  record actually fired with the right `path`/`error_type`.
- Model 1 seam: confirmed live (`GET /health` -> `model1_status` starts with
  `"not-yet-wired"`) that `MODEL1_ACTIVE` is `False` against the real repo state (no
  `models/model1_isolation_forest_frostmind.pkl` on disk), and confirmed via
  `test_model1_seam.py` that the loading/scoring mechanism itself works correctly given a pkl
  (using a throwaway synthetic model in a pytest `tmp_path`, never written to the real `models/`
  directory or claimed to be a real trained model).

## Not verified (needs real hardware / a real deployment)

- Real BLE traffic from an actual ESP32 device, including whether its on-device threshold rule's
  `alert` flag behaves the way the synthetic test data assumed -- this backend only sees
  whatever the phone bridge (or a test script) POSTs to `/ingest`. See `../phone-bridge/README.md`
  for what's separately unverifiable there.
- Behavior at real fleet-scale reading volume -- `/ingest` reloads each shipment's full reading
  history on every batch to feed Model 3's exposure integral, which is fine at demo scale but
  would need pagination/windowing for a long-running production shipment.
- Postgres as the actual database (SQLite was used and verified; the ORM-only design is intended
  to make that swap safe, but it hasn't been run against a live Postgres instance here).
- Model 1 itself, obviously -- it isn't running. The *seam* is now hot and verified (see above),
  but a real trained `.pkl` needs real hardware sessions (normal baseline + 5-10 induced-anomaly
  clips) physically run with the phone-bridge + backend live, which has NOT happened as of this
  pass -- `scripts/export_frostmind_log.py` makes that step easier once someone does run those
  sessions, but doesn't (and shouldn't) shortcut it.
- Real device provisioning-key rotation/revocation -- `X-Device-Key` is now checked, but there's
  no endpoint to reissue/rotate a compromised key yet (would need a new `POST
  /devices/{id}/rotate-key`-style endpoint -- out of scope for this pass, which only closed the
  "not checked at all" gap named in the plan).
- Real GPS data from an actual phone's Geolocation API -- this backend only sees whatever
  `lat`/`lng` values land in `/ingest`'s payload; whether the phone-bridge actually calls
  `navigator.geolocation` and what accuracy/permission-denied behavior looks like in practice is
  the phone-bridge agent's side of this same plan item.
- `GET /analytics/fleet` at real fleet-scale alert volume -- current implementation loads the
  full period's `Alert` rows into memory to aggregate (`db.query(Alert).filter(...).all()`), fine
  at demo/pilot scale, would want a `GROUP BY` aggregate query at real volume.

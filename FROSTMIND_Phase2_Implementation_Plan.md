# FROSTMIND — Phase 2: Product Categories, Web Platform & Auto AC-Pairing Plan

This is the doc `FROSTMIND_MVP_Implementation_and_AI_Plan (1).md` already cross-references as
"full system architecture + long-term AI plan" but that didn't exist yet — this fills that gap,
and answers three new requirements directly: (1) at least 5 tracked product categories, (2) a
web platform with phone-mediated data transfer and an admin panel for fleet/package status, (3)
automatic AC protocol identification instead of a human confirming by eye. The MVP doc stays the
authoritative near-term hardware build order; this doc is what it grows into once that hardware
loop closes. `FROSTMIND_Hardware_BOM_and_Wiring.md` is still missing and out of scope here —
that's a wiring reference doc, not architecture.

---

## 0. Ground goals — what "done" means

| # | Goal | Acceptance criteria |
|---|---|---|
| **G1** | Track ≥5 product categories | Each category has an `ArrheniusProduct` entry (Ea, reference temp, rated shelf life) and is selectable per-shipment in the web app |
| **G2** | Web platform: phone-mediated data transfer + admin panel | A phone app pulls live sensor data off the ESP32 and forwards it to a backend; a separate admin web app shows every truck/shipment's live status, temp/humidity history, door events, anomaly flags, and shelf-life remaining |
| **G3** | Automatic AC/IR identification | The device identifies which AC protocol it's talking to without a human watching and pressing a key — using sensor feedback already on the board, no new hardware |
| **G4** | Web app setup flow | A guided onboarding screen: register device → pair phone → assign category → run auto-pairing → confirm live data → shipment goes live on the admin panel |

Everything below fills in the requirements needed to actually build G1–G4, including ones you
didn't spell out but the system can't work without (auth, offline buffering, alerting).

---

## 1. Product categories (G1)

Six categories — comfortably past the "at least 5" ask, covering the spread of perishability
profiles a cold-chain system actually needs to distinguish. Same Arrhenius model as the existing
3 (`vaccine_generic`, `pasteurized_milk`, `fresh_produce_generic`) — the 3 new ones
(`meat_poultry_chilled`, `frozen_food_generic`, `seafood_fresh_chilled`) have been added to
`scripts/model3_shelf_life.py`'s `PRODUCT_LIBRARY`, same illustrative-not-certified caveat as
the original 3.

| Category | Library key | Reference temp | Rated shelf life at ref temp | Notes |
|---|---|---|---|---|
| Pharma / vaccines | `vaccine_generic` | 5°C | ~180 days | existing |
| Dairy / milk | `pasteurized_milk` | 4°C | ~14 days | existing |
| Fresh produce | `fresh_produce_generic` | 3°C | ~10 days | existing |
| **Meat & poultry** | `meat_poultry_chilled` | 2°C | ~5 days | **new** — higher spoilage sensitivity than dairy |
| **Frozen food** | `frozen_food_generic` | -18°C | ~180 days | **new** — long rated life, but the model still penalizes any excursion above -18°C |
| **Seafood** | `seafood_fresh_chilled` | 0°C | ~2 days | **new** — most perishable of the six, shortest fuse |

Each shipment in the web app picks one of these six at setup — that selection is what
`model3_shelf_life.py` uses to compute % shelf-life consumed and remaining hours for that
specific package, not a global constant.

---

## 2. System architecture (G2)

Three tiers, because the device has no cellular modem and trucks can't be assumed to have WiFi:

```
ESP32-S3 (sensors + IR)  --BLE-->  Phone (PWA, driver-carried)  --HTTPS-->  Backend  --serves-->  Admin web app
     |                                    |                          |
  DHT sensor, reed switch,           buffers locally           Postgres: devices, trucks,
  IR TX, local ring buffer           if backend unreachable,   shipments, readings, alerts
  if phone unreachable               resyncs when it is        Model 1 + Model 3 inference
```

The phone is the gateway, not just a UI — it's carrying the cellular connection the ESP32
doesn't have. This is also the natural place for the setup wizard (G4) to live, since it's the
device the driver actually has in hand at the truck.

### 2.1 Data model

| Entity | Key fields |
|---|---|
| `Device` | id, esp32 MAC/serial, provisioning key, last-seen |
| `Truck` | id, plate/label, assigned device |
| `Shipment` | id, truck, category (one of the 6 above), status (pending/in-transit/delivered), start/end time |
| `SensorReading` | shipment, ts, temp, humidity, door state, rate-of-change |
| `Alert` | shipment, ts, type (anomaly / shelf-life-threshold / door-open-too-long), severity, Model 1 score |
| `User` | id, email, role (MVP: single `admin` role — see §7) |

### 2.2 Backend API surface (grouped, not exhaustive)

- `POST /devices/register`, `POST /devices/{id}/pairing/start`, `GET /devices/{id}/pairing/status` — auto-pairing lifecycle (§4)
- `POST /shipments`, `PATCH /shipments/{id}` (status, category) — setup wizard backing
- `POST /ingest` — phone bridge posts batched `SensorReading`s here; this is where Model 1 scores each window and Model 3 updates shelf-life-consumed for that shipment
- `GET /shipments`, `GET /shipments/{id}/readings`, `GET /shipments/{id}/alerts` — admin panel reads
- `GET /shipments/{id}/report` — exportable audit trail (compliance evidence — see §7)

### 2.3 Stack decisions (defaults chosen so this isn't blocked on a debate — swap freely)

| Layer | Choice | Why |
|---|---|---|
| Backend | Python + FastAPI | same language as `scripts/`, can import `model3_shelf_life.py` and the trained `.pkl`s directly, no re-implementation in another language |
| Database | PostgreSQL | relational shipment/truck/device data + time-series readings both fit; add TimescaleDB later only if reading volume actually demands it |
| Admin web app | Next.js (React) | standard, works with FastAPI over REST, easy to deploy |
| Phone bridge | Progressive Web App using the Web Bluetooth API | no app-store submission, one codebase; **caveat: Web Bluetooth doesn't work in iOS Safari** — this path is Android-first. If iOS support becomes a hard requirement, the fallback is a thin native wrapper (Capacitor/Flutter) around the same PWA, not a rewrite. |
| Auth | JWT, single admin role for MVP | multi-role (dispatcher/driver) is a real future need, not needed to hit G2 |
| Hosting | any low-cost PaaS (Render/Railway/Fly.io) + managed Postgres | matches a student-project budget/ops load |

### 2.4 Offline & buffering

- **ESP32 side:** if the phone isn't in BLE range, keep logging to a small ring buffer in flash (bounded — old readings drop before new ones do) so a signal gap doesn't lose all data, just the oldest of it.
- **Phone side:** if the backend is unreachable (truck in a dead zone), queue readings locally (IndexedDB) and flush on reconnect. This is why ingest is a POST-batch endpoint, not a live stream requirement.

---

## 3. Automatic AC/IR identification (G3)

The existing `firmware/frostmind_brand_select_ir/frostmind_brand_select_ir.ino` requires a human
to watch the AC and press `y`. That's real, working, and stays as the manual fallback — but it
isn't "the system identifying it automatically." Here's the automatic version, buildable with
zero new hardware.

### 3.1 The signal: temperature response, not IR receive

No TSOP38238 means the system can't listen to a remote or to the AC's IR replies. It *can* watch
its own DHT temperature sensor react to commands it sends — that's a real, already-present
feedback channel.

### 3.2 Algorithm

1. **Baseline.** Sample temp for ~60s untouched, compute baseline slope (ambient drift).
2. **Per candidate protocol** (same `candidates[]` list the manual sketch already discovers via `IRac::isProtocolSupported()`):
   a. Send `power=ON, mode=COOL, degrees=min, fan=HIGH` — the most distinguishable command available.
   b. Sample temp for a test window (~90–120s).
   c. Compute the slope over that window. If it's more negative than baseline by a threshold (e.g. beyond -0.15°C/min net of baseline drift), that candidate provisionally reacted.
   d. **Confirm, don't guess on one signal:** send `power=OFF` on the same protocol, sample a shorter window, check the slope flattens/reverses. Only a candidate that passes both steps gets accepted — guards against a coincidental temperature dip (someone opening a door nearby) being mistaken for a match.
3. **On confirmed match:** persist via the same `Preferences`/NVS mechanism already in the sketch. Done — no human involved.
4. **On no match after the full sweep:** fall back to the manual `l`/`n`/`y` flow (same known-protocol list, human-paced instead of automatic) — that's the only fallback that exists. **This project is not using IRDB, LIRC, or a TSOP38238/receiver** — not deferred, not a later option, ruled out. A full-sweep miss (auto or manual) means this AC can't be controlled by this system as currently scoped, not "try the receiver path instead."

### 3.3 Time-budget reality check

A full sweep of 65 protocols × ~2–3 min each is 2–3+ hours worst case — too slow to watch, but
that's fine *because it no longer needs watching*. Mitigations:

- **Curated shortlist first.** Try the handful of protocols matching common regional AC brands before falling through to the full 65 — cuts typical-case time to minutes, not hours.
- **Run it asynchronously.** The web app's setup wizard (§4) triggers a scan and polls status — "Pairing in progress, started 14:02, will notify on match" — a multi-hour worst case is a non-issue once nobody has to sit and watch it.
- **Fast-path upgrade, later:** once INA219 (already deferred hardware) lands, swap the feedback signal from thermal response (~90–120s per candidate) to compressor current draw (spikes within seconds of power-on) — this turns a 2–3 hour worst-case sweep into minutes. Document this now so the story stays honest: automatic-but-slow today, automatic-and-fast once that hardware is added, not oversold either direction.

### 3.4 Where this lives in firmware

This merges into the combined DHT sensor + reed-switch + IR sketch that was already the next build-order step (MVP plan §6 step 4) — auto-pairing needs the temp sensor wired into the same sketch as the IR sender anyway, so this isn't extra sequencing, it's the natural point where that sketch and the pairing sketch become one. (**Done** — this is `firmware/frostmind_main/frostmind_main.ino`.)

---

## 4. Web app setup / onboarding flow (G4)

The concrete screen-by-screen flow a driver or admin walks through once, per device:

1. **Register device** — enter/scan the ESP32's serial or MAC, name the truck.
2. **Pair phone to device** — Web Bluetooth prompt, standard OS pairing dialog.
3. **Assign category** — pick one of the 6 (§1) for the shipment about to load.
4. **Auto-pair the AC** — button fires `POST /devices/{id}/pairing/start`, which relays the command over BLE to trigger §3's scan; UI polls and shows progress/result. Manual override (the existing `l`/`n`/`y` flow, relayed the same way) stays available if auto-pairing fails to find a match.
5. **Confirm live data** — wizard shows the last few seconds of temp/humidity/door readings streaming in, so setup isn't declared "done" on faith.
6. **Go live** — shipment status flips to `in-transit`, now visible on the admin panel (§2).

---

## 5. What the admin panel actually shows

- **Fleet view:** every truck/device, current shipment, status, last-seen.
- **Shipment detail:** live temp/humidity/door chart, Model 1 anomaly flags overlaid on the timeline, Model 3 shelf-life-remaining for the assigned category, alert history.
- **Alerts feed:** anomaly detections and shelf-life-threshold breaches across the whole fleet, not just one shipment.
- **Reports/export:** per-shipment audit trail (temp history + alerts + category) as a downloadable record — this is the compliance evidence a pharma/food cold-chain actually needs to produce, not just a nice-to-have dashboard.

This is also where the MVP doc's "Supervisor / Route agent / Compliance agent" language (§3 of that doc) resolves concretely: Supervisor = the backend logic that combines Model 1's score and Model 3's shelf-life-consumed into one alert severity; Compliance agent = the report/export endpoint above; Route agent = deferred, since it needs GPS, which is still explicitly out of scope (§7). None of these are trained models — same as the MVP doc already said.

---

## 6. Updated build order (phased, hardware → backend → phone → admin — B and C can run in parallel once A2 is done)

**Phase A — firmware — done.**
1. Manual AC pairing sketch — done, compiled clean, ready to flash (`firmware/frostmind_brand_select_ir/`).
2. Combined DHT sensor + reed-switch + IR logging sketch (MVP plan §6 step 4) — done (`firmware/frostmind_main/`). Note: built for an SHT31-D at first; the actual sensor on hand turned out to be a 3-pin DHT11/DHT22, swapped over — see that folder's README.
3. Auto-pairing algorithm (§3) — done, layered onto the sketch above. Not yet tested against a real AC.
4. BLE peripheral role (Nordic UART Service) — done, same sketch.

**Phase B — backend — done.** FastAPI + SQLAlchemy (SQLite, not Postgres — no server available in the build environment; ORM-only queries so swapping the connection string later is trivial). `/ingest` persists the device's own on-device threshold-rule alert as-is rather than scoring with a Model 1 pkl — none of the trained pkls' feature schemas match live telemetry yet (see `backend/README.md`). Model 3 shelf-life is wired in and working. Ran live end-to-end against a real test script; one real cooldown bug found and fixed.

**Phase C — phone bridge — done.** PWA, Web Bluetooth client to the exact NUS contract, offline IndexedDB queue, the full setup wizard from §4. Not yet tested against real BLE hardware or a real phone.

**Phase D — admin web app — done.** Next.js: fleet view, shipment detail with live charts, alerts feed, CSV report export. Builds and lints clean; not yet clicked through in a real browser.

---

## 7. Assumptions filled in on your behalf — flag if any of these are wrong

- **No GPS/location tracking in this phase** — "get status of that truck" is read as operational status (temp/door/shelf-life/connectivity), not physical location. GPS was already explicitly deferred in the MVP plan's §1; unchanged here.
- **Single admin role for MVP** — no dispatcher/driver role split yet. Real gap for a production rollout, not needed to satisfy G2/G4.
- **Android-first phone bridge** — Web Bluetooth's iOS gap (§2.3) is a real constraint, not an oversight.
- **New Ea/A values for meat/frozen/seafood are illustrative**, same standing caveat as the original 3 categories — replace with published values for your exact products before this is anything beyond a demo, same as the file's existing docstring already says.

---

## 8. What's built vs. still open, right now

**Built and verified running:** all of §6 Phases A–D — firmware (compiles clean, DHT sensor swap included), backend (ran live end-to-end), phone-bridge PWA (code verified, no BLE hardware to test against), admin web app (builds/lints clean, no real browser click-through yet). Also: this doc, the 3 new categories in `scripts/model3_shelf_life.py`, and `FROSTMIND_Hardware_BOM_and_Wiring.md`.

**Still open — all hardware bring-up, not software:**
1. Physically wire the board (BOM + wiring doc, or the published wiring-guide artifact).
2. Flash `firmware/frostmind_main/` and run the validation checklist.
3. Run automatic AC-pairing against the real Samsung AC — **untested**, and there's no fallback if it misses (§3.2 note / MVP plan §5).
4. Pair the phone-bridge PWA against real BLE hardware — first real test of that whole path.
5. Once 1–4 work, start logging real sessions so `train_model1_frostmind.py` has data to train Model 1's live-schema-compatible model against (currently a documented no-op in the backend).

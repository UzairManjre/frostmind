# FROSTMIND — Prototype-to-Production Overhaul Plan

Cross-references, doesn't repeat: `FROSTMIND_Phase2_Implementation_Plan.md` (architecture, long-term AI), `FROSTMIND_Hardware_BOM_and_Wiring.md` (parts/wiring), `FROSTMIND_MVP_Implementation_and_AI_Plan.md` (the 3-model AI plan, firmware). This doc is the missing piece: your actual **software stack** — backend, admin web, phone-bridge — and the concrete path from where it stands today to something industry-ready.

---

## 1. Where this actually stands (read this before assuming a rebuild)

You have a full stack already talking to itself correctly end-to-end: FastAPI + SQLite backend with a real data model (Device/Truck/Shipment/SensorReading/Alert/User), an `/ingest` pipeline that persists readings and computes **Model 3 (shelf-life) live**, JWT-authenticated admin endpoints, an admin web app with a real shipment-detail chart (anomaly flags + door shading already rendered), and a phone-bridge PWA doing Web Bluetooth + offline queueing — which is genuinely the hardest part of this whole system to get right, and it's working.

**The two gaps you named are precise, not vague:**
1. **Model 1 (anomaly detector) is a documented seam in `app/ml.py`, not wired in** — the backend is *built to receive it*, it's just not plugged in yet.
2. **The web app builds clean but "hasn't been clicked through in a real browser"** — that's your own status note, and it's the right thing to fix first, before adding any new feature.

Everything below is organized so you know exactly what unblocks industry-readiness vs. what's genuinely optional for a first working demo.

---

## 2. Phase A (do this first — days, not weeks)

### A1. Wire Model 1 using data you can now actually collect for real

This is easier than it would've been a week ago, because you now have a real `/ingest` → `SensorReading` pipeline instead of manual CSV logs:

1. Export logged `SensorReading` rows straight from SQLite (`sqlite3 .dump` or a quick pandas read against the DB file) instead of hand-copying serial output.
2. Run real sessions through the *actual deployed system* — phone-bridge live, backend recording — for both normal baseline and induced-anomaly sessions (door, hairdryer-near-sensor, power-cut). This is strictly better training data than the original plan, since it's the real pipeline's shape, not a firmware-only simulation of it.
3. Train the Isolation Forest offline exactly as planned (`FROSTMIND_MVP_Implementation_and_AI_Plan.md` §4), but against these real exports.
4. **Wire it into the documented seam in `app/ml.py`.** Since that seam already exists and is documented, this is a swap-in, not new architecture — replace the stub with a call to the trained model, store its output alongside the existing threshold-alert flag on ingest.
5. Surface it in the web app's shipment-detail chart — it already renders anomaly flags, so this is a data-source change, not a new UI feature.

This single change directly answers "no AI models being used" — Model 3 already refutes the literal claim, but Model 1 going live is what actually closes the gap you're feeling.

### A2. Actually click through the web app in a real browser

Before adding a single new feature: log in, view the fleet, open a shipment detail, trigger an alert, export a CSV, watch it on a slow/throttled connection. Fix what breaks. "Builds clean" and "works" are different claims, and shipping a feature on top of an unvalidated base just doubles your debugging surface later. Note every rough edge you hit — that list becomes your first real backlog for §4.

### A3. Close the open device-auth gap

"Field/device endpoints intentionally open" is fine for bench testing, risky the moment this leaves your desk. Add a per-device API key or token (issued at device-registration time, checked on every `/ingest` call) before this touches anything you'd call a pilot. This is a small change now and a real vulnerability later — sequence it early while the endpoint surface is still small.

---

## 3. Phase B (1–2 weeks — backend hardening)

| Gap | Why it matters | What to do |
|---|---|---|
| SQLite in prod | Fine for one device, not a fleet | You're already ORM-only and "Postgres-ready" per your own notes — this should be a connection-string swap + migration run, not a rewrite. Do it before load matters, not after. |
| No automated tests mentioned | Every change risks silently breaking `/ingest`, alerting, or shelf-life calc | Start narrow: tests for `/ingest`'s alert-generation logic and the Model 3 calculation — the two places a silent bug would be worst. |
| No observability | You'll find out about failures from a customer, not a dashboard | Structured logging at minimum; a free tier of Sentry or similar if you want failure alerts without building your own. |
| Polling, not websockets | Works, but doesn't scale and adds latency to alerts | Not urgent for a demo. Worth doing once you're past Phase A — it's the difference between "refresh to see the alert" and "the alert just appears," which matters a lot for how *live* the product feels. |
| Self-signed HTTPS | Fine for LAN/dev, breaks the moment this isn't on your network | A real domain + Let's Encrypt cert is a same-day task once you're ready to deploy somewhere reachable — not urgent while testing locally. |

---

## 4. Phase B (1–2 weeks — web app feature completeness)

This is the direct answer to "the web app leaves so much to be desired." Concretely, here's what a fleet-monitoring dashboard needs that isn't in your current list:

- **A map view — but this needs GPS hardware first, which does not exist in this system yet.** Correction to the original draft of this plan: there is no GPS anywhere in FROSTMIND today — not on the ESP32 (GPS was explicitly deferred hardware in the MVP plan's own scope from the start), not in the phone-bridge (no `navigator.geolocation` call anywhere in `phone-bridge/js/`), not in the backend schema (no lat/lng field on `Device`, `Truck`, or `Shipment`). A map view is a real, high-value feature for a logistics product, but it's gated on sourcing a GPS module, wiring it in, adding firmware support, and relaying position through the phone-bridge (or, more simply, using the *phone's own* GPS via the Geolocation API instead of new hardware — the phone-bridge already runs on a phone that has GPS, so this is worth considering as the faster path). Either way, treat this as new-capability work, not a UI addition on top of data that already exists.
- **Configurable alert thresholds**, per shipment or payload category, exposed in the UI — not hardcoded. Ties directly to your shelf-life model already being category-aware.
- **A fleet-level analytics/trends view** — not just per-shipment detail, but "how many excursions this month," "which routes/trucks have the most alerts." This is what actually sells the product to a fleet manager, versus a single shipment's chart.
- **Multi-user roles** — is the JWT auth currently one admin, or does it support a driver view vs. a fleet-manager view vs. an admin view? Worth deciding deliberately rather than defaulting to one flat role.
- **Empty, loading, and error states.** The unglamorous 20% of the work that's most of what "feels unfinished" actually comes from — a blank fleet view, a failed API call, a slow load, all need a real state, not a blank screen.
- **Mobile-responsive admin view**, if a fleet manager is ever going to check this from a phone rather than a desk.

---

## 5. Phase C (parallel track — hardware + Model 2)

Nothing here blocks the software work above; run it alongside.

- **INA219 → Model 2 (root-cause classifier).** Still gated on this hardware exactly as scoped before. Once it's in, the classifier training plan from the MVP AI doc applies directly, and the seam should land in the same `/ingest` pipeline, next to Model 1's alert generation.
- **GPS module** (see §4's correction) — if the map view is worth prioritizing, this is the hardware dependency it's actually gated on.
- **DS18B20 probes, battery backup, enclosure** — the remaining deferred BOM items, sequenced whenever hardware time is free.

### The platform decision hiding in your phone-bridge

**Web Bluetooth doesn't work in iOS Safari — at all.** This means the phone-bridge, as built, is Android-only. That's not necessarily wrong (plenty of fleet deployments deliberately standardize on Android for exactly this reason, and it's a completely legitimate decision) — but it should be a decision you're making on purpose, documented as a known constraint, not something that surfaces as a surprise during a pilot with a driver who has an iPhone. If cross-platform ever becomes a real requirement, that's a native app (React Native/Flutter) rewrite of the phone-bridge specifically — worth knowing that's the cost before you need it.

---

## 6. Phase D — what "industry-ready" actually requires beyond a working demo

Worth naming explicitly, even if none of this is urgent yet, so "industry-ready" has a concrete meaning instead of being an open-ended target:

- **Multi-tenancy** — if this is ever sold to more than one trucking company, does the data model isolate one company's fleet from another's? Worth a deliberate answer, even if the answer is "not yet, single-tenant for the pilot."
- **Security review** — the device-auth fix in §2 is the immediate gap; a real pre-launch pass (dependency audit, auth flow review, rate-limiting check) comes before any pilot with real customer data.
- **A real pilot with a real fleet** — the actual test that matters more than any of the above. Everything in this doc is what makes that pilot survivable, not a substitute for running one.
- **Monitoring/SLA thinking** — once someone else's cold chain depends on this, "it usually works" isn't the bar anymore.
- **Documentation** — for whoever installs a device on a truck that isn't you.

---

## 7. Suggested sequencing

| Order | What | Track |
|---|---|---|
| 1 | Wire Model 1 into the existing `app/ml.py` seam | AI |
| 1 | Manually QA the web app in a real browser, fix what breaks | Web |
| 2 | Device API keys on `/ingest` | Backend |
| 3 | Configurable thresholds + empty/error states | Web |
| 3 | Postgres migration, tests, logging | Backend |
| 4 | GPS (phone Geolocation API first, dedicated module later) + map view | Web/Hardware |
| 4 | INA219 → Model 2 | Hardware/AI |
| 4 | Decide Android-only vs. native app, on purpose | Phone-bridge |
| 5 | Multi-tenancy, security review, real pilot | Industry-ready |

Rows sharing a number can run in parallel — they don't block each other.

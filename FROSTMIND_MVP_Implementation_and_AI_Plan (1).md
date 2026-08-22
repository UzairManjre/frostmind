# FROSTMIND — MVP Implementation & AI Plan (Current Version)

This covers the version you're actually building right now: ESP32-S3 + DHT11/DHT22 (single-wire temp/humidity — earlier drafts assumed an I2C SHT31-D, but the actual sensor on hand has 3 pins) + MC-38 reed switch + IR transmitter (transmit-only — no TSOP38238 receiver in this build), tested against your room AC as a stand-in for a truck reefer unit. It cross-references two earlier docs rather than repeating them:

- **Full system architecture + long-term AI plan:** `FROSTMIND_Phase2_Implementation_Plan.md`
- **Hardware BOM + pin wiring:** `FROSTMIND_Hardware_BOM_and_Wiring.md`

This doc is the bridge between them — what to actually build and test *this week* with the hardware in front of you.

---

## 1. Scope of this version

**What this version proves:** the full detect → decide → intervene loop, on real hardware, ending in a real device (your room AC) visibly reacting to a command your system generated itself. That's the whole point of the MVP — not accuracy, not scale, just proof that the loop closes.

**Explicitly deferred (already decided, not forgotten):** GPS, DS18B20 probes, INA219, battery backup/UPS, the cloud multi-agent layer, the trained LSTM model, the root-cause classifier (needs INA219), the shelf-life model's learned correction layer, and the TSOP38238 IR receiver (with it, capture-based pairing). All of it bolts onto this same ESP32-S3 later without a redesign.

**No TSOP38238 in this build.** AC control is transmit-only — there's nothing to receive or decode. §5 covers the actual pairing strategy this forces: walk known protocols, watch the AC, confirm by eye, save the winner. If a TSOP38238 gets sourced later, capture-based pairing (recording your real remote's exact codes instead of guessing at a library protocol) becomes an option too — see the note at the end of §5.

---

## 2. Firmware architecture

One sketch, four responsibilities. Rough structure:

```cpp
// setup()
dht.begin();                // DHT11/DHT22, single-wire DATA=GPIO8
pinMode(REED_PIN, INPUT_PULLUP);   // GPIO4
// GPIO5 unused for now — reserved for a TSOP38238 if one gets sourced later.
// GPIO9 free too — it was SCL back when this assumed an I2C SHT31-D.
irsend.begin();            // IR LED driver on GPIO6
loadPairedAcProtocol();    // from NVS — see §5's pairing sketch

// loop(), every ~2s
float t = dht.readTemperature();
float h = dht.readHumidity();
bool doorClosed = digitalRead(REED_PIN);     // LOW = open
pushToRollingBuffer(t);

float rateOfChange = computeSlope(rollingBuffer);   // °C/min over last ~5 samples
bool tempAlert = (rateOfChange > RATE_THRESH) || (abs(t - SETPOINT) > DEV_THRESH);
bool doorAlert = (!doorClosed && doorOpenDuration() > DOOR_THRESH_SEC);

logToSerial(t, h, doorClosed, rateOfChange);   // <- this line is your future training data

if ((tempAlert || doorAlert) && cooldownExpired()) {
    sendPairedIRCommand();   // e.g. FAN_HIGH or TEMP_DOWN, using the protocol paired in §5
    startCooldown();
}
```

**Libraries:** `DHT sensor library` (Adafruit — sensor is a DHT11/DHT22, not the I2C SHT31-D earlier drafts assumed), `IRremoteESP8266` (transmit only in this build — `IRac` builds full AC command states from a `decode_type_t` protocol, so pairing just needs to pick the right protocol, not capture/replay raw codes).

---

## 3. How many models, and the plan for each

Three real, trainable models in the full system — not more, not fewer. Everything else (Supervisor, the Route agent's core logic, the Compliance agent) is orchestration or an LLM API call, not something you train.

| # | Model | Task | Trainable now? |
|---|---|---|---|
| **1** | **Anomaly detector** | Temp/humidity/door time series → anomaly score | **Yes.** MVP hardware (DHT11/DHT22 + reed switch) is enough. Build this first — full plan in §4. |
| **2** | **Root-cause classifier** | Given an anomaly, classify *why* — door left open vs. compressor fault vs. power loss | **Not yet.** Door-open is already known directly from the reed switch, no ML needed there — but telling compressor fault apart from power loss needs the power-draw signal, i.e. INA219, which is explicitly deferred in your MVP staging. This model is blocked on hardware you already decided to add later, not on effort. **When it's unblocked:** log power-draw traces during induced compressor-load changes vs. induced power cuts, engineer features (draw magnitude, draw variance, time-to-zero), train a small multi-class classifier (Random Forest, 3 classes) — same offline Python workflow as Model 1. |
| **3** | **Shelf-life model** | Exposure history → remaining viable hours for the payload | **Partially.** The baseline is the Arrhenius equation (k = A·exp(−Ea/RT) — rate constant k depends on temperature T), integrated over exposure time to get % shelf-life consumed. That's a formula, not a trained model — implement it now, no data needed, using published Ea/A values per product category from food-science/pharma literature (the vaccine refrigeration paper from the dataset search is a good source). The *learned correction* layer on top of that formula needs your own logged outcome data at a volume you won't have for a while — real future work, not this week's task. |

**What this means for your build order:** train Model 1 now — you already have the full plan for it. Write the Model 3 kinetic formula now too, since it's math, not training, so there's no reason to wait on it. Leave Model 2 alone until INA219 is back in the hardware; building it today with only door+temp data would mean training a classifier that can't actually see the signal it needs to do its job.

---

## 4. Model 1 — the AI plan: what's real now, and what's next

Be precise about this in your writeup, it's a stronger story told straight than oversold:

**Right now: no trained model. A threshold rule.** The rate-of-change + deviation check in §2 is deterministic logic, not ML — and that's the correct choice at this stage, because an LSTM autoencoder has nothing to learn from until you have logged operating data. The MVP's real job, beyond the demo, is to **generate that first dataset**.

**The staged path from here:**

| Stage | What it is | What unlocks it |
|---|---|---|
| **1 (now)** | Rule-based threshold, on-device, no training data yet | Nothing — this is where you are |
| **2** | First *actual* trained model — an Isolation Forest trained offline in Python on logged sessions | A handful of logged runs, including a few you deliberately break (see below for the full plan) |
| **3** | The full LSTM autoencoder from the phase 2 plan, quantized via TensorFlow Lite Micro | Enough time-series volume to train it meaningfully; check your specific ESP32-S3 board's PSRAM (8MB variants like N16R8 can run small quantized models on-device — smaller-PSRAM boards would need a gateway device instead) |
| **4** | Cloud multi-agent layer (Supervisor, shelf-life, route, compliance) | A real gateway/cloud path — see the phase 2 doc |

Stage 2 is worth calling out specifically in your presentation: it's a genuinely trained model, achievable on the data volume an MVP can actually produce, and it's honest scoping compared to promising an LSTM before you have the data to train one.

### Stage 2 in detail — how to actually train it

**Data collection.** Use the `logToSerial` CSV stream and capture two kinds of sessions: a **normal baseline** (AC running steady, several hours, nothing induced) and several **induced-anomaly clips** (open the door repeatedly for varying durations, hold a hairdryer near the SHT31-D to fake compressor-fault heat, unplug the AC to fake power loss). Session-level labels are enough — note start/end time and what you induced, not per-second labels. A few hours of baseline plus 5–10 short induced clips is genuinely enough for this stage.

**Feature engineering.** Per rolling window: rolling mean temp, rolling std (volatility), rate of change, door-open duration in the window, time since last door event.

**Model — Isolation Forest, trained offline in Python:**
```python
import pandas as pd
from sklearn.ensemble import IsolationForest
import joblib

df = pd.read_csv("frostmind_log.csv")  # ts, temp, humidity, door, rate_of_change, session_label
df["roll_mean"] = df["temp"].rolling(10).mean()
df["roll_std"]  = df["temp"].rolling(10).std()
features = df[["roll_mean", "roll_std", "rate_of_change", "door_open_dur"]].dropna()

# Train ONLY on normal-baseline rows — Isolation Forest learns "normal", flags outliers
normal_rows = features[df["session_label"] == "normal"]
model = IsolationForest(contamination=0.02, random_state=42)
model.fit(normal_rows)
joblib.dump(model, "frostmind_stage2_model.pkl")
```

**Evaluation.** Run it against held-out induced-anomaly sessions (recall) and held-out normal sessions it wasn't trained on (false-positive rate) — same two metrics as the phase 2 doc's evaluation section, not a new scheme.

**Deployment — be precise about the claim.** Isolation Forest doesn't port cleanly to a microcontroller. Either keep it running offline and present the trained results as your ML checkpoint (legitimate — you're not claiming on-device inference yet), or compare where it flags vs. a simple z-score threshold and hardcode that *calibrated* threshold into firmware — which is "informed by the model," not "the model on-device." The real on-device model stays Stage 3.

---

## 5. Testing plan: universal AC pairing (no TSOP38238 in this build)

This is your concrete near-term milestone — a real device responding to a command your system generated is the strongest demo evidence you can show. The original version of this section assumed a TSOP38238 receiver to capture your actual remote's codes; that part isn't sourced, so this build uses a different, still-legitimate strategy: **transmit known AC protocols and let a human confirm by eye which one the real AC obeys**, then persist that choice. This is exactly how commodity "universal remote" apps (Mi Remote and similar) work when they don't have your original remote either.

1. **Flash `firmware/frostmind_brand_select_ir/frostmind_brand_select_ir.ino`.** It's already in the repo, compiled clean against `esp32:esp32:esp32s3` (65 protocols discovered at runtime in the currently-installed library version). On boot it scans `IRremoteESP8266`'s `IRac` class for every AC protocol the installed library version can build a full command for — not a hand-typed list, so it can't go stale or contain a typo'd protocol name — and prints them over serial.
2. **Step through candidates.** Open the serial monitor. `n` sends the next candidate's power-on + cool-24°C command; a number + Enter jumps straight to a candidate's index; `l` reprints the full list. After each send, watch the real AC.
3. **Confirm and pair.** The moment the AC visibly reacts (display change, beep, compressor kicking in), type `y`. That protocol is written to flash (ESP32 NVS via `Preferences`) — it survives reboot, which is what makes this a *pairing* step and not just a one-off test.
4. **Sanity-check control, not just power.** Post-pairing, `+`/`-` step the target temperature, `f` cycles fan speed, `p` toggles power — same locked-in protocol. Confirm more than one of these actually changes AC behavior before calling it paired; a coincidental reaction to power-on alone is weaker evidence.
5. **That confirmed reaction is your closed-loop proof.** Scan → transmit → human-confirm → persist → real device responds to a command your system chose. Photograph or video the moment it reacts; it's the strongest single piece of evidence in your presentation, because it's not simulated.
6. **If your AC never reacts to anything offered:** that means it's running a protocol not in `IRremoteESP8266`'s supported list — and right now, that's a hard dead end, not a "try this instead." **This project is not using IRDB, LIRC, or a TSOP38238/IR receiver, full stop** — not "later," not as a fallback path. That rules out both of the options a receiver-based approach would otherwise offer (capturing your real remote's raw codes, or pulling and verifying community-sourced codes against a receiver). If the automatic pairing sweep (Phase2 plan §3, Samsung tried first) doesn't find a match, the honest status is: this AC can't be controlled by this system as currently scoped.

---

## 6. Build order for this version

1. Wire the MVP hardware (already documented — see the wiring guide).
2. Flash and validate each part individually: DHT read returns a real (non-NaN) temp/humidity, reed switch state toggles, IR LED visibly flickers on a phone camera when a test command sends (no receiver to validate against, so this is as far as per-part IR validation goes).
3. Run the pairing test in §5 against your room AC — **this is the milestone to hit first**, before wiring anything else together.
4. Combine the DHT sensor + reed switch into one continuous logging sketch (the `logToSerial` line from §2). Run it for a real stretch of time — even a few hours — to get your first real sensor log.
5. Add the threshold rule from §2, wired to auto-fire the paired IR command. Demo it by inducing a temp rise near the sensor (a hairdryer works well) and watching it auto-trigger the AC command — this is the actual end-to-end MVP loop.
6. Take the logged data offline and build the Stage 2 model from §4 in Python — your first real trained-model checkpoint.

---

## 7. How to frame the AI story in your presentation

Say plainly that the current on-device logic is threshold-based, and that its explicit purpose is to generate the first labeled dataset the real model needs. "We built the instrumentation before the model, because the model needs data the instrumentation is what produces" is a mature engineering narrative — it reads as deliberate staging, not as a missing feature.

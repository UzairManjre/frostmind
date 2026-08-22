# FROSTMIND — MVP Implementation & AI Plan (Current Version)

This covers the version you're actually building right now: ESP32-S3 + SHT31-D + MC-38 reed switch + TSOP38238 + IR transmitter, tested against your room AC as a stand-in for a truck reefer unit. It cross-references two earlier docs rather than repeating them:

- **Full system architecture + long-term AI plan:** `FROSTMIND_Phase2_Implementation_Plan.md`
- **Hardware BOM + pin wiring:** `FROSTMIND_Hardware_BOM_and_Wiring.md`

This doc is the bridge between them — what to actually build and test *this week* with the hardware in front of you.

---

## 1. Scope of this version

**What this version proves:** the full detect → decide → intervene loop, on real hardware, ending in a real device (your room AC) visibly reacting to a command your system generated itself. That's the whole point of the MVP — not accuracy, not scale, just proof that the loop closes.

**Explicitly deferred (already decided, not forgotten):** GPS, DS18B20 probes, INA219, battery backup/UPS, the cloud multi-agent layer, and the trained LSTM model. All of it bolts onto this same ESP32-S3 later without a redesign.

---

## 2. Firmware architecture

One sketch, four responsibilities. Rough structure:

```cpp
// setup()
Wire.begin(8, 9);          // SHT31-D I2C — SDA=GPIO8, SCL=GPIO9
sht31.begin(0x44);
pinMode(REED_PIN, INPUT_PULLUP);   // GPIO4
irrecv.enableIRIn();       // TSOP38238 on GPIO5
irsend.begin();            // IR LED driver on GPIO6

// loop(), every ~2s
float t = sht31.readTemperature();
float h = sht31.readHumidity();
bool doorClosed = digitalRead(REED_PIN);     // LOW = open
pushToRollingBuffer(t);

float rateOfChange = computeSlope(rollingBuffer);   // °C/min over last ~5 samples
bool tempAlert = (rateOfChange > RATE_THRESH) || (abs(t - SETPOINT) > DEV_THRESH);
bool doorAlert = (!doorClosed && doorOpenDuration() > DOOR_THRESH_SEC);

logToSerial(t, h, doorClosed, rateOfChange);   // <- this line is your future training data

if ((tempAlert || doorAlert) && cooldownExpired()) {
    sendLearnedIRCommand();   // e.g. FAN_HIGH or TEMP_DOWN, from the codes captured in §4
    startCooldown();
}
```

**Libraries:** `Adafruit_SHT31` (sensor), `IRremoteESP8266` (both capture and replay — it uses the ESP32's RMT peripheral, so GPIO5/GPIO6 both work fine for RX/TX independently).

---

## 3. The AI plan — what's real now, and what's next

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

## 4. Testing plan: capture your room AC's signal and replicate it

This is your concrete near-term milestone — a real device responding to a command your system generated is the strongest demo evidence you can show.

1. **Flash the capture sketch.** `IRremoteESP8266` ships an example called `IRrecvDumpV2` — flash it as-is, wired to the TSOP38238 on GPIO5.
2. **Capture each button you care about.** Open the serial monitor, point your actual room AC remote at the TSOP, and press one button at a time with a pause between each — Power, Temp Up, Temp Down, Fan Speed, Mode. `IRrecvDumpV2` prints the detected protocol (e.g. `DAIKIN`, `VOLTAS`, `MITSUBISHI_AC`, `COOLIX`) plus the raw hex/state array for each press.
3. **Expect one of two outcomes, and know the fallback:**
   - *Recognized protocol* (common brands like Daikin, Voltas, Blue Star, LG, Samsung, Mitsubishi are supported): you get a proper state-based class you can construct new commands with, e.g.:
     ```cpp
     IRVoltasAC ac(6);       // GPIO6
     ac.begin();
     ac.setTemp(22);
     ac.setFan(kVoltasFanHigh);
     ac.send();
     ```
   - *Unrecognized/proprietary protocol*: fall back to raw replay — you can't programmatically construct new states, but you can exactly replay what you captured, which is enough for this milestone:
     ```cpp
     uint16_t rawData[] = { /* timing array copied from IRrecvDumpV2 output */ };
     irsend.sendRaw(rawData, len, 38);   // 38kHz carrier
     ```
4. **Save every captured code**, labeled clearly (`POWER_ON`, `TEMP_UP`, `FAN_HIGH`, etc.) into a header file in your firmware.
5. **Flash the replay side** and point the IR LED at your actual AC. Trigger a send, confirm the AC visibly reacts — display change, beep, or the room actually cooling differently.
6. **That confirmed reaction is your closed-loop proof.** Capture → decode → replicate → real device responds. Photograph or video it; it's the strongest single piece of evidence in your presentation, because it's not simulated.

---

## 5. Build order for this version

1. Wire the MVP hardware (already documented — see the wiring guide).
2. Flash and validate each part individually: I2C scan finds `0x44`, reed switch state toggles, IR receive dumps a code when you press a remote button.
3. Run the capture-and-replicate test in §4 against your room AC — **this is the milestone to hit first**, before wiring anything else together.
4. Combine SHT31 + reed switch into one continuous logging sketch (the `logToSerial` line from §2). Run it for a real stretch of time — even a few hours — to get your first real sensor log.
5. Add the threshold rule from §2, wired to auto-fire the learned IR command. Demo it by inducing a temp rise near the sensor (a hairdryer works well) and watching it auto-trigger the AC command — this is the actual end-to-end MVP loop.
6. Take the logged data offline and build the Stage 2 model from §3 in Python — your first real trained-model checkpoint.

---

## 6. How to frame the AI story in your presentation

Say plainly that the current on-device logic is threshold-based, and that its explicit purpose is to generate the first labeled dataset the real model needs. "We built the instrumentation before the model, because the model needs data the instrumentation is what produces" is a mature engineering narrative — it reads as deliberate staging, not as a missing feature.

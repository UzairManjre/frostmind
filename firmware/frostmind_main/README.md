# FROSTMIND main firmware (`frostmind_main`)

This is the deployable FROSTMIND firmware: DHT11/DHT22 + reed-switch sensing,
threshold-rule alerting, paired-IR AC intervention, an automatic AC-protocol
identification sweep, and a BLE peripheral (Nordic UART Service pattern) for
the phone bridge. It supersedes the standalone
`firmware/frostmind_brand_select_ir/frostmind_brand_select_ir.ino` sketch for
day-to-day operation; that sketch is untouched and still works as a
minimal, dependency-light manual-pairing reference/fallback tool.

See `FROSTMIND_MVP_Implementation_and_AI_Plan (1).md` §2 (firmware
architecture) and `FROSTMIND_Phase2_Implementation_Plan.md` §3 (auto-pairing
algorithm) / §6 Phase A for the design this implements.

## Wiring

**Board: Seeed XIAO ESP32-S3.** Wire by the **D-label** printed next to each hole. On this board
D*n* is **not** GPIO *n* (D6 is GPIO43, for example), and the XIAO ESP32-C3 pinout looks
identical but maps differently, so don't use that one.

| Signal | XIAO pad | ESP32-S3 pin | Notes |
|---|---|---|---|
| DHT11/DHT22 DATA | **D8** | GPIO7 | single-wire, `FROSTMIND_DHT_TYPE` selects which (moved from GPIO8 to match the rebuilt board) |
| MC-38 reed switch | **D4** | GPIO5 (moved from GPIO4 to match the rebuilt board) | `INPUT_PULLUP`, **HIGH = door open** (corrected after real-hardware testing showed the original LOW=open assumption was backwards -- see `loop()`'s comment in the .ino) |
| IR transmitter (LED driver) | **D5** | GPIO6 | transmit-only, no IR receiver in this build |
| WS2812/WS281x RGB light strip DIN | **D3** | GPIO4 | status lights, **GRB** colour order; strip 5V -> board 5V, GND -> GND (the original reed-switch pin, reused) -- see "Status light strip" below |
| (free) | D9, D10 | GPIO8, GPIO9 | GPIO8 was the original DHT pin; GPIO9 was SCL back when this used an I2C SHT31-D |

The sensor actually on hand has 3 pins (VCC/GND/DATA), which is a
DHT11/DHT22/AM2302, not the I2C SHT31-D earlier drafts of this project
assumed. Set `#define FROSTMIND_DHT_TYPE` near the top of `frostmind_main.ino`
to `DHT11` or `DHT22` to match what's printed on the sensor body — everything
else in the file is identical either way. If it's a bare sensor rather than a
breakout module, it needs a 10kΩ pull-up from DATA to VCC; most 3-pin
breakout modules already have this built in.

No TSOP38238 in this build: IR is transmit-only, nothing is ever received or
decoded. The automatic AC-pairing algorithm below uses the DHT sensor's own
temperature feedback as its signal instead of an IR receive/decode.

## Libraries

Install via `arduino-cli lib install "<name>"` (or Arduino IDE Library
Manager):

- `DHT sensor library` (Adafruit, v1.4.7) + its `Adafruit Unified Sensor` dependency (v1.1.15)
- `IRremoteESP8266` (already installed in this project's sketchbook, v2.9.0)
- `ArduinoJson` (v7.x — this sketch uses the v7 `JsonDocument` API)
- BLE: **none to install** — see "BLE library" below.
- Light strip: **none to install** — driven through the esp32 core's own RMT API (`rmtInit`/`rmtWrite`), the same calls the core's `rgbLedWrite()` uses.

## BLE library: which one, and why

The sketch `#include`s `<BLEDevice.h>` from the **esp32 Arduino core's
bundled BLE library** (`esp32:esp32` 3.3.11,
`<Arduino15>/packages/esp32/hardware/esp32/3.3.11/libraries/BLE`) — it is
part of the core package itself, not something installed separately via
Library Manager or `arduino-cli lib install`. It compiled cleanly on the
first attempt against this core version (see "Compile verification" below),
so the NimBLE-Arduino fallback mentioned in the build brief was **not
needed**.

Note for anyone reading the core source: this bundled library can be backed
by either the ESP-IDF Bluedroid stack or NimBLE under the hood (both compile
paths exist in `BLEServer.h`/`BLECharacteristic.h`, gated on
`CONFIG_BLUEDROID_ENABLED`/`CONFIG_NIMBLE_ENABLED`), but it exposes the same
`BLEDevice`/`BLEServer`/`BLECharacteristic` API either way. This sketch only
uses the common, backend-independent surface (`BLEServerCallbacks::onConnect
/onDisconnect(BLEServer*)`, `BLECharacteristic::PROPERTY_NOTIFY/PROPERTY_WRITE`,
`notify()`, `getValue()`, `BLEDevice::setMTU()`), so it does not depend on
which backend this core build defaults to.

## Build / flash

```
arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc --warnings all "firmware\frostmind_main"
arduino-cli upload -p <PORT> --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc "firmware\frostmind_main"
```

**The `:CDCOnBoot=cdc` board option is required, not optional.** This board's `USB Mode`
defaults to native USB (`USB-Serial/JTAG`), but the `USB CDC On Boot` option defaults to
**Disabled** — meaning `Serial.println()` in the running sketch goes out on physical UART0
pins instead of the native USB port, while the ROM bootloader (used during flashing) always
uses that USB port regardless. Without this flag, flashing appears to succeed and the serial
monitor shows the ROM boot banner (`ESP-ROM:esp32s3-...`) and then **nothing else, forever**
— it looks like a dead board or a crashed sketch, but it's neither; the sketch is running
fine, its output is just going to a pin nothing is listening on. Confirmed on real hardware:
identical firmware, silent with the default option, fully working with `CDCOnBoot=cdc`.

Open a serial monitor at 115200 baud after flashing.

## BLE contract (Nordic UART Service pattern)

This is the exact, load-bearing contract the phone-side app must match — do
not change these UUIDs or message shapes without updating both sides.

**RX-side chunk reassembly is required and was missing — confirmed the hard way on real
hardware.** The phone writes each JSON command in <=20-byte pieces (`WRITE_CHUNK_SIZE` in
`phone-bridge/js/ble.js`), each landing as its own `onWrite()` callback. An earlier version of
this firmware treated every single `onWrite()` payload as a complete command on its own — every
real command, including every manual-pairing button press from the app, showed up as two
`deserializeJson()` failures back to back (`IncompleteInput` on the first partial chunk,
`InvalidInput` on the second) and was silently dropped before ever reaching
`sendAcTestCommand()`. This looked exactly like a dead LED/bad wiring from the outside — nothing
sent, nothing to see — when the actual fault was upstream in BLE command parsing. Fixed by
accumulating chunks into `bleRxAccumBuffer` across `onWrite()` calls and only handing a complete
line to `loop()` once a `\n` has actually been seen, mirroring what `ble.js`'s `_onNotify()`
already did correctly for the TX direction.

- **Service UUID:** `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- **RX characteristic** (phone writes commands to device), `WRITE`:
  `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- **TX characteristic** (device notifies telemetry/status to phone),
  `NOTIFY`: `6e400003-b5a3-f393-e0a9-e50e24dcca9e`
- **Advertised device name:** `FROSTMIND`

**The advertisement payload includes the service UUID itself, not just the device name --
confirmed necessary on real hardware, not a defensive-but-unneeded extra.** An earlier version
of `setupBle()` called `pServer->getAdvertising()->start()` without first calling
`addServiceUUID(kBleServiceUuid)`. That compiles fine and the device *is* technically
advertising (name visible in a generic BLE scanner), but `navigator.bluetooth.requestDevice({
filters: [{services: [SERVICE_UUID]}] })` on the phone side filters on *advertised* service
UUIDs specifically -- it has nothing to match against without this, so the device never
appears in the browser's device picker at all, silently. Fixed by calling `addServiceUUID()` +
`setScanResponse(true)` before `start()`; re-verified compiling clean afterward.

**Framing:** newline-delimited JSON, one object per message (built/parsed
with `ArduinoJson`, never hand-rolled string concatenation/parsing). The
device requests an extended MTU (`BLEDevice::setMTU(185)` in `setup()`) so
each JSON message fits in a single notification without multi-packet
reassembly — the phone side should also negotiate/accept an MTU of at least
185 for this to take effect (the ATT MTU is negotiated between both sides;
if the phone never requests one, the connection may stay at the default
~23-byte MTU regardless of what the device asks for — this could not be
verified without a real BLE central to pair against, see "What could not be
verified" below).

### Device → phone (TX notify), every sensor loop iteration (~2s)

```json
{"ts":<ms>,"temp":<float>,"hum":<float>,"door":<bool>,"roc":<float>,"alert":<bool>,"ac_commanded":<bool>,"ac_degrees":<int>,"ac_power":<bool>,"ac_last_cmd_ms":<ms>}
```

- `ts`: `millis()` timestamp (device uptime in ms, **not** wall-clock time —
  the device has no RTC/network time source).
- `temp` / `hum`: °C / %RH from the DHT sensor.
- `door`: **`true` means the door is OPEN** (reed switch reads HIGH, per the
  hardware-verified pull-up wiring -- see the Wiring table above), `false`
  means closed. This convention isn't explicit in the JSON contract itself,
  so it's called out here deliberately for whoever builds the phone-side
  parser.
- `roc`: rate-of-change of temperature in °C/min, least-squares slope over
  the rolling buffer (see "Threshold-rule alert logic" below).
- `alert`: `true` if either the rate-of-change or setpoint-deviation
  threshold rule fired, or the door has been open longer than
  `DOOR_OPEN_ALERT_THRESH_MS`, on this iteration.
- `ac_commanded`: `true` once the paired protocol has actually been used to
  send a command at least once this session. `ac_degrees`/`ac_power`/
  `ac_last_cmd_ms` are only present when this is `true` (omitted otherwise,
  not sent as `null`) -- the phone side should treat their absence as "no AC
  command yet," not try to render a value.
- `ac_degrees` / `ac_power`: the AC's last-commanded target temperature and
  power state, **as far as this device knows**. Deliberately only updated by
  a send on the *confirmed paired* protocol (automatic threshold-triggered
  intervention, or a post-pairing manual `+`/`-`/`p` sanity-check) -- sends
  during the auto-pairing sweep or pre-confirmation manual stepping do NOT
  update this, since those use unconfirmed candidate protocols with no real
  basis yet for claiming the AC actually changed state. See
  `sendAcTestCommand()`'s update-site comment in the `.ino`.
- `ac_last_cmd_ms`: `millis()` at that last confirmed-protocol send -- same
  clock as this message's own `ts`, so "how long ago" is `ts - ac_last_cmd_ms`,
  no wall-clock time needed.

### Device → phone (TX notify), pairing status updates

```json
{"type":"pairing_status","state":"scanning|matched|no_match|idle","candidate_index":<int>,"total":<int>}
```

- `state`: collapsed from the firmware's internal pairing state machine —
  `"scanning"` covers baseline measurement, per-candidate testing,
  confirmation, and manual fallback (i.e. anything actively in progress);
  `"matched"` once a protocol is confirmed and persisted; `"no_match"` after
  a full auto sweep with no confirmed candidate; `"idle"` before pairing has
  ever been started (or after `clearPairing`).
- `candidate_index`: 0-based index into the runtime-discovered candidate
  list. `-1` during the baseline-measurement phase (no candidate under test
  yet). Once matched, holds the index of the matched/persisted candidate.
- `total`: total number of candidate protocols discovered at boot via
  `IRac::isProtocolSupported()`.

Sent whenever pairing state changes, and immediately in reply to a
`{"cmd":"pairing_status"}` request (see below).

### Phone → device (RX write), commands

```json
{"cmd":"set_category","category":"<one of: vaccine_generic|pasteurized_milk|fresh_produce_generic|meat_poultry_chilled|frozen_food_generic|seafood_fresh_chilled>"}
{"cmd":"start_pairing"}
{"cmd":"pairing_status"}
{"cmd":"manual_pair","index":<int>}
{"cmd":"manual_confirm"}
{"cmd":"led","shelf":<0-100, % shelf life LEFT; -1 = unknown>,"alert":"none|warning|critical"}
{"cmd":"identify"}
```

- `set_category`: sets the alert setpoint used by the threshold rule
  (see table below) and persists the category string to NVS. Unknown
  category strings are rejected (logged over Serial, no state change).
- `start_pairing`: (re)starts the automatic AC-pairing sweep from the
  baseline-measurement phase, discarding any in-progress pairing state.
- `pairing_status`: device replies immediately with a `pairing_status` TX
  message reflecting current state — does not itself change any state.
- `manual_pair`: jumps to candidate `index` and transmits its power-on +
  cool test command (the BLE equivalent of the serial `l`/`n`/digit+Enter
  flow) — puts the pairing state machine into manual mode, interrupting any
  in-progress automatic sweep.
- `manual_confirm`: persists the currently-selected manual candidate to NVS
  (the BLE equivalent of the serial `y` key) — marks pairing as `matched`.
- `led`: what the light strip should show from the backend, sent by the phone dashboard after
  every AI refresh (~10 s): Model 3 shelf life **left** (the most perishable product, for a mixed
  load) and the newest backend alert of the last 10 minutes (`critical` = high/critical severity,
  `warning` = anything else). Not stored; the strip stops showing it if no update arrives for
  `PHONE_STATUS_STALE_MS` (2 min).
- `identify`: plays a 5 s rainbow on the light strip, so the driver can see which box the phone
  is connected to (also proves the phone → device direction works).

Category → default alert setpoint (used only by the on-device threshold
rule; the authoritative Arrhenius shelf-life math lives in
`scripts/model3_shelf_life.py`, not here):

| Category key | Setpoint (°C) |
|---|---|
| `vaccine_generic` | 5.0 |
| `pasteurized_milk` | 4.0 |
| `fresh_produce_generic` | 3.0 |
| `meat_poultry_chilled` | 2.0 |
| `frozen_food_generic` | -18.0 |
| `seafood_fresh_chilled` | 0.0 |

If no category has been set, `DEFAULT_SETPOINT_C` (4.0°C) is used.

## Serial command set (manual-fallback pairing flow)

Bench-test keys: `x` = IR LED test (3 s flashing, view through a phone's front camera), `g` = light strip colour test (red, green, blue, white, 1 s each), `d` = light strip demo (every look, 4.5 s each, its meaning printed). Live console with these keys: `.venv\Scripts\python.exe scripts\esp_console.py`.


Same key bindings as `frostmind_brand_select_ir.ino`, adapted into this
sketch and kept in sync with the BLE manual-pairing commands (both operate
on the same underlying state):

| Key | Action |
|---|---|
| `l` | List all discovered candidate protocols (curated brand-hint order first, see below) |
| `<digits>` + Enter | Jump to candidate index and send its power-on + cool test command |
| `n` | Advance to the next candidate and send |
| `r` | Resend the current command (manual candidate, or paired protocol if not in manual mode) |
| `y` | Confirm + save the currently-selected candidate as the paired protocol |
| `c` | Clear the saved pairing from NVS |
| `+` / `-` | Step target temperature up/down, resend |
| `f` | Cycle fan speed, resend |
| `p` | Toggle power, resend |
| `a` | Start the automatic AC-pairing sweep (baseline → candidate sweep → confirm) |

CSV sensor log (see below) prints continuously over the same serial
connection regardless of which pairing mode is active.

## Status light strip (WS2812 / WS281x, GRB)

An 11-LED RGB strip on pad D3 (GPIO4) shows the device's state at a glance, so nobody needs to
open the phone to see that something is wrong. It's designed to move like a "glyph" light rather
than blink like a traffic light:
- every frame is drawn in floating point, with lights at sub-pixel positions, so a moving light
  glides between LEDs instead of hopping;
- every change of state dissolves over 450 ms (`LED_CROSSFADE_MS`) instead of cutting;
- 60 fps, gamma-corrected and temporally dithered output, so slow fades don't step;
- a curated palette: a frost family (icy white, cyan, glacier blue) for the device's own
  states, softened status colours (mint, lime, amber, coral), and a blue-violet-pink-orange
  gradient reserved for the AI.

`STATUS_LED_COUNT` (11) is the number of LEDs used. `STATUS_LED_BRIGHTNESS` (80/255, applied
after gamma) caps every channel, so USB power is enough.

**Wiring:** strip **5V** → board **5V** pin, **GND** → **GND**, **DIN** → pad **D3** (GPIO4). Connect to the
strip's *input* end: the small arrows printed on the strip point away from it, and the pad says
`DIN` (not `DO`/`DOUT`). A 300-500 Ω resistor in series on DIN is good practice but not required
for a short wire.

What it shows, highest priority first (the same order as `drawLiveStatus()` in the `.ino`):

| Look | Meaning |
|---|---|
| **Frost bloom**: light blooms out from the centre, white core to glacier-blue edge | booted and ready |
| **Handshake**: two lights glide in from the ends, meet and flare | phone connected over Bluetooth |
| **Ripple**: one ring of light running outward | a command from the phone arrived (e.g. `set_category`) |
| **Mint sweep** / **shake** (a coral light shaking side to side, like a wrong password) | AC auto-pairing matched / no match |
| **Spectrum**: the hue circle turning along the strip, a white glint passing through, 5 s | `identify` from the phone: this is the box you're connected to |
| **Coral heartbeat** (lub-dub, about once a second) | device alarm: the same rule that fires the IR intervention. Temperature >3 °C off the category setpoint, changing >3 °C/min, or door open >60 s |
| **Blue-violet-pink wave** flowing along the strip every 4 s (2.6 s if critical) | the backend's AI raised an alert in the last 10 min (e.g. drift from Model 4's setpoint, shelf-life threshold). The explanation is on the phone |
| **Amber light spilling in from both ends** | door open (not yet an alarm) |
| **Ice comet** sweeping end to end over a faint fill | AC auto-pairing running; the fill shows progress through the candidates |
| **Beacon**: a glacier-blue light breathing at the centre | waiting for the phone (Bluetooth not connected) |
| **Shelf-life bar** | shipment running: length = Model 3 shelf life **left** (sub-pixel). Colour slides mint → lime → amber → coral as it drains; a sheen runs along it. Whole strip glowing coral = used up |
| **Thermal aura**: a slowly drifting two-tone glow | connected, no shipment data yet. Mint/ice = on target, warming to amber as it drifts, coral past the alarm threshold |
| Small warm glow | no sensor reading yet |

The three alerts are blended over the scene, so the bar underneath stays readable: "mint bar +
an AI wave every few seconds" reads as "plenty of shelf life left, but the AI has flagged
something".

Shelf life and the backend alert come from the phone (`{"cmd":"led",...}`). The device can't
compute them itself because the product data and the models live on the server. Everything else
is the device's own state, so the strip still works without a phone.

Bench checks:
- `g`: plain red, green, blue, white for 1 s each. If the first colour isn't red, the strip isn't GRB.
- `d`: every look above, 4.5 s each, with its meaning printed to Serial. Good for a demo.

## Threshold-rule alert logic (Model 1, Stage 1 — MVP plan §4)

No trained model yet — a deterministic rule, matching the MVP plan's staged
AI story:

```
rateOfChange = least-squares slope of the last ROLLING_BUFFER_SIZE (6) temp samples, °C/min
tempAlert = |rateOfChange| > RATE_OF_CHANGE_ALERT_THRESH_C_PER_MIN
            OR |temp - setpoint(category)| > SETPOINT_DEVIATION_ALERT_THRESH_C
doorAlert = door open longer than DOOR_OPEN_ALERT_THRESH_MS
alert = tempAlert OR doorAlert
```

On `alert`, if a protocol is paired and the automatic-pairing state machine
is not actively mid-sweep, the paired protocol's power-on/cool/fan-high
command fires — gated by `ALERT_COOLDOWN_MS` so it doesn't spam the AC.

**AC heartbeat.** Independent of alerts: every `AC_HEARTBEAT_INTERVAL_MS`
(5 min by default), the last commanded AC state (whatever it was — an
intervention, or a post-pairing manual `+`/`-`/`p` adjustment) gets
re-sent, even with no new alert. This exists because there's no IR
receiver in this build — a single send can be missed (blocked line of
sight, interference) with no way to confirm it landed, and there's no way
to tell if a human or another remote changed the AC's real state in
between. Periodic re-assertion is the only mitigation available for
either problem without new hardware. It also keeps `ac_last_cmd_ms` (see
the BLE contract below) from ever going stale, which is what the phone
dashboard's "last IR command sent" timestamp relies on as an ongoing
"is the IR path still alive" signal — see `phone-bridge/js/dashboard.js`.
Gated the same way real interventions are: only once a protocol is
paired, at least one real command has been sent, and the pairing FSM
isn't actively mid-sweep.

CSV is logged over Serial every loop iteration (~2s), columns:

```
ts,temp,humidity,door,rate_of_change,session_label
```

`session_label` is intentionally left blank — per the MVP plan, whoever runs
an induced-anomaly logging session fills that column in afterward (session
start/end + what was induced), not the firmware.

## Automatic AC-pairing algorithm (Phase2 plan §3)

1. **Baseline** (`PAIR_BASELINE_WINDOW_MS`, ~60s): sample temperature
   untouched, compute baseline slope via least-squares regression.
2. **Per candidate** (curated brand-hint list first, then the rest of the
   runtime-discovered candidates — see below):
   a. Send `power=ON, mode=COOL, degrees=PAIR_TEST_DEGREES, fan=HIGH` — the
      most distinguishable command available.
   b. Sample for `PAIR_TEST_WINDOW_MS` (~100s), compute slope.
   c. If `baselineSlope - testSlope >= PAIR_MATCH_SLOPE_DELTA_C_PER_MIN`,
      treat as a provisional hit.
   d. **Confirm:** send `power=OFF` on the same protocol, sample for
      `PAIR_CONFIRM_WINDOW_MS` (~45s, shorter). Accept the match only if
      `confirmSlope - testSlope >= PAIR_CONFIRM_REVERSAL_DELTA_C_PER_MIN`
      (the cooling trend flattens/reverses once the AC is told to stop).
      Otherwise, treat the provisional hit as coincidental and continue the
      sweep.
3. **On confirmed match:** persist to NVS (`Preferences`, namespace
   `frostmind`, key `ac_protocol` — the exact same namespace/key
   `frostmind_brand_select_ir.ino` uses, so a pairing done with either
   sketch is recognized by the other) and report `state:"matched"` over BLE.
4. **On no match after the full sweep:** report `state:"no_match"` over BLE
   and fall back to the manual `l`/`n`/`y`-style flow (serial) or
   `manual_pair`/`manual_confirm` (BLE).

### Curated shortlist

Per Phase2 §3.3's "curated shortlist first" mitigation, candidates whose
protocol name (via `typeToString()`) contains one of `kCuratedBrandHints[]`
(common regional AC brand substrings — GREE, DAIKIN, MITSUBISHI, LG,
SAMSUNG, HAIER, VOLTAS, HITACHI, PANASONIC, COOLIX, FUJITSU, TCL, MIDEA,
WHIRLPOOL, CARRIER, TOSHIBA, SHARP, TROTEC, ELECTRA, KELVINATOR, YORK,
AMCOR) are tried before the rest of the sweep. This only reorders the sweep
— every discovered candidate is still tried eventually if nothing in the
curated set matches. Edit `kCuratedBrandHints[]` in the `.ino` freely; it's
not correctness-critical.

### All timing/threshold constants (tune these against real hardware)

None of these have been validated against a real AC — there was no live
hardware available while writing this firmware. They're named constants
near the top of `frostmind_main.ino`, specifically so someone with the
actual rig in front of them can tune them without hunting for magic numbers
in the logic:

| Constant | Default | Meaning |
|---|---|---|
| `SENSOR_SAMPLE_INTERVAL_MS` | 2000 | Main loop cadence — sensor read, CSV log, BLE telemetry notify, pairing-FSM tick |
| `ROLLING_BUFFER_SIZE` | 6 | Samples kept for the rate-of-change regression |
| `RATE_OF_CHANGE_ALERT_THRESH_C_PER_MIN` | 3.0 | \|rate-of-change\| beyond this triggers `tempAlert` |
| `SETPOINT_DEVIATION_ALERT_THRESH_C` | 3.0 | \|temp − setpoint\| beyond this triggers `tempAlert` |
| `DEFAULT_SETPOINT_C` | 4.0 | Setpoint used when no/unknown category is set |
| `DOOR_OPEN_ALERT_THRESH_MS` | 60000 | Door open longer than this triggers `doorAlert` |
| `ALERT_COOLDOWN_MS` | 300000 (5 min) | Minimum gap between auto-fired IR interventions |
| `INTERVENE_COOL_DEGREES` | 18 | Degrees sent on a threshold-triggered intervention |
| `AC_HEARTBEAT_INTERVAL_MS` | 300000 (5 min) | How often the last commanded AC state gets re-sent unconditionally |
| `PAIR_BASELINE_WINDOW_MS` | 60000 | Baseline slope measurement window |
| `PAIR_TEST_WINDOW_MS` | 100000 | Per-candidate test window (spec range: 90–120s) |
| `PAIR_CONFIRM_WINDOW_MS` | 45000 | Post-power-off confirm window |
| `PAIR_MATCH_SLOPE_DELTA_C_PER_MIN` | 0.15 | Candidate slope must be this much more negative than baseline |
| `PAIR_CONFIRM_REVERSAL_DELTA_C_PER_MIN` | 0.10 | Confirm-window slope must rise back by at least this much vs. the test slope |
| `PAIR_TEST_DEGREES` | 16 | "Min degrees" used for the test command — adjust to your AC's actual minimum |

A full 65-protocol sweep is a multi-hour worst case by design (Phase2 §3.3)
— it's meant to run unattended and be polled over BLE
(`{"cmd":"pairing_status"}`), not watched.

## Compile verification

```
arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc --warnings all "firmware\frostmind_main"
```

Verified against `esp32:esp32` core 3.3.11, `IRremoteESP8266` 2.9.0,
`DHT sensor library` 1.4.7 (+ `Adafruit Unified Sensor` 1.1.15), `ArduinoJson`
7.4.3, and the core-bundled BLE library, via `arduino-cli`.

**Result: clean compile, zero errors, zero warnings**, with `--warnings all`:

```
Sketch uses 707953 bytes (54%) of program storage space. Maximum is 1310720 bytes.
Global variables use 28976 bytes (8%) of dynamic memory, leaving 298704 bytes for local variables. Maximum is 327680 bytes.
```

(Slightly smaller than the earlier SHT31/I2C build — the DHT library has a lighter footprint than `Adafruit_SHT31` + `Wire`.)

## Flashed and confirmed on real hardware

This exact build has been uploaded to a real ESP32-S3 (QFN56, rev v0.2, 8MB PSRAM, USB-Serial/JTAG
mode) and hash-verified on every write, twice: once with the default board options (compiled and
uploaded cleanly, but the board went silent after the ROM boot banner — see the `CDCOnBoot`
explanation above), and once with `CDCOnBoot=cdc`, which is the configuration to actually use.

One thing came up along the way, already fixed in the checked-in sketch: the
first compile pass (before removing a manual `BLE2902` CCCD descriptor from
`setupBle()`) succeeded but with one deprecation warning —

```
warning: 'BLE2902' is deprecated: NimBLE does not support manually adding
2902 descriptors as they are automatically added when the characteristic has
notifications or indications enabled. [...] This class will be removed in a
future version.
```

— which both confirms this core build backs the bundled `BLE` library with
NimBLE under the hood (see "BLE library" above) and means the CCCD
descriptor is already added automatically once `PROPERTY_NOTIFY` is set on
`pTxCharacteristic`. Removed the manual `addDescriptor(new BLE2902())` call
and the now-unused `#include <BLE2902.h>`; recompiled clean with no warnings
at all.

## What could not be verified without real hardware

- **Auto-pairing timing/threshold constants** (baseline/test/confirm window
  lengths, slope-delta thresholds, test degrees) are first-pass estimates
  taken directly from the Phase2 plan's example numbers — there was no real
  AC + sensor rig available to calibrate against. They're named constants
  specifically so this is a five-minute edit once real hardware is
  available, not a code change.
- **BLE MTU negotiation in practice**: `BLEDevice::setMTU(185)` sets the
  device's requested/preferred MTU: whether the connection actually
  negotiates up to that value depends on the central (phone) also
  requesting/accepting an extended MTU, which could not be tested without a
  real BLE central connecting to this firmware.
- **`door` boolean polarity**: the JSON contract specifies `"door":<bool>`
  without stating which state is `true`. This firmware sends `true` = door
  OPEN (documented above). If the phone-side implementation assumed the
  opposite, that's a one-line mismatch to catch during integration testing
  — flagging it here since there was no channel to confirm it with whoever
  built the phone side.

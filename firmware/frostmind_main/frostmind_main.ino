/*
 * FROSTMIND -- main deployable firmware
 *
 * ESP32-S3 + DHT11/DHT22 (single-wire temp/humidity, DATA=GPIO8) + MC-38 reed
 * switch (door, GPIO4, INPUT_PULLUP, HIGH=open) + IR transmitter (GPIO6,
 * transmit-only -- no TSOP38238 in this build, nothing is ever received or
 * decoded).
 *
 * SENSOR NOTE: earlier versions of this sketch (and the plan docs) assumed
 * an SHT31-D over I2C. The actual sensor on hand has 3 pins (VCC/GND/DATA),
 * which is a DHT11/DHT22/AM2302 -- not I2C, so it uses one data pin instead
 * of SDA+SCL. Set FROSTMIND_DHT_TYPE below to match what's printed on the
 * sensor body. GPIO9 (the old SCL pin) is now free/unused as a result.
 *
 * Four responsibilities in one sketch, per FROSTMIND_MVP_Implementation_and_
 * AI_Plan §2 and FROSTMIND_Phase2_Implementation_Plan §3/§6 Phase A:
 *
 *   1. Combined sensor + IR logging loop: read the DHT sensor + reed switch,
 *      keep a rolling buffer, compute rate-of-change, apply a threshold-rule
 *      alert (rate-of-change or setpoint deviation), CSV-log over Serial,
 *      and fire a paired IR AC command on alert (cooldown-gated).
 *   2. Automatic AC-protocol identification (Phase2 §3): baseline thermal
 *      drift, then per-candidate-protocol send + sample + confirm, entirely
 *      via the DHT sensor's own temperature feedback -- no IR receiver
 *      needed. Falls back to the manual l/n/y-style flow (adapted from
 *      frostmind_brand_select_ir.ino) when no protocol confirms.
 *   3. BLE peripheral, Nordic UART Service (NUS) pattern -- see README.md for
 *      the exact wire contract (UUIDs + JSON message shapes). This is the
 *      single source of truth for BLE compatibility with the phone app.
 *   4. NVS persistence of the paired AC protocol via Preferences, using the
 *      same namespace/key as frostmind_brand_select_ir.ino so a pairing done
 *      with either sketch is recognized by the other.
 *
 * Libraries: DHT sensor library (Adafruit) + its Adafruit Unified Sensor
 * dependency, IRremoteESP8266 (IRac/IRutils), Preferences (bundled with the
 * esp32 core), ArduinoJson, and the esp32 core's bundled BLE library
 * (BLEDevice.h et al. -- ships inside esp32:esp32 3.3.11 itself, not a
 * Library Manager install; confirmed present at
 * <arduino15>/packages/esp32/hardware/esp32/3.3.11/libraries/BLE). See
 * README.md "BLE library" section for why this was used instead of
 * NimBLE-Arduino.
 */

#include <Arduino.h>
#include <DHT.h>
#include <Preferences.h>
#include <IRac.h>
#include <IRsend.h>
#include <IRutils.h>
#include "driver/gpio.h"
#include <ArduinoJson.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// Set to DHT11 or DHT22 (== AM2302) to match what's printed on the sensor
// body. Everything else in this file is identical either way.
#define FROSTMIND_DHT_TYPE DHT22

// ===========================================================================
// Pin assignments (fixed by the hardware plan -- not tuning constants)
// ===========================================================================
static const uint8_t PIN_DHT = 7;     // DHT11/DHT22 single-wire DATA pin (moved from GPIO8: matches the rewired board, confirmed by a pin scan)
static const uint8_t PIN_REED = 5;    // INPUT_PULLUP, HIGH = door open (see loop()) -- moved from GPIO4 to match the rebuilt board
static const uint16_t PIN_IR_LED = 6;
// GPIO4 and GPIO8 are free (the original reed / DHT pins before the board was rebuilt).
// GPIO9 is free -- it was SCL back when this used an I2C SHT31-D.

// ===========================================================================
// Tunable constants -- sensor/alert logic (MVP plan §2)
// None of these have been validated against real hardware; they are placed
// here, named, so whoever has the physical rig can tune them without hunting
// through the file for magic numbers.
// ===========================================================================
static const unsigned long SENSOR_SAMPLE_INTERVAL_MS = 2000UL;   // main loop cadence (~2s, per spec)
static const int ROLLING_BUFFER_SIZE = 6;                        // "last ~5 samples" per MVP plan §2
static const float RATE_OF_CHANGE_ALERT_THRESH_C_PER_MIN = 3.0f; // |rate-of-change| beyond this triggers tempAlert
static const float SETPOINT_DEVIATION_ALERT_THRESH_C = 3.0f;     // |temp - setpoint| beyond this triggers tempAlert
static const float DEFAULT_SETPOINT_C = 4.0f;                    // used when no/unrecognized category is set
static const unsigned long DOOR_OPEN_ALERT_THRESH_MS = 60UL * 1000UL;   // door open longer than this triggers doorAlert
static const unsigned long ALERT_COOLDOWN_MS = 5UL * 60UL * 1000UL;     // min gap between auto-fired IR commands
static const int INTERVENE_COOL_DEGREES = 18;                    // degrees sent on a threshold-triggered intervention

// Periodic heartbeat: re-sends whatever the AC was last actually told to do, even with no new
// alert. Two real reasons, not just "why not": (1) a single IR send can be missed (line-of-
// sight blocked, interference) -- no receiver in this build means no way to confirm a send
// landed, so periodically re-asserting the same intent is the only mitigation available;
// (2) with no receiver, this device also can't tell if a human (or another remote) changed the
// AC's real state in between -- re-asserting brings it back in line without waiting for a fresh
// alert to trigger a new intervention. Also doubles as the liveness signal the phone
// dashboard's "AC last changed" tile relies on -- see bleSendTelemetry()'s ac_last_cmd_ms.
static const unsigned long AC_HEARTBEAT_INTERVAL_MS = 5UL * 60UL * 1000UL;

// ===========================================================================
// Tunable constants -- automatic AC-pairing algorithm (Phase2 plan §3)
// Worst case (full 65-protocol sweep) is hours long by design (§3.3) -- it is
// meant to run unattended, polled over BLE, not watched. Every window length
// and slope threshold below is a first guess pending a real AC in front of
// someone to calibrate against.
// ===========================================================================
static const unsigned long PAIR_BASELINE_WINDOW_MS = 60UL * 1000UL;     // ~60s untouched baseline slope (§3.2 step 1)
static const unsigned long PAIR_TEST_WINDOW_MS = 100UL * 1000UL;        // ~90-120s test window per candidate (§3.2 step 2b)
static const unsigned long PAIR_CONFIRM_WINDOW_MS = 45UL * 1000UL;      // shorter confirm window after power-off (§3.2 step 2d)
static const float PAIR_MATCH_SLOPE_DELTA_C_PER_MIN = 0.15f;            // candidate slope must be this much more negative than baseline (§3.2 step 2c example)
static const float PAIR_CONFIRM_REVERSAL_DELTA_C_PER_MIN = 0.10f;       // confirm-window slope must rise back by at least this much vs. the test slope
static const int PAIR_TEST_DEGREES = 16;                                // "min degrees" for the maximally-distinguishing test command -- adjust to your AC's real minimum
static const stdAc::fanspeed_t PAIR_TEST_FAN = stdAc::fanspeed_t::kHigh;

// Curated shortlist (§3.3 "curated shortlist first" mitigation): candidates
// whose protocol name contains one of these substrings (case-insensitive)
// are tried before the rest of the sweep. Purely a time-to-typical-match
// optimization -- the full sweep still covers every candidate either way.
// Edit freely; this is not a correctness-critical list.
// SAMSUNG first: that's the actual AC this build gets tested against first,
// per the project's real hardware -- everything else follows in the original
// order as a fallback shortlist.
static const char *const kCuratedBrandHints[] = {
  "SAMSUNG", "GREE", "DAIKIN", "MITSUBISHI", "LG", "HAIER", "VOLTAS",
  "HITACHI", "PANASONIC", "COOLIX", "FUJITSU", "TCL", "MIDEA", "WHIRLPOOL",
  "CARRIER", "TOSHIBA", "SHARP", "TROTEC", "ELECTRA", "KELVINATOR", "YORK",
  "AMCOR",
};
static const int kNumCuratedBrandHints = sizeof(kCuratedBrandHints) / sizeof(kCuratedBrandHints[0]);

// ===========================================================================
// BLE contract constants -- EXACT values, do not change without updating the
// phone-side spec this was built against. See README.md for the full
// message-shape documentation.
// ===========================================================================
static const char *const kBleServiceUuid = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char *const kBleRxCharUuid  = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // phone writes here
static const char *const kBleTxCharUuid  = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // device notifies here
static const char *const kBleDeviceName  = "FROSTMIND";
static const uint16_t kBlePreferredMtu = 185; // extended MTU so one JSON message fits one notification

// ===========================================================================
// NVS (Preferences) -- SAME namespace/key as frostmind_brand_select_ir.ino so
// a pairing done with either sketch is recognized by the other.
// ===========================================================================
static const char *const kPrefsNamespace = "frostmind";
static const char *const kPrefsAcProtocolKey = "ac_protocol";
static const char *const kPrefsCategoryKey = "category";

// ===========================================================================
// Product categories -- must match the 6 keys in scripts/model3_shelf_life.py
// PRODUCT_LIBRARY (Phase2 plan §1). Category only affects the alert setpoint
// here; shelf-life math itself lives in the backend/scripts, not firmware.
// ===========================================================================
struct CategorySetpoint {
  const char *key;
  float setpointC;
};
static const CategorySetpoint kCategorySetpoints[] = {
  {"vaccine_generic", 5.0f},
  {"pasteurized_milk", 4.0f},
  {"fresh_produce_generic", 3.0f},
  {"meat_poultry_chilled", 2.0f},
  {"frozen_food_generic", -18.0f},
  {"seafood_fresh_chilled", 0.0f},
};
static const int kNumCategorySetpoints = sizeof(kCategorySetpoints) / sizeof(kCategorySetpoints[0]);

// ===========================================================================
// Globals -- sensors / IR / NVS
// ===========================================================================
DHT dht(PIN_DHT, FROSTMIND_DHT_TYPE);
IRac ac(PIN_IR_LED);
Preferences prefs;

decode_type_t candidates[128];
int numCandidates = 0;
bool acPaired = false;
int pairedCandidateIdx = -1; // index into candidates[] of the persisted protocol

// "AC current state" as far as this device can tell -- last command actually sent using the
// PAIRED protocol specifically. Deliberately NOT updated by pairing-sweep test sends (auto or
// manual, before a match is confirmed): those use unconfirmed candidate protocols, so there's
// no real basis yet for claiming "the AC is now at this temp." See sendAcTestCommand()'s update
// site for the exact rule. Exposed over BLE telemetry so the phone can show "AC set to X, last
// changed Ys ago" -- see bleSendTelemetry().
int acLastDegrees = 0;
bool acLastPower = false;
stdAc::fanspeed_t acLastFan = stdAc::fanspeed_t::kHigh; // tracked so the heartbeat can resend the exact last state, fan included
unsigned long acLastCmdMs = 0; // millis() at last update; 0 = never commanded this session
bool acEverCommanded = false;

char currentCategory[32] = ""; // empty = unset, DEFAULT_SETPOINT_C used

// Rolling buffer for rate-of-change (main threshold logic)
struct Sample {
  unsigned long tsMs;
  float tempC;
  bool valid;
};
Sample rollingBuffer[ROLLING_BUFFER_SIZE];
int rollingBufferHead = 0; // next write index
int rollingBufferCount = 0;

// Door state tracking
bool doorOpen = false;
unsigned long doorOpenSinceMs = 0; // 0 when door is closed

// Alert cooldown
unsigned long lastInterventionMs = 0; // 0 = never fired yet
bool everIntervened = false;

// Serial CSV header printed once
bool csvHeaderPrinted = false;

// ===========================================================================
// Globals -- BLE
// ===========================================================================
BLEServer *pServer = nullptr;
BLECharacteristic *pTxCharacteristic = nullptr;
BLECharacteristic *pRxCharacteristic = nullptr;
bool bleDeviceConnected = false;
bool bleOldDeviceConnected = false;

// Simple RX hand-off: the BLE write callback (runs in the BLE stack's task)
// only copies the payload out; loop() does the actual command processing so
// nothing IR/NVS/flash-related ever runs from inside a BLE callback.
volatile bool bleCommandPending = false;
String bleCommandBuffer;

// Line-reassembly buffer for incoming BLE writes. The phone chunks each JSON
// command into <=20-byte pieces (WRITE_CHUNK_SIZE in js/ble.js) written as
// separate characteristic writes -- each one fires its own onWrite() call.
// Earlier versions of this file treated every single onWrite() payload as a
// complete command on its own, which is why every real command (including
// every "Try candidate" manual-pairing press) showed up as two
// deserializeJson() failures back to back (IncompleteInput on the first
// partial chunk, InvalidInput on the second) and was silently dropped before
// it ever reached sendAcTestCommand() -- nothing wrong with the LED/wiring at
// all, the command never made it out of BLE parsing. This buffer accumulates
// chunks across onWrite() calls the same way ble.js's _onNotify() already
// does for the TX direction, and only hands a line to loop() once a
// newline has actually been seen.
String bleRxAccumBuffer;

// ===========================================================================
// Globals -- automatic AC-pairing state machine
// ===========================================================================
enum PairingPhase {
  PP_IDLE,
  PP_BASELINE,
  PP_CANDIDATE_WAIT,
  PP_CONFIRM_WAIT,
  PP_MATCHED,
  PP_NO_MATCH,
  PP_MANUAL,
};
PairingPhase pairingPhase = PP_IDLE;
unsigned long pairingPhaseStartMs = 0;
int pairingCandidateIdx = -1; // -1 during baseline (no candidate under test yet)
bool pairingActive = false;   // true whenever the FSM should be sampling / IR should stay quiet otherwise

float pairingBaselineSlope = 0.0f;
float pairingLastTestSlope = 0.0f;

// Running least-squares accumulator used by every pairing phase (baseline,
// per-candidate test, confirm). Reset at the start of each phase.
struct LinRegAccum {
  double sx = 0, sy = 0, sxx = 0, sxy = 0;
  int n = 0;
  unsigned long windowStartMs = 0;

  void reset(unsigned long nowMs) {
    sx = sy = sxx = sxy = 0;
    n = 0;
    windowStartMs = nowMs;
  }

  void addSample(unsigned long nowMs, float tempC) {
    double tSec = (nowMs - windowStartMs) / 1000.0;
    sx += tSec;
    sy += tempC;
    sxx += tSec * tSec;
    sxy += tSec * tempC;
    n++;
  }

  // Slope in degrees C per minute. Returns 0 if not enough data yet.
  float slopeCPerMin() const {
    if (n < 2) return 0.0f;
    double denom = (n * sxx) - (sx * sx);
    if (fabs(denom) < 1e-9) return 0.0f;
    double slopePerSec = ((n * sxy) - (sx * sy)) / denom;
    return static_cast<float>(slopePerSec * 60.0);
  }
};
LinRegAccum pairingAccum;

// Manual fallback state (adapted from frostmind_brand_select_ir.ino)
bool curPower = true;
int curDegrees = 24;
stdAc::fanspeed_t curFan = stdAc::fanspeed_t::kAuto;
const stdAc::fanspeed_t kFanCycle[] = {
  stdAc::fanspeed_t::kAuto, stdAc::fanspeed_t::kLow, stdAc::fanspeed_t::kMedium,
  stdAc::fanspeed_t::kHigh, stdAc::fanspeed_t::kMax,
};
const int kNumFanSteps = sizeof(kFanCycle) / sizeof(kFanCycle[0]);
int fanIdx = 0;

// ===========================================================================
// Forward declarations
// ===========================================================================
void buildCandidateList();
void loadPairing();
void savePairing(int idx);
void clearPairing();
void sendAcTestCommand(int idx, bool power, int degrees, stdAc::fanspeed_t fan);
void sendControlCommand();
void bleSendTelemetry(unsigned long nowMs, float tempC, float humidity, bool doorIsOpen, float rateOfChange, bool alertNow);
void bleSendPairingStatus();
void processBleCommand(const String &json);
void handleSerialInput();
void startAutoPairing();
void beginCandidateTest(unsigned long nowMs);
void beginConfirmPhase(unsigned long nowMs);
void advanceToNextCandidateOrFinish(unsigned long nowMs);
void acceptMatch(int idx);
void updatePairingFsm(unsigned long nowMs, float latestTemp);
void manualJumpAndSend(int idx);
void manualConfirmSave();
float getSetpointForCurrentCategory();
void pushRollingSample(unsigned long nowMs, float tempC);
float computeRateOfChangeCPerMin();
void logCsvRow(unsigned long nowMs, float tempC, float humidity, bool doorIsOpen, float rateOfChange);
const char *pairingPhaseToContractState();

// ===========================================================================
// Candidate discovery + NVS persistence (reused pattern from
// frostmind_brand_select_ir.ino, per the task's explicit instruction to
// reuse rather than reinvent it)
// ===========================================================================
void buildCandidateList() {
  numCandidates = 0;
  for (int i = 1; i <= kLastDecodeType && numCandidates < 128; i++) {
    decode_type_t p = static_cast<decode_type_t>(i);
    if (IRac::isProtocolSupported(p)) {
      candidates[numCandidates++] = p;
    }
  }

  // Curated-first reorder (Phase2 §3.3 mitigation): stable-partition so
  // candidates matching a brand hint come first, in hint-list order, with
  // every other discovered candidate following in its original order.
  decode_type_t reordered[128];
  bool used[128] = {false};
  int outIdx = 0;

  for (int h = 0; h < kNumCuratedBrandHints; h++) {
    for (int i = 0; i < numCandidates; i++) {
      if (used[i]) continue;
      String name = typeToString(candidates[i]);
      name.toUpperCase();
      if (name.indexOf(kCuratedBrandHints[h]) >= 0) {
        reordered[outIdx++] = candidates[i];
        used[i] = true;
      }
    }
  }
  for (int i = 0; i < numCandidates; i++) {
    if (!used[i]) {
      reordered[outIdx++] = candidates[i];
      used[i] = true;
    }
  }
  for (int i = 0; i < numCandidates; i++) candidates[i] = reordered[i];
}

void loadPairing() {
  prefs.begin(kPrefsNamespace, /*readOnly=*/true);
  int saved = prefs.getInt(kPrefsAcProtocolKey, -1);
  String cat = prefs.getString(kPrefsCategoryKey, "");
  prefs.end();

  if (cat.length() > 0 && cat.length() < sizeof(currentCategory)) {
    strncpy(currentCategory, cat.c_str(), sizeof(currentCategory) - 1);
  }

  if (saved < 0) {
    Serial.println("No AC paired yet.");
    return;
  }
  for (int i = 0; i < numCandidates; i++) {
    if (static_cast<int>(candidates[i]) == saved) {
      pairedCandidateIdx = i;
      acPaired = true;
      Serial.print("Loaded previously paired protocol: ");
      Serial.println(typeToString(candidates[i]).c_str());
      return;
    }
  }
  Serial.println("Saved pairing found but its protocol isn't in this build's candidate list (library version changed?). Re-pair.");
}

void savePairing(int idx) {
  prefs.begin(kPrefsNamespace, /*readOnly=*/false);
  prefs.putInt(kPrefsAcProtocolKey, static_cast<int>(candidates[idx]));
  prefs.end();
  acPaired = true;
  pairedCandidateIdx = idx;
}

void clearPairing() {
  prefs.begin(kPrefsNamespace, /*readOnly=*/false);
  prefs.remove(kPrefsAcProtocolKey);
  prefs.end();
  acPaired = false;
  pairedCandidateIdx = -1;
  Serial.println("Pairing cleared.");
}

void saveCategory(const char *cat) {
  prefs.begin(kPrefsNamespace, /*readOnly=*/false);
  prefs.putString(kPrefsCategoryKey, cat);
  prefs.end();
}

// ===========================================================================
// IR command helpers
// ===========================================================================
void sendAcTestCommand(int idx, bool power, int degrees, stdAc::fanspeed_t fan) {
  if (idx < 0 || idx >= numCandidates) return;
  ac.next.protocol = candidates[idx];
  ac.next.model    = -1; // library default variant for that protocol
  ac.next.power    = power;
  ac.next.mode     = stdAc::opmode_t::kCool;
  ac.next.degrees  = degrees;
  ac.next.fanspeed = fan;
  ac.next.swingv   = stdAc::swingv_t::kOff;
  ac.next.swingh   = stdAc::swingh_t::kOff;
  ac.sendAc();

  // Only a send on the CONFIRMED paired protocol counts as real "AC state" -- pairing-sweep
  // sends (auto or manual, idx pointing at an as-yet-unconfirmed candidate) don't get to claim
  // the AC actually changed, since that's exactly what hasn't been confirmed yet.
  if (acPaired && idx == pairedCandidateIdx) {
    acLastDegrees = degrees;
    acLastPower = power;
    acLastFan = fan;
    acLastCmdMs = millis();
    acEverCommanded = true;
  }

  Serial.printf(">> [%d/%d] %s | power=%s cool=%dC fan=%d\n",
                idx + 1, numCandidates, typeToString(candidates[idx]).c_str(),
                power ? "on" : "off", degrees, static_cast<int>(fan));
}

// Post-pairing / manual sanity-check control (adapted from
// frostmind_brand_select_ir.ino's sendCurrent()) -- operates on whichever
// protocol is "active": the manual candidate while in PP_MANUAL, otherwise
// the persisted paired protocol.
void sendControlCommand() {
  int idx = (pairingPhase == PP_MANUAL) ? pairingCandidateIdx : pairedCandidateIdx;
  if (idx < 0 || idx >= numCandidates) {
    Serial.println("No protocol selected/paired yet -- nothing to send.");
    return;
  }
  sendAcTestCommand(idx, curPower, curDegrees, curFan);
}

// Threshold-triggered intervention, using whatever protocol is currently
// paired in NVS (MVP plan §2: "sendPairedIRCommand()").
void sendPairedIntervention() {
  if (!acPaired || pairedCandidateIdx < 0) return;
  sendAcTestCommand(pairedCandidateIdx, /*power=*/true, INTERVENE_COOL_DEGREES, stdAc::fanspeed_t::kHigh);
}

// ===========================================================================
// Category -> setpoint
// ===========================================================================
float getSetpointForCurrentCategory() {
  if (currentCategory[0] == '\0') return DEFAULT_SETPOINT_C;
  for (int i = 0; i < kNumCategorySetpoints; i++) {
    if (strcmp(kCategorySetpoints[i].key, currentCategory) == 0) {
      return kCategorySetpoints[i].setpointC;
    }
  }
  return DEFAULT_SETPOINT_C;
}

bool isValidCategory(const char *cat) {
  for (int i = 0; i < kNumCategorySetpoints; i++) {
    if (strcmp(kCategorySetpoints[i].key, cat) == 0) return true;
  }
  return false;
}

// ===========================================================================
// Rolling buffer + rate-of-change (MVP plan §2 pseudocode)
// ===========================================================================
void pushRollingSample(unsigned long nowMs, float tempC) {
  rollingBuffer[rollingBufferHead] = {nowMs, tempC, true};
  rollingBufferHead = (rollingBufferHead + 1) % ROLLING_BUFFER_SIZE;
  if (rollingBufferCount < ROLLING_BUFFER_SIZE) rollingBufferCount++;
}

// Least-squares slope (°C/min) over whatever is currently in the rolling
// buffer (oldest..newest), regardless of insertion order.
float computeRateOfChangeCPerMin() {
  if (rollingBufferCount < 2) return 0.0f;

  // Find the oldest valid sample's timestamp to use as t=0 reference.
  int oldestIdx = (rollingBufferCount < ROLLING_BUFFER_SIZE)
                       ? 0
                       : rollingBufferHead; // when full, head points at the oldest (next to be overwritten)
  unsigned long t0 = rollingBuffer[oldestIdx].tsMs;

  double sx = 0, sy = 0, sxx = 0, sxy = 0;
  int n = 0;
  for (int i = 0; i < rollingBufferCount; i++) {
    int idx = (oldestIdx + i) % ROLLING_BUFFER_SIZE;
    if (!rollingBuffer[idx].valid) continue;
    double tSec = (rollingBuffer[idx].tsMs - t0) / 1000.0;
    double y = rollingBuffer[idx].tempC;
    sx += tSec;
    sy += y;
    sxx += tSec * tSec;
    sxy += tSec * y;
    n++;
  }
  if (n < 2) return 0.0f;
  double denom = (n * sxx) - (sx * sx);
  if (fabs(denom) < 1e-9) return 0.0f;
  double slopePerSec = ((n * sxy) - (sx * sy)) / denom;
  return static_cast<float>(slopePerSec * 60.0);
}

// ===========================================================================
// CSV logging (MVP plan §2: "this line is your future training data")
// Columns: ts,temp,humidity,door,rate_of_change,session_label
// session_label is intentionally left blank -- filled in later by whoever
// runs an induced-anomaly logging session (MVP plan §4).
// ===========================================================================
void logCsvRow(unsigned long nowMs, float tempC, float humidity, bool doorIsOpen, float rateOfChange) {
  if (!csvHeaderPrinted) {
    Serial.println("ts,temp,humidity,door,rate_of_change,session_label");
    csvHeaderPrinted = true;
  }
  Serial.printf("%lu,%.2f,%.2f,%d,%.3f,\n", nowMs, tempC, humidity, doorIsOpen ? 1 : 0, rateOfChange);
}

// ===========================================================================
// BLE: telemetry + pairing_status TX messages (ArduinoJson, per spec --
// no hand-rolled JSON string building)
// ===========================================================================
void bleNotify(JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  out += '\n'; // newline-delimited JSON, one object per message
  if (pTxCharacteristic == nullptr) return;
  pTxCharacteristic->setValue(reinterpret_cast<const uint8_t *>(out.c_str()), out.length());
  if (bleDeviceConnected) {
    pTxCharacteristic->notify();
  }
}

void bleSendTelemetry(unsigned long nowMs, float tempC, float humidity, bool doorIsOpen, float rateOfChange, bool alertNow) {
  JsonDocument doc;
  doc["ts"] = nowMs;
  doc["temp"] = tempC;
  doc["hum"] = humidity;
  doc["door"] = doorIsOpen; // true = door OPEN (see README BLE contract note)
  doc["roc"] = rateOfChange;
  doc["alert"] = alertNow;
  // AC state (only meaningful once acEverCommanded -- see the tracking rule at the
  // sendAcTestCommand() update site). ac_last_cmd_ms is a millis()-since-boot value, same clock
  // as `ts` in this same message -- the phone computes "how long ago" as ts - ac_last_cmd_ms
  // rather than needing any wall-clock time from a device that doesn't have one.
  doc["ac_commanded"] = acEverCommanded;
  if (acEverCommanded) {
    doc["ac_degrees"] = acLastDegrees;
    doc["ac_power"] = acLastPower;
    doc["ac_last_cmd_ms"] = acLastCmdMs;
  }
  bleNotify(doc);
}

const char *pairingPhaseToContractState() {
  switch (pairingPhase) {
    case PP_IDLE: return "idle";
    case PP_MATCHED: return "matched";
    case PP_NO_MATCH: return "no_match";
    case PP_BASELINE:
    case PP_CANDIDATE_WAIT:
    case PP_CONFIRM_WAIT:
    case PP_MANUAL:
    default: return "scanning";
  }
}

void bleSendPairingStatus() {
  JsonDocument doc;
  doc["type"] = "pairing_status";
  doc["state"] = pairingPhaseToContractState();
  doc["candidate_index"] = pairingCandidateIdx;
  doc["total"] = numCandidates;
  bleNotify(doc);
}

// ===========================================================================
// BLE: RX command handling (device <- phone). Runs from loop(), not from the
// BLE callback -- see bleCommandPending/bleCommandBuffer above.
// ===========================================================================
void processBleCommand(const String &jsonIn) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, jsonIn);
  if (err) {
    Serial.print("BLE RX: JSON parse error: ");
    Serial.println(err.c_str());
    return;
  }

  const char *cmd = doc["cmd"] | "";
  if (strcmp(cmd, "set_category") == 0) {
    const char *cat = doc["category"] | "";
    if (isValidCategory(cat)) {
      strncpy(currentCategory, cat, sizeof(currentCategory) - 1);
      currentCategory[sizeof(currentCategory) - 1] = '\0';
      saveCategory(currentCategory);
      Serial.print("BLE: category set to ");
      Serial.println(currentCategory);
    } else {
      Serial.print("BLE: rejected unknown category: ");
      Serial.println(cat);
    }
  } else if (strcmp(cmd, "start_pairing") == 0) {
    Serial.println("BLE: start_pairing received.");
    startAutoPairing();
  } else if (strcmp(cmd, "pairing_status") == 0) {
    bleSendPairingStatus(); // "reply immediately with current state"
  } else if (strcmp(cmd, "manual_pair") == 0) {
    int idx = doc["index"] | -1;
    Serial.print("BLE: manual_pair index=");
    Serial.println(idx);
    manualJumpAndSend(idx);
  } else if (strcmp(cmd, "manual_confirm") == 0) {
    Serial.println("BLE: manual_confirm received.");
    manualConfirmSave();
  } else {
    Serial.print("BLE: unrecognized cmd: ");
    Serial.println(cmd);
  }
}

// ===========================================================================
// BLE server/characteristic callbacks
// ===========================================================================
class FrostmindServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    bleDeviceConnected = true;
    Serial.println("BLE: phone connected.");
  }
  void onDisconnect(BLEServer *server) override {
    bleDeviceConnected = false;
    Serial.println("BLE: phone disconnected.");
  }
};

class FrostmindRxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    String value = characteristic->getValue();
    if (value.length() == 0) return;

    // Accumulate this chunk -- do NOT treat it as a complete command yet.
    bleRxAccumBuffer += value;

    // Pull out every complete newline-terminated line currently buffered.
    // Normally there's at most one per onWrite() call, but handle multiple
    // in case the stack ever coalesces writes.
    int newlineIndex;
    while ((newlineIndex = bleRxAccumBuffer.indexOf('\n')) != -1) {
      String line = bleRxAccumBuffer.substring(0, newlineIndex);
      bleRxAccumBuffer.remove(0, newlineIndex + 1);
      while (line.length() > 0 && line[line.length() - 1] == '\r') {
        line.remove(line.length() - 1);
      }
      if (line.length() == 0) continue; // stray blank line, nothing to do
      // Only one pending command slot -- if a second complete line arrives
      // before loop() drains the first, the newer one wins. Commands are
      // low-frequency user-driven actions here, not a stream, so this is a
      // non-issue in practice.
      bleCommandBuffer = line;
      bleCommandPending = true;
    }
  }
};

void setupBle() {
  BLEDevice::init(kBleDeviceName);
  BLEDevice::setMTU(kBlePreferredMtu); // request extended MTU so one JSON message fits one notification

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new FrostmindServerCallbacks());

  BLEService *pService = pServer->createService(kBleServiceUuid);

  // No manual BLE2902 (CCCD) descriptor here: this core build backs the
  // library with NimBLE (confirmed by compiling -- see README), which
  // auto-adds the CCCD descriptor whenever a characteristic has
  // PROPERTY_NOTIFY set. Adding one manually compiles but is deprecated and
  // redundant under NimBLE.
  pTxCharacteristic = pService->createCharacteristic(kBleTxCharUuid, BLECharacteristic::PROPERTY_NOTIFY);

  pRxCharacteristic = pService->createCharacteristic(kBleRxCharUuid, BLECharacteristic::PROPERTY_WRITE);
  pRxCharacteristic->setCallbacks(new FrostmindRxCallbacks());

  pService->start();

  // Advertise the NUS service UUID itself, not just the device name -- without this,
  // navigator.bluetooth.requestDevice({filters:[{services:[UUID]}]}) on the phone side has
  // nothing to match against (its filter matches on *advertised* service UUIDs, not on
  // whatever the GATT server happens to expose once connected) and the device silently never
  // appears in the picker, even though everything else about the BLE stack is working fine.
  // A 128-bit UUID doesn't fit in the 31-byte primary advertising packet alongside the device
  // name, so it's also worth enabling the scan response packet to carry it.
  BLEAdvertising *pAdvertising = pServer->getAdvertising();
  pAdvertising->addServiceUUID(kBleServiceUuid);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();
  Serial.println("BLE: advertising as \"FROSTMIND\" (Nordic UART Service, service UUID in adv payload).");
}

void serviceBleConnectionState() {
  if (!bleDeviceConnected && bleOldDeviceConnected) {
    delay(500); // give the BLE stack time to settle before re-advertising
    pServer->startAdvertising();
    Serial.println("BLE: restarted advertising after disconnect.");
    bleOldDeviceConnected = false;
  }
  if (bleDeviceConnected && !bleOldDeviceConnected) {
    bleOldDeviceConnected = true;
  }
}

// ===========================================================================
// Automatic AC-pairing state machine (Phase2 plan §3.2)
// ===========================================================================
void startAutoPairing() {
  Serial.println("=== Auto AC-pairing: starting baseline measurement (~60s, untouched) ===");
  pairingCandidateIdx = -1;
  pairingPhase = PP_BASELINE;
  pairingPhaseStartMs = millis();
  pairingActive = true;
  pairingAccum.reset(pairingPhaseStartMs);
  bleSendPairingStatus();
}

void beginCandidateTest(unsigned long nowMs) {
  Serial.printf("=== Auto AC-pairing: testing candidate %d/%d (%s) ===\n",
                pairingCandidateIdx + 1, numCandidates, typeToString(candidates[pairingCandidateIdx]).c_str());
  sendAcTestCommand(pairingCandidateIdx, /*power=*/true, PAIR_TEST_DEGREES, PAIR_TEST_FAN);
  pairingPhase = PP_CANDIDATE_WAIT;
  pairingPhaseStartMs = nowMs;
  pairingAccum.reset(nowMs);
  bleSendPairingStatus();
}

void beginConfirmPhase(unsigned long nowMs) {
  Serial.println("=== Auto AC-pairing: provisional hit -- confirming with power-off ===");
  sendAcTestCommand(pairingCandidateIdx, /*power=*/false, PAIR_TEST_DEGREES, PAIR_TEST_FAN);
  pairingPhase = PP_CONFIRM_WAIT;
  pairingPhaseStartMs = nowMs;
  pairingAccum.reset(nowMs);
}

void advanceToNextCandidateOrFinish(unsigned long nowMs) {
  pairingCandidateIdx++;
  if (pairingCandidateIdx >= numCandidates) {
    pairingPhase = PP_NO_MATCH;
    pairingActive = false;
    Serial.println("=== Auto AC-pairing: no match after full sweep. Use manual fallback (serial l/n/y, or BLE manual_pair/manual_confirm). ===");
    bleSendPairingStatus();
  } else {
    beginCandidateTest(nowMs);
  }
}

void acceptMatch(int idx) {
  savePairing(idx);
  pairingCandidateIdx = idx;
  pairingPhase = PP_MATCHED;
  pairingActive = false;
  Serial.print("=== Auto AC-pairing: MATCHED and saved: ");
  Serial.println(typeToString(candidates[idx]).c_str());
  bleSendPairingStatus();
}

void updatePairingFsm(unsigned long nowMs, float latestTemp) {
  unsigned long elapsed;
  switch (pairingPhase) {
    case PP_IDLE:
    case PP_MATCHED:
    case PP_NO_MATCH:
    case PP_MANUAL:
      return; // no timer-driven transition in these phases

    case PP_BASELINE:
      pairingAccum.addSample(nowMs, latestTemp);
      elapsed = nowMs - pairingPhaseStartMs;
      if (elapsed >= PAIR_BASELINE_WINDOW_MS) {
        pairingBaselineSlope = pairingAccum.slopeCPerMin();
        Serial.printf("=== Auto AC-pairing: baseline slope = %.3f C/min ===\n", pairingBaselineSlope);
        pairingCandidateIdx = 0;
        if (numCandidates == 0) {
          pairingPhase = PP_NO_MATCH;
          pairingActive = false;
          Serial.println("=== Auto AC-pairing: no candidate protocols discovered -- nothing to test. ===");
          bleSendPairingStatus();
        } else {
          beginCandidateTest(nowMs);
        }
      }
      break;

    case PP_CANDIDATE_WAIT:
      pairingAccum.addSample(nowMs, latestTemp);
      elapsed = nowMs - pairingPhaseStartMs;
      if (elapsed >= PAIR_TEST_WINDOW_MS) {
        pairingLastTestSlope = pairingAccum.slopeCPerMin();
        float delta = pairingBaselineSlope - pairingLastTestSlope;
        Serial.printf("=== Auto AC-pairing: candidate %d test slope = %.3f C/min (delta vs baseline = %.3f) ===\n",
                      pairingCandidateIdx + 1, pairingLastTestSlope, delta);
        if (delta >= PAIR_MATCH_SLOPE_DELTA_C_PER_MIN) {
          beginConfirmPhase(nowMs);
        } else {
          advanceToNextCandidateOrFinish(nowMs);
        }
      }
      break;

    case PP_CONFIRM_WAIT:
      pairingAccum.addSample(nowMs, latestTemp);
      elapsed = nowMs - pairingPhaseStartMs;
      if (elapsed >= PAIR_CONFIRM_WINDOW_MS) {
        float confirmSlope = pairingAccum.slopeCPerMin();
        float reversal = confirmSlope - pairingLastTestSlope;
        Serial.printf("=== Auto AC-pairing: candidate %d confirm slope = %.3f C/min (reversal = %.3f) ===\n",
                      pairingCandidateIdx + 1, confirmSlope, reversal);
        if (reversal >= PAIR_CONFIRM_REVERSAL_DELTA_C_PER_MIN) {
          acceptMatch(pairingCandidateIdx);
        } else {
          Serial.println("=== Auto AC-pairing: confirm step failed (no flatten/reverse) -- treating as coincidental, continuing sweep. ===");
          advanceToNextCandidateOrFinish(nowMs);
        }
      }
      break;
  }
}

// ===========================================================================
// Manual fallback (adapted from frostmind_brand_select_ir.ino) -- reachable
// both from the Serial l/n/y-style flow and from BLE manual_pair/manual_confirm.
// ===========================================================================
void manualJumpAndSend(int idx) {
  if (idx < 0 || idx >= numCandidates) {
    Serial.println("Manual pairing: index out of range.");
    return;
  }
  pairingPhase = PP_MANUAL;
  pairingActive = true;
  pairingCandidateIdx = idx;
  curPower = true;
  sendAcTestCommand(idx, curPower, curDegrees, curFan);
  Serial.println("Watch the real AC. 'y' (serial) or manual_confirm (BLE) if it reacted, or pick another index.");
  bleSendPairingStatus();
}

void manualConfirmSave() {
  int idx = (pairingCandidateIdx >= 0) ? pairingCandidateIdx : 0;
  if (idx >= numCandidates) {
    Serial.println("Manual pairing: nothing valid selected yet.");
    return;
  }
  acceptMatch(idx);
  Serial.println("*** Manual pairing confirmed and saved. Loads automatically after reboot. Try +/-/f/p to sanity-check control. ***");
}

void printCandidates() {
  Serial.printf("%d AC protocols supported by this library build (curated brand hints first):\n", numCandidates);
  for (int i = 0; i < numCandidates; i++) {
    Serial.printf("  %3d: %s\n", i, typeToString(candidates[i]).c_str());
  }
}

void printMenu() {
  Serial.println();
  Serial.println("=== FROSTMIND manual AC-pairing fallback (used when auto-pairing finds no match) ===");
  Serial.println("l = list candidates | <digits>+Enter = jump to index & send | n = next candidate");
  Serial.println("r = resend current   | y = confirm+save this protocol        | c = clear saved pairing");
  Serial.println("+/- = temp up/down   | f = cycle fan speed                   | p = power toggle");
  Serial.println("a = start automatic pairing sweep");
  Serial.println("(+, -, f, p all resend using the currently selected/paired protocol)");
  Serial.println("x = IR LED test (3 s flashing, view through a phone camera)");
}

// Wiring check for the IR LED: 38 kHz carrier switched on/off at 2 Hz, so it shows as a clear
// flicker through a phone camera (IR is invisible to the eye). Blocks for `seconds` -- it's a
// bench test, not something the alert path ever calls.
void irLedTest(uint16_t pin, int seconds, bool weakDrive) {
  IRsend tester(pin);
  tester.begin();
  if (weakDrive) {
    // weakest pad drive (~5 mA): safe even if this pin turns out to be wired straight to GND
    gpio_set_drive_capability((gpio_num_t)pin, GPIO_DRIVE_CAP_0);
  }
  tester.enableIROut(38);
  Serial.printf(">>> IR LED TEST: GPIO%u flashing for %d s -- look through a phone camera <<<\n", pin, seconds);
  for (int half = 0; half < seconds * 2; half++) {
    for (int k = 0; k < 5; k++) tester.mark(50000);  // 250 ms of carrier (mark() takes <= 65535 us)
    tester.space(250000);                            // 250 ms off
  }
  if (weakDrive) gpio_set_drive_capability((gpio_num_t)pin, GPIO_DRIVE_CAP_DEFAULT);
  Serial.printf(">>> IR LED TEST: GPIO%u done <<<\n", pin);
}

String serialInputBuf = "";

void handleSerialInput() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n' || c == '\r') {
      if (serialInputBuf.length() > 0) {
        int idx = serialInputBuf.toInt();
        serialInputBuf = "";
        manualJumpAndSend(idx);
      }
      continue;
    }

    if (isDigit(c)) {
      serialInputBuf += c;
      continue;
    }

    switch (c) {
      case 'l':
        printCandidates();
        break;
      case 'n': {
        int next = (pairingCandidateIdx < 0) ? 0 : (pairingCandidateIdx + 1) % numCandidates;
        manualJumpAndSend(next);
        break;
      }
      case 'r':
        sendControlCommand();
        break;
      case 'y':
        manualConfirmSave();
        break;
      case 'c':
        clearPairing();
        break;
      case '+':
        curDegrees++;
        sendControlCommand();
        break;
      case '-':
        curDegrees--;
        sendControlCommand();
        break;
      case 'f':
        fanIdx = (fanIdx + 1) % kNumFanSteps;
        curFan = kFanCycle[fanIdx];
        sendControlCommand();
        break;
      case 'p':
        curPower = !curPower;
        sendControlCommand();
        break;
      case 'a':
        startAutoPairing();
        break;
      case 'x':
        irLedTest(PIN_IR_LED, 3, false);
        break;
      default:
        break;
    }
  }
}

// ===========================================================================
// setup() / loop()
// ===========================================================================
unsigned long lastSensorSampleMs = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);

  dht.begin();

  pinMode(PIN_REED, INPUT_PULLUP);

  buildCandidateList();
  Serial.printf("%d candidate AC protocols found in this library build.\n", numCandidates);

  loadPairing(); // also restores currentCategory from NVS

  setupBle();
  printMenu();

  lastSensorSampleMs = millis();
}

void loop() {
  // Always-responsive paths: serial manual fallback, and BLE RX commands
  // (processed here rather than in the BLE callback so nothing IR/NVS-
  // related runs from BLE stack context).
  handleSerialInput();
  serviceBleConnectionState();
  if (bleCommandPending) {
    bleCommandPending = false;
    String cmd = bleCommandBuffer;
    processBleCommand(cmd);
  }

  unsigned long now = millis();
  if (now - lastSensorSampleMs < SENSOR_SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSensorSampleMs = now;

  // --- 1. Read sensors ---
  float tempC = dht.readTemperature();
  float humidity = dht.readHumidity();
  // Standard N.O. reed switch, magnet on the door: magnet near (door closed)
  // closes the contacts -> pin reads LOW. Magnet away (door open) -> contacts
  // separate -> internal pull-up holds the pin HIGH. So HIGH = open, not LOW
  // -- confirmed against real hardware after the original LOW=open assumption
  // tested backwards (reed switch showed closed(0) even with the door open).
  bool rawDoorOpen = (digitalRead(PIN_REED) == HIGH);

  if (rawDoorOpen && !doorOpen) {
    doorOpenSinceMs = now;
  } else if (!rawDoorOpen) {
    doorOpenSinceMs = 0;
  }
  doorOpen = rawDoorOpen;

  bool tempValid = !isnan(tempC) && !isnan(humidity);
  if (tempValid) {
    pushRollingSample(now, tempC);
  }

  // --- 2. Rate of change + threshold-rule alert (MVP plan §2) ---
  float rateOfChange = computeRateOfChangeCPerMin();
  float setpoint = getSetpointForCurrentCategory();
  bool tempAlert = tempValid &&
                    ((fabs(rateOfChange) > RATE_OF_CHANGE_ALERT_THRESH_C_PER_MIN) ||
                     (fabs(tempC - setpoint) > SETPOINT_DEVIATION_ALERT_THRESH_C));
  unsigned long doorOpenDurationMs = doorOpen ? (now - doorOpenSinceMs) : 0;
  bool doorAlert = doorOpen && (doorOpenDurationMs > DOOR_OPEN_ALERT_THRESH_MS);
  bool alertNow = tempAlert || doorAlert;

  // --- 3. CSV log (this line is the future training-data stream) ---
  logCsvRow(now, tempC, humidity, doorOpen, rateOfChange);

  // --- 4. Fire paired IR command on alert, cooldown-gated, but never while
  //        the pairing FSM itself is actively transmitting test commands
  //        (avoids interference with in-progress pairing). ---
  bool cooldownExpired = !everIntervened || (now - lastInterventionMs >= ALERT_COOLDOWN_MS);
  if (alertNow && acPaired && !pairingActive && cooldownExpired) {
    Serial.println(">>> ALERT: firing paired IR intervention command. <<<");
    sendPairedIntervention();
    lastInterventionMs = now;
    everIntervened = true;
  }

  // --- 4b. Heartbeat: re-send the last commanded AC state every AC_HEARTBEAT_INTERVAL_MS,
  //         even with no new alert (see the constant's comment for why this exists). Uses
  //         acLastCmdMs -- the same field a real intervention or a post-pairing manual
  //         adjustment also updates -- so any real activity naturally pushes the next
  //         heartbeat out by another full interval instead of it firing redundantly right
  //         after something else already re-asserted the state. ---
  if (acPaired && acEverCommanded && !pairingActive && (now - acLastCmdMs >= AC_HEARTBEAT_INTERVAL_MS)) {
    Serial.println(">>> AC heartbeat: re-sending last commanded state. <<<");
    sendAcTestCommand(pairedCandidateIdx, acLastPower, acLastDegrees, acLastFan);
  }

  // --- 5. BLE telemetry notify (~every 2s, per spec) ---
  bleSendTelemetry(now, tempC, humidity, doorOpen, rateOfChange, alertNow);

  // --- 6. Advance the automatic AC-pairing state machine, if running ---
  if (tempValid) {
    updatePairingFsm(now, tempC);
  }
}

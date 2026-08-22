/*
 * FROSTMIND -- Universal AC pairing (Mi Remote style, transmit-only)
 *
 * No IR receiver in this build -- no TSOP38238 sourced -- so nothing is ever
 * received or decoded. This is the PRIMARY AC-control strategy, not a
 * fallback: walk every AC protocol IRremoteESP8266's IRac class knows how to
 * build a full command for, transmit a power-on+cool24 command for each, and
 * let a human confirm by eye which one the real AC reacts to. Once confirmed,
 * that protocol is written to flash (Preferences/NVS) so it survives reboot
 * -- that's the "pairing." After pairing, '+'/'-'/'f'/'p' let you sanity-check
 * temp/fan/power control with the same locked-in protocol.
 *
 * Candidate protocols are discovered at runtime via IRac::isProtocolSupported()
 * rather than hand-typed -- avoids guessing at decode_type_t enum names (the
 * previous version of this file hand-listed 7 and flagged that risk directly;
 * scanning removes the risk instead of just flagging it) and it's genuinely
 * "universal": whatever protocols your installed IRremoteESP8266 version
 * supports, this will offer, with no maintenance needed as the library grows.
 *
 * VERIFIED: compiled clean (esp32:esp32:esp32s3, IRremoteESP8266 2.9.0, esp32
 * core 3.3.11, arduino-cli) 2026-08-21 -- 65 protocols discovered at runtime
 * in that library version. Confirmed against the actual source, not assumed:
 * `kLastDecodeType = EUROM` in IRremoteESP8266.h is the last *valid* enum
 * value (not a count), so `i <= kLastDecodeType` is the correct bound, and
 * `ac.begin()` from the original brand-select version of this file doesn't
 * exist on IRac -- removed (the IRac(pin) constructor already does it).
 * If you're on a materially different library version and it doesn't
 * compile, update via Arduino IDE -> Library Manager first.
 *
 * If your AC's brand genuinely never reacts to anything this offers: this
 * project is not using IRDB, LIRC, or a TSOP38238/IR receiver -- not
 * deferred, ruled out. A full-sweep miss means this AC can't be controlled
 * by this system as currently scoped; there is no fallback path.
 *
 * Library: IRremoteESP8266 (Arduino IDE -> Sketch -> Include Library ->
 * Manage Libraries -> search "IRremoteESP8266" -> Install).
 */

#include <Preferences.h>
#include <IRac.h>
#include <IRutils.h>

const uint16_t kIrLedPin = 6;  // matches the MVP wiring guide

IRac ac(kIrLedPin);
Preferences prefs;

const char* kPrefsNamespace = "frostmind";
const char* kPrefsKey = "ac_protocol";

decode_type_t candidates[128];
int numCandidates = 0;
int selected = 0;
bool paired = false;

// Command state -- reused for both discovery sends and post-pairing testing.
bool curPower = true;
int curDegrees = 24;
stdAc::fanspeed_t curFan = stdAc::fanspeed_t::kAuto;

const stdAc::fanspeed_t kFanCycle[] = {
  stdAc::fanspeed_t::kAuto, stdAc::fanspeed_t::kLow, stdAc::fanspeed_t::kMedium,
  stdAc::fanspeed_t::kHigh, stdAc::fanspeed_t::kMax,
};
const int kNumFanSteps = sizeof(kFanCycle) / sizeof(kFanCycle[0]);
int fanIdx = 0;

void buildCandidateList() {
  numCandidates = 0;
  for (int i = 1; i <= kLastDecodeType && numCandidates < 128; i++) {
    decode_type_t p = static_cast<decode_type_t>(i);
    if (IRac::isProtocolSupported(p)) {
      candidates[numCandidates++] = p;
    }
  }
}

void sendCurrent() {
  ac.next.protocol = candidates[selected];
  ac.next.model    = -1;  // library default variant for that protocol
  ac.next.power    = curPower;
  ac.next.mode     = stdAc::opmode_t::kCool;
  ac.next.degrees  = curDegrees;
  ac.next.fanspeed = curFan;
  ac.next.swingv   = stdAc::swingv_t::kOff;
  ac.next.swingh   = stdAc::swingh_t::kOff;
  ac.sendAc();

  Serial.printf(">> [%d/%d] %s | power=%s cool=%dC fan=%d\n",
                selected + 1, numCandidates, typeToString(candidates[selected]).c_str(),
                curPower ? "on" : "off", curDegrees, static_cast<int>(curFan));
}

void printCandidates() {
  Serial.printf("%d AC protocols supported by this library build:\n", numCandidates);
  for (int i = 0; i < numCandidates; i++) {
    Serial.printf("  %3d: %s\n", i, typeToString(candidates[i]).c_str());
  }
}

void printMenu() {
  Serial.println();
  Serial.println("=== FROSTMIND universal AC pairing ===");
  Serial.println("l = list candidates | <digits>+Enter = jump to index | n = next candidate");
  Serial.println("r = resend current  | y = confirm+save this protocol | c = clear saved pairing");
  Serial.println("+/- = temp up/down  | f = cycle fan speed             | p = power toggle");
  Serial.println("(+, -, f, p all resend using the currently selected/paired protocol)");
}

void loadPairing() {
  prefs.begin(kPrefsNamespace, /*readOnly=*/true);
  int saved = prefs.getInt(kPrefsKey, -1);
  prefs.end();

  if (saved < 0) {
    Serial.println("No AC paired yet.");
    return;
  }
  for (int i = 0; i < numCandidates; i++) {
    if (static_cast<int>(candidates[i]) == saved) {
      selected = i;
      paired = true;
      Serial.print("Loaded previously paired protocol: ");
      Serial.println(typeToString(candidates[i]).c_str());
      return;
    }
  }
  Serial.println("Saved pairing found but its protocol isn't in this build's candidate list (library version changed?). Re-pair.");
}

void savePairing() {
  prefs.begin(kPrefsNamespace, /*readOnly=*/false);
  prefs.putInt(kPrefsKey, static_cast<int>(candidates[selected]));
  prefs.end();
  paired = true;
}

void clearPairing() {
  prefs.begin(kPrefsNamespace, /*readOnly=*/false);
  prefs.remove(kPrefsKey);
  prefs.end();
  paired = false;
  Serial.println("Pairing cleared.");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  // No ac.begin() -- the IRac(pin) constructor above already initializes the
  // underlying IRsend on kIrLedPin; IRac itself has no separate begin().

  buildCandidateList();
  Serial.printf("%d candidate AC protocols found in this library build.\n", numCandidates);
  loadPairing();
  printMenu();
}

String inputBuf = "";

void loop() {
  if (!Serial.available()) return;
  char c = Serial.read();

  if (c == '\n' || c == '\r') {
    if (inputBuf.length() > 0) {
      int idx = inputBuf.toInt();
      inputBuf = "";
      if (idx >= 0 && idx < numCandidates) {
        selected = idx;
        curPower = true;
        sendCurrent();
        Serial.println("Watch the real AC. 'y' if it reacted, 'n' for next, 'r' to resend.");
      } else {
        Serial.println("Index out of range.");
      }
    }
    return;
  }

  if (isDigit(c)) {
    inputBuf += c;
    return;
  }

  switch (c) {
    case 'l':
      printCandidates();
      break;
    case 'n':
      selected = (selected + 1) % numCandidates;
      curPower = true;
      sendCurrent();
      Serial.println("Watch the real AC. 'y' if it reacted, 'n' for next, 'r' to resend.");
      break;
    case 'r':
      sendCurrent();
      break;
    case 'y':
      savePairing();
      Serial.print("*** Paired and saved: ");
      Serial.println(typeToString(candidates[selected]).c_str());
      Serial.println("*** Loads automatically after reboot. Try +/-/f/p to sanity-check control.");
      break;
    case 'c':
      clearPairing();
      break;
    case '+':
      curDegrees++;
      sendCurrent();
      break;
    case '-':
      curDegrees--;
      sendCurrent();
      break;
    case 'f':
      fanIdx = (fanIdx + 1) % kNumFanSteps;
      curFan = kFanCycle[fanIdx];
      sendCurrent();
      break;
    case 'p':
      curPower = !curPower;
      sendCurrent();
      break;
    default:
      break;
  }
}

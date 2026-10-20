# FROSTMIND — Hardware BOM & Wiring

The doc `FROSTMIND_MVP_Implementation_and_AI_Plan (1).md` already cross-references as "hardware BOM + pin wiring" but didn't exist yet — this fills that gap. A visual version of this same content (with a wiring diagram) was also published as an artifact; this file is the versioned, authoritative copy that lives with the code.

---

## 1. Bill of materials

| Part | Spec | Qty | Note |
|---|---|---|---|
| Seeed XIAO ESP32-S3 | ESP32-S3R8 (8 MB PSRAM), USB-C | 1 | USB-C for both power and flashing. Not the XIAO ESP32-C3: same shape, different pin mapping |
| DHT11 or DHT22 breakout | single-wire, 3-pin (VCC/GND/DATA) | 1 | check the part markings — DHT11 and DHT22 use the same wiring, different `#define` in firmware |
| MC-38 reed switch | 2-wire, N.O. + magnet | 1 | door/lid sensor |
| IR LED | 940nm, 5mm | 1 | transmit only — this build has no receiver |
| Resistor | 100-220 ohm | 1 | IR LED current limit |
| WS2812 / WS281x RGB LED strip | 5 V, addressable, **GRB** colour order, 3 wires (5V / GND / DIN), 11 LEDs | 1 | status lights: pairing, shelf life, alerts (`STATUS_LED_COUNT` = 11) |
| Breadboard + jumper wires | - | - | for everything above |
| USB-C cable | data-capable | 1 | a charge-only cable will not flash the board |

**Optional, only if the direct-drive IR LED doesn't reach the AC:** an NPN transistor (2N2222/BC547) + ~1k ohm base resistor, for a driven (vs. direct-drive) IR circuit.

## 2. Pin map

Fixed by the firmware — these are the actual constants in `firmware/frostmind_main/frostmind_main.ino`. Wire to match exactly.

**Wire by the D-label printed next to each hole of the XIAO.** On the XIAO ESP32-S3, D*n* is **not** GPIO *n*: D3 = GPIO4, D4 = GPIO5, D5 = GPIO6, D6 = GPIO43, D8 = GPIO7. Putting a wire in "D6" because the firmware says GPIO6 is the classic mistake, and it's why the IR LED once never lit.

| XIAO pad | ESP32-S3 pin | Function | Goes to |
|---|---|---|---|
| 3V3 | - | power | DHT VCC |
| 5V | - | power from USB | LED strip 5V |
| GND | - | ground | DHT GND, reed switch, IR LED short leg, LED strip GND |
| **D8** | GPIO7 | single-wire digital | DHT DATA |
| **D4** | GPIO5 | digital in, `INPUT_PULLUP` | reed switch (other leg -> GND) |
| **D5** | GPIO6 | digital out | IR LED long leg (anode) |
| **D3** | GPIO4 | digital out (RMT) | LED strip DIN |
| D9, D10 | GPIO8, GPIO9 | free, unused | - |
| D0, D1, D2, D6, D7 | GPIO1, 2, 3, 43, 44 | free, leave empty | D6/D7 are the UART0 TX/RX pins |

**There is no IR receiver in this build** (GPIO5, once reserved for a TSOP38238, now carries the reed switch). This project is not using IRDB, LIRC, or any IR receiver — not deferred, ruled out. See `FROSTMIND_Phase2_Implementation_Plan.md` §3 and the MVP plan's §5 for what that means for AC pairing.

**Sensor note:** earlier drafts of this project assumed an I2C SHT31-D (4 pins). The actual sensor on hand has 3 pins (VCC/GND/DATA) — that's a DHT11 or DHT22/AM2302, single-wire, not I2C. Check the part markings and set `FROSTMIND_DHT_TYPE` near the top of `firmware/frostmind_main/frostmind_main.ino` to match (`DHT11` or `DHT22`) — everything else in the firmware is identical either way. If it's a bare sensor rather than a breakout module, add a 10k ohm pull-up resistor from DATA to VCC; most 3-pin breakout modules already have this built in.

## 3. Wiring, in words

- **DHT11/DHT22:** VCC->3V3, GND->GND, DATA->D8 (GPIO7). Only 3 wires — there's no SDA/SCL to mix up.
- **Reed switch:** one leg->D4 (GPIO5), other leg->GND. No external resistor — the firmware enables the internal pull-up (`INPUT_PULLUP`), and **HIGH means the door is open** (magnet away → switch open → pin pulled up). This was corrected after real-hardware testing; see `loop()` in the `.ino`.
- **IR LED:** D5 (GPIO6) -> resistor (100-220 ohm, optional for a short test) -> LED anode (longer leg) -> cathode -> GND. Aim broadly at the AC's front panel; a meter or two away is fine for direct-drive.
- **LED strip (WS2812, GRB):** strip 5V -> board 5V, strip GND -> GND, strip DIN -> D3 (GPIO4). Use the strip's **input** end: the arrows printed on the strip point away from it and the pad says `DIN`, not `DO`. Wired to the wrong end, nothing lights. A 300-500 ohm resistor in series on DIN is good practice but not required for a short jumper. Brightness is capped in firmware, so USB power is enough for the 11 LEDs. What each colour means: `firmware/frostmind_main/README.md` "Status light strip".
- **Everything else (D0, D1, D2, D6, D7, D9, D10):** leave empty. In particular, no wire from D1 (GPIO2) to 3V3.
- **Power:** USB-C from whichever machine you're flashing from.

(The published artifact has an actual wiring diagram if you want the visual instead of the text version above.)

## 4. Flash `frostmind_main`

This is the real deployable firmware — not the standalone `frostmind_brand_select_ir` pairing sketch (that one stays as a manual-pairing reference/fallback). Toolchain already verified working on this project: `arduino-cli`, ESP32 core 3.3.11, IRremoteESP8266 2.9.0.

```
arduino-cli board list
arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc "firmware/frostmind_main"
arduino-cli upload -p COM5 --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc "firmware/frostmind_main"
```

**The `:CDCOnBoot=cdc` part is required, confirmed on real hardware.** This board defaults to native USB
(`USB Mode: Hardware CDC and JTAG`), but `USB CDC On Boot` defaults to **Disabled** — without setting it
to `cdc`, the sketch's own `Serial` output goes to physical UART0 pins instead of the USB port you're
monitoring. Flashing still succeeds and the ROM bootloader banner (`ESP-ROM:esp32s3-...`) still prints
either way, but everything after that goes silent forever with the default option — looks exactly like a
dead board or a crash, but it's neither.

(Replace `COM5` with whatever `board list` shows.) In Arduino IDE: open `firmware/frostmind_main/frostmind_main.ino`, board = "ESP32S3 Dev Module", then in Tools set **USB CDC On Boot: "Enabled"**, pick the port, Sketch -> Upload. The sketch's folder name has to match its `.ino` filename exactly — don't rename or move the file out of `frostmind_main/`.

After upload, open the serial monitor at `115200` baud.

## 5. Confirm it's alive

Work through these before touching the AC — they isolate wiring problems from pairing problems.

1. Boot log prints a candidate-protocol count (~65) with Samsung ordered first.
2. Temp/humidity readings aren't `NaN` in the serial CSV stream (if they are: recheck the DATA wire and that `FROSTMIND_DHT_TYPE` matches the sensor).
3. CSV rows stream every ~2s: `ts,temp,humidity,door,rate_of_change,session_label`.
4. Open/close the reed switch by hand — the `door` column flips 0/1.
5. Scan for BLE device `FROSTMIND` with any generic scanner app (e.g. nRF Connect) — confirms the radio side works even before the phone app is tested against real hardware.
6. Send a test IR command (serial key `n`, or `x` for a 3 s test flash) and view the LED through a phone camera — IR is invisible to the eye but shows as a flicker on camera.
7. The LED strip plays a "frost bloom" at boot, then a blue beacon until a phone connects. Serial key `g` shows red, green, blue, white for 1 s each (if the first isn't red, the colour order isn't GRB); `d` runs through the whole light workflow with each meaning printed.

## 6. What's next

Once the above checks out: send serial key `a` to start automatic AC-pairing (Samsung's protocol tried first), and watch for the AC visibly reacting during a candidate test window. Pairing status is serial-only for now — the phone-bridge app exists (`phone-bridge/`) but hasn't been run against real BLE hardware yet.

**No fallback exists if the full protocol sweep doesn't find a match.** This build doesn't use IRDB, LIRC, or an IR receiver. A miss means this specific AC can't be controlled by this system as currently scoped.

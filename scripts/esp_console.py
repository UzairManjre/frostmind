"""
Live FROSTMIND serial console -- watch the ESP32 in a terminal and poke it from the keyboard.

    .venv\\Scripts\\python.exe scripts\\esp_console.py            (auto-detects the ESP32 port)
    .venv\\Scripts\\python.exe scripts\\esp_console.py --port COM5

Shows every sensor reading as a readable row (temperature, humidity, door, rate of change) and
every firmware message as it happens. Keys are sent straight to the firmware:

    x  IR LED test (3 s flashing -- watch the LED through a phone camera)
    g  light strip colour test (red, green, blue, white -- 1 s each; first must be red for GRB)
    d  light strip demo (every status pattern, 4 s each, its meaning printed here)
    p  power toggle   +/-  AC temp up/down   f  fan   a  auto-pair   l  list protocols
    q  quit the console (the ESP keeps running)

Windows-only keyboard handling (msvcrt), which is what this project runs on.
"""
from __future__ import annotations

import argparse
import msvcrt
import os
import sys
import threading
import time
from datetime import datetime

import serial
from serial.tools import list_ports

ESPRESSIF_VID = 0x303A

# ANSI colours (Windows 10+ terminals understand these once VT mode is on -- os.system("") does it)
RESET, DIM, BOLD = "\033[0m", "\033[2m", "\033[1m"
CYAN, GREEN, YELLOW, RED, MAGENTA = "\033[36m", "\033[32m", "\033[33m", "\033[31m", "\033[35m"

HELP = (
    f"{BOLD}keys:{RESET} {CYAN}x{RESET} IR LED test   {CYAN}g{RESET} strip colours   {CYAN}d{RESET} strip demo   "
    f"{CYAN}p{RESET} power   {CYAN}+/-{RESET} temp   {CYAN}f{RESET} fan   {CYAN}a{RESET} auto-pair   "
    f"{CYAN}l{RESET} list   {CYAN}q{RESET} quit"
)


def find_port() -> str | None:
    ports = list(list_ports.comports())
    for p in ports:
        if p.vid == ESPRESSIF_VID:
            return p.device
    for p in ports:
        if "USB" in (p.description or "") and p.device.upper() != "COM1":
            return p.device
    return None


def fmt_reading(line: str) -> str | None:
    """'3762,25.60,37.80,1,0.000,' -> a readable row, or None if it isn't a CSV reading."""
    parts = line.split(",")
    if len(parts) < 5 or not parts[0].isdigit():
        return None
    _, temp, hum, door, roc = parts[:5]
    temp_s = f"{RED}  no data{RESET}" if temp == "nan" else f"{float(temp):6.2f} °C"
    hum_s = f"{RED}no data{RESET}" if hum == "nan" else f"{float(hum):5.1f} %"
    door_s = f"{YELLOW}OPEN  {RESET}" if door.strip() == "1" else f"{GREEN}CLOSED{RESET}"
    return (
        f"{DIM}{datetime.now():%H:%M:%S}{RESET}  temp {BOLD}{temp_s}{RESET}   humidity {hum_s}   "
        f"door {door_s}   change {float(roc):+.3f} °C/min"
    )


def reader(ser: serial.Serial, stop: threading.Event):
    buf = b""
    while not stop.is_set():
        try:
            chunk = ser.read(512)
        except serial.SerialException as exc:
            print(f"\n{RED}Serial connection lost: {exc}{RESET}")
            stop.set()
            return
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("utf-8", errors="replace").rstrip("\r")
            if not line.strip():
                continue
            row = fmt_reading(line)
            if row:
                print(row)
            elif line.startswith("ts,"):
                continue  # CSV header
            elif ">>>" in line:
                print(f"{MAGENTA}{BOLD}{line}{RESET}")
            elif "ALERT" in line or "error" in line.lower():
                print(f"{RED}{line}{RESET}")
            else:
                print(f"{CYAN}[esp]{RESET} {line}")


def main():
    ap = argparse.ArgumentParser(description="Live FROSTMIND ESP32 console")
    ap.add_argument("--port", help="serial port, e.g. COM5 (default: auto-detect)")
    ap.add_argument("--baud", type=int, default=115200)
    args = ap.parse_args()

    os.system("")  # enable ANSI colours on Windows terminals
    port = args.port or find_port()
    if not port:
        sys.exit("No ESP32 found. Plug it in, or pass --port COMx.")

    try:
        ser = serial.Serial(port, args.baud, timeout=0.2)
    except serial.SerialException as exc:
        sys.exit(f"Couldn't open {port}: {exc}\n(Close any other serial monitor -- Arduino IDE, another console -- and retry.)")

    print(f"{BOLD}FROSTMIND console{RESET} on {port} @ {args.baud} baud. Readings arrive every ~2 s.")
    print(HELP)
    print()

    stop = threading.Event()
    t = threading.Thread(target=reader, args=(ser, stop), daemon=True)
    t.start()

    try:
        while not stop.is_set():
            if msvcrt.kbhit():
                ch = msvcrt.getwch()
                if ch in ("q", "Q", "\x1b"):
                    break
                if ch == "\r":
                    ch = "\n"
                if ch == "x":
                    print(f"{MAGENTA}{BOLD}>>> sending x: LED should flash for 3 s -- check with your phone camera{RESET}")
                elif ch == "g":
                    print(f"{MAGENTA}{BOLD}>>> sending g: strip should show RED, GREEN, BLUE, WHITE for 1 s each{RESET}")
                elif ch == "h":
                    print(HELP)
                    continue
                try:
                    ser.write(ch.encode("utf-8", errors="ignore"))
                except serial.SerialException:
                    break
            time.sleep(0.02)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        ser.close()
        print(f"\n{DIM}console closed -- the ESP32 keeps running.{RESET}")


if __name__ == "__main__":
    main()

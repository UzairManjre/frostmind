"""Exports logged `SensorReading` rows straight from FROSTMIND's SQLite DB into the CSV schema
scripts/train_model1_frostmind.py expects: ts, temp, humidity, door, rate_of_change,
session_label.

This is Prototype-to-Production plan §4's step 1 for wiring up Model 1: instead of hand-copying
serial output, real /ingest-recorded readings can now be exported directly. It does NOT invent
`session_label` -- whether a given stretch of readings is a clean "normal" baseline run or an
induced-anomaly clip (door held open, hairdryer near the sensor, power cut) is a human,
session-level judgment made by whoever physically ran that session, per
FROSTMIND_MVP_Implementation_and_AI_Plan.md §4. Pass --label to stamp this export's rows with one
label; omit it to leave session_label blank for a human to fill in afterwards (e.g. in a
spreadsheet) before combining exports from multiple sessions into one training CSV.

Typical workflow once real hardware sessions have actually been run (they have NOT been run as
of this pass -- see backend/README.md's "Model 1 status"):
    1. Run a normal baseline session end-to-end (phone-bridge live, backend recording) as its own
       shipment; note the shipment_id.
    2. python scripts/export_frostmind_log.py --shipment-id <that id> --label normal --append
    3. Run 5-10 induced-anomaly clips, each as its own shipment.
    4. python scripts/export_frostmind_log.py --shipment-id <id> --label door_open --append
       (repeat per clip, with a label describing what was induced)
    5. data/frostmind_logs/frostmind_log.csv now has every session combined; run
       scripts/train_model1_frostmind.py against it.

Usage:
    python scripts/export_frostmind_log.py [--db PATH] [--out PATH] [--shipment-id ID]
        [--label LABEL] [--append] [--start-ts ISO8601] [--end-ts ISO8601]

    --db          Path to the SQLite DB file (default: backend/frostmind.db under the project
                  root). Ignored if FROSTMIND_DATABASE_URL isn't a sqlite:/// URL pointing at a
                  file -- pass --db explicitly in that case.
    --out         Output CSV path (default: data/frostmind_logs/frostmind_log.csv).
    --shipment-id Only export readings from this shipment (a session is normally one shipment
                  end-to-end: register device -> start shipment -> run the session -> mark
                  delivered). Omit to export every reading in the DB.
    --label       Stamp every exported row's session_label with this value (e.g. "normal",
                  "door_open", "hairdryer", "power_loss"). Omit to leave session_label blank.
    --append      Append to an existing --out file (no duplicate header) instead of overwriting
                  it -- use this to combine multiple sessions/labels into one training CSV.
    --start-ts / --end-ts
                  Optional ISO8601 timestamp bounds, to isolate a specific time window within a
                  shipment's readings (e.g. a single induced-anomaly clip logged mid-shipment).
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "backend" / "frostmind.db"
DEFAULT_OUT = ROOT / "data" / "frostmind_logs" / "frostmind_log.csv"

CSV_COLUMNS = ["ts", "temp", "humidity", "door", "rate_of_change", "session_label"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"SQLite DB path (default: {DEFAULT_DB})")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"Output CSV path (default: {DEFAULT_OUT})")
    parser.add_argument("--shipment-id", default=None, help="Only export readings for this shipment_id")
    parser.add_argument(
        "--label",
        default=None,
        help="session_label to stamp every exported row with (e.g. normal, door_open). "
        "Omitted -> blank, for a human to fill in later.",
    )
    parser.add_argument("--append", action="store_true", help="Append to --out instead of overwriting it")
    parser.add_argument("--start-ts", default=None, help="ISO8601 lower bound (inclusive) on reading ts")
    parser.add_argument("--end-ts", default=None, help="ISO8601 upper bound (inclusive) on reading ts")
    return parser.parse_args()


def export(db_path: Path, out_path: Path, shipment_id: str | None, label: str | None, append: bool, start_ts: str | None, end_ts: str | None) -> int:
    if not db_path.exists():
        print(f"No DB found at {db_path}.", file=sys.stderr)
        print(
            "Run the backend at least once (it auto-creates frostmind.db on first startup) and "
            "log some /ingest readings before exporting.",
            file=sys.stderr,
        )
        return 1

    query = "SELECT ts, temp_c, humidity, door_open, rate_of_change FROM sensor_readings WHERE 1=1"
    params: list[str] = []
    if shipment_id:
        query += " AND shipment_id = ?"
        params.append(shipment_id)
    if start_ts:
        query += " AND ts >= ?"
        params.append(start_ts)
    if end_ts:
        query += " AND ts <= ?"
        params.append(end_ts)
    query += " ORDER BY ts"

    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()

    if not rows:
        print("No matching SensorReading rows found -- nothing exported.", file=sys.stderr)
        return 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not (append and out_path.exists() and out_path.stat().st_size > 0)
    mode = "a" if append else "w"
    with out_path.open(mode, newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(CSV_COLUMNS)
        for ts, temp, humidity, door_open, rate_of_change in rows:
            door = "" if door_open is None else int(bool(door_open))
            writer.writerow([ts, temp, humidity if humidity is not None else "", door, rate_of_change if rate_of_change is not None else "", label or ""])

    print(f"Exported {len(rows)} readings -> {out_path}")
    if not label:
        print(
            "No --label given -- session_label column is blank. Fill it in (e.g. in a "
            "spreadsheet) with 'normal' or a description of the induced anomaly before "
            "combining sessions and running scripts/train_model1_frostmind.py."
        )
    return 0


def main() -> None:
    args = parse_args()
    exit_code = export(
        db_path=args.db,
        out_path=args.out,
        shipment_id=args.shipment_id,
        label=args.label,
        append=args.append,
        start_ts=args.start_ts,
        end_ts=args.end_ts,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

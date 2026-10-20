"""
Download the public product-storage reference pages that Models 4 and 5 are built from, and
snapshot them as-is into data/product_catalog/raw/ -- the cleaning step
(build_product_catalog.py) only ever reads these saved snapshots, never the live web, so the
whole pipeline is reproducible even if a page changes or disappears later.

Sources (see data/product_catalog/README.md for what each contributes):
  S1 Engineering ToolBox -- fruit/vegetable storage table incl. ethylene production/sensitivity
  S2 UMaine Bulletin 4135 -- reproduces USDA Agriculture Handbook 66 storage table (cross-check)
  S3 FAO ae075e16 -- reproduces McGregor 1989 (USDA Agriculture Handbook 668) mixed-load
     compatibility groups (the expert labels for Model 5)
  S4 Virginia Tech Extension pub. 348-960 -- refrigerator/freezer storage times for dairy, eggs,
     meat, poultry, seafood and frozen foods (shelf-life input for the non-produce rows)

Each snapshot's URL, fetch time, HTTP status, byte size and SHA-256 are recorded in
raw/SOURCES.json. The non-produce temperature bands (FDA Food Code, CDC vaccine toolkit, USP)
are hand-entered with a per-row citation into raw/non_produce_manual.csv -- those agencies'
sites reject scripted downloads (HTTP 403), and each band is a single regulatory number anyway.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "product_catalog" / "raw"

SOURCES = {
    "S1_engineeringtoolbox_fruits_vegetables.html": "https://www.engineeringtoolbox.com/fruits-vegetables-storage-conditions-d_710.html",
    "S2_umaine_bulletin_4135.html": "https://extension.umaine.edu/publications/4135e/",
    "S3_fao_mcgregor_compatibility_groups.html": "https://www.fao.org/4/ae075e/ae075e16.htm",
    "S4_vt_extension_348-960_food_storage.html": "https://www.pubs.ext.vt.edu/348/348-960/348-960.html",
}

# Some sites reject urllib's default "Python-urllib/x.y" agent outright.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}


def fetch(url: str) -> tuple[int, bytes, str]:
    """Returns (http_status, body, method). Falls back to the system curl when Python's bundled
    CA store can't verify a site's chain (seen with extension.umaine.edu on Windows) -- curl uses
    the OS certificate store, so verification still happens; it is never disabled.
    """
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read(), "urllib"
    except urllib.error.URLError as exc:
        if "CERTIFICATE_VERIFY_FAILED" not in str(exc) or not shutil.which("curl"):
            raise
    out = subprocess.run(
        ["curl", "-sS", "-L", "-A", HEADERS["User-Agent"], "-w", "\\n%{http_code}", url],
        capture_output=True,
        check=True,
    ).stdout
    body, _, status = out.rpartition(b"\n")
    return int(status), body, "curl (OS certificate store)"


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    manifest_path = RAW / "SOURCES.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    failures = []
    for filename, url in SOURCES.items():
        try:
            status, body, method = fetch(url)
        except Exception as exc:
            print(f"FAILED {url}: {exc}")
            failures.append(filename)
            continue
        (RAW / filename).write_bytes(body)
        manifest[filename] = {
            "url": url,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "http_status": status,
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
            "method": f"scripts/fetch_product_data.py ({method})",
        }
        print(f"OK {status} {len(body):>8} bytes  {filename}")

    manifest_path.write_text(json.dumps(manifest, indent=2))
    if failures:
        print(f"\n{len(failures)} source(s) failed -- save those pages manually into {RAW} and note it in SOURCES.json")
        sys.exit(1)


if __name__ == "__main__":
    main()

"""
Build data/product_catalog/product_catalog_clean.csv from the raw snapshots saved by
fetch_product_data.py -- the single cleaned product table Models 4 and 5 are trained on and the
backend's Load Planner serves.

Every cleaning step logs how many rows it touched into cleaning_report.json, so the submission
can show exactly what was done to the raw data (and to which rows).

Sources (see data/product_catalog/README.md):
  S1 Engineering ToolBox produce table   -> primary produce features (incl. ethylene)
  S2 UMaine 4135 / USDA HB66 tables       -> cross-check + gap filling + chilling thresholds
  S3 FAO / McGregor 1989 (USDA AH-668)    -> compatibility groups = Model 5's expert LABELS
  S4 VT Extension 348-960                 -> refrigerated/frozen shelf life for non-produce rows
  raw/non_produce_manual.csv              -> cited regulatory temperature bands (FDA/CDC/USP)

Leakage rule: no feature column is ever filled from the McGregor groups (S3). S3 only ever
populates `compat_groups` / `compat_exceptions`, which are labels, never model inputs.
"""
from __future__ import annotations

import html
import json
import math
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

from common.products import SUPERCOOL_DELTA, q10_from_ea  # noqa: E402
from model3_shelf_life import PRODUCT_LIBRARY  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "product_catalog" / "raw"
OUT = ROOT / "data" / "product_catalog"

S1_URL = "https://www.engineeringtoolbox.com/fruits-vegetables-storage-conditions-d_710.html"
S2_URL = "https://extension.umaine.edu/publications/4135e/"
S4_URL = "https://www.pubs.ext.vt.edu/348/348-960/348-960.html"

report: dict = {"steps": []}


def log_step(name: str, detail: str, **counts):
    report["steps"].append({"step": name, "detail": detail, **counts})
    extra = ", ".join(f"{k}={v}" for k, v in counts.items() if not isinstance(v, (list, dict)))
    print(f"[{len(report['steps']):02d}] {name}: {detail} ({extra})")


# ---------------------------------------------------------------------------------------------
# parsing helpers
# ---------------------------------------------------------------------------------------------
class TableParser(HTMLParser):
    """Minimal stdlib <table> extractor (no lxml/bs4 dependency)."""

    def __init__(self):
        super().__init__()
        self.tables, self._cur, self._row, self._cell = [], None, None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._cur = []
            self.tables.append(self._cur)
        elif tag == "tr" and self._cur is not None:
            self._row = []
            self._cur.append(self._row)
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def read_tables(path: Path, encoding: str) -> list[list[list[str]]]:
    p = TableParser()
    p.feed(path.read_bytes().decode(encoding, errors="replace"))
    return p.tables


DASHES = re.compile(r"\s*[-–—]\s*")


def f_to_c(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


def parse_range(text: str) -> tuple[float, float] | None:
    """'30 - 40' / '30–40' / '32' / '55-70' -> (lo, hi) floats; None if unparseable/blank."""
    if text is None:
        return None
    t = str(text).replace("—", "").strip()
    if not t or t in ("-", "—"):
        return None
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", DASHES.sub(" ", t))]
    if not nums:
        return None
    return (min(nums[:2]), max(nums[:2])) if len(nums) >= 2 else (nums[0], nums[0])


UNIT_DAYS = {"day": 1, "days": 1, "week": 7, "weeks": 7, "month": 30.4, "months": 30.4, "year": 365, "years": 365}


def parse_storage_life_days(text: str) -> float | None:
    """'1-12 months' -> geometric midpoint in days (sqrt(30.4*365)); '2 weeks' -> 14.
    Geometric, not arithmetic, because these ranges span an order of magnitude ('1-12 months')
    and shelf life enters the loss model multiplicatively."""
    if not text:
        return None
    t = str(text).lower().replace("–", "-").replace(",", " ")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*(day|days|week|weeks|month|months|year|years)\b", t)
    if not m:
        return None
    lo = float(m.group(1))
    hi = float(m.group(2)) if m.group(2) else lo
    unit = UNIT_DAYS[m.group(3)]
    return math.sqrt(lo * hi) * unit


ETH_PROD = {"no": 0, "very low": 1, "low": 2, "medium": 3, "moderate": 3, "high": 4, "very high": 4}
ETH_SENS = {"no": 0, "yes": 1, "yes, very": 2}


def singular(tok: str) -> str:
    if tok.endswith("ies") and len(tok) > 4:
        return tok[:-3] + "y"
    if tok.endswith("oes") or tok.endswith("shes") or tok.endswith("ches"):
        return tok[:-2]
    if tok.endswith("s") and not tok.endswith("ss") and len(tok) > 3:
        return tok[:-1]
    return tok


def name_key(name: str) -> str:
    """Order-insensitive match key: 'Tomatoes mature, green' == 'Tomatoes, mature green'."""
    t = str(name).lower().replace("•", " ").replace("\x95", " ").replace(".", ",")
    toks = [singular(x) for x in re.findall(r"[a-z]+", t) if x not in ("and", "or", "the")]
    return " ".join(sorted(toks))


def slug(name: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", name.lower())).strip("_")


# ---------------------------------------------------------------------------------------------
# S1 -- Engineering ToolBox (primary produce table)
# ---------------------------------------------------------------------------------------------
S1_COLS = ["name", "temp_f", "chill_f", "freeze_f", "rh", "top_ice", "sprinkle", "eth_prod", "eth_sens", "life", "comment"]

# Typos / alternate spellings seen in the raw S1 rows -> the canonical row they duplicate.
S1_SYNONYMS = {
    "Beans. Lima": "Beans, Lima",
    "Green Beans": "Beans, green or snap",
    "Green Peas": "Peas, green",
    "Onions": "Onions, dry",
    "Escarole": "Escarole",
}

FRUITS = {
    "apples", "apricots", "avocados_ripe", "avocados_unripe", "bananas_green", "bananas_ripe", "blackberries",
    "blueberries", "cantaloupe", "cherries", "cherries_sour", "cherries_sweet", "coconuts", "cranberries",
    "currants", "elderberries", "figs", "gooseberries", "grapefruit", "grapes", "guavas", "kiwi_ripe",
    "kiwi_unripe", "lemons", "limes", "lychees", "mangos", "melons_casaba_persian", "melons_crenshaw",
    "melons_honey_dew", "nectarines", "oranges", "papayas", "peaches", "pears", "persimmons", "pineapples",
    "plums", "pomegranates", "precut_fruit", "prunes", "quinces", "raspberries", "strawberries", "tangerines",
    "watermelon", "tomatoes_mature_green", "tomatoes_ripe",
}
# Tomatoes are botanically fruit but shipped/handled as vegetables -- keep culinary convention.
FRUITS -= {"tomatoes_mature_green", "tomatoes_ripe"}


def load_s1() -> pd.DataFrame:
    tables = read_tables(RAW / "S1_engineeringtoolbox_fruits_vegetables.html", "utf-8")
    rows = [r for r in tables[0] if len(r) == len(S1_COLS)][1:]  # drop header; the stray '%' row has 1 cell
    df = pd.DataFrame(rows, columns=S1_COLS)
    log_step("S1 extract", "Engineering ToolBox table rows with the full 11 columns", rows_in=len(tables[0]), rows_out=len(df))

    n_syn = int(df["name"].isin([k for k, v in S1_SYNONYMS.items() if k != v]).sum())
    df["name"] = df["name"].replace(S1_SYNONYMS)
    log_step("S1 synonyms", "fixed typos / alternate names (e.g. 'Beans. Lima', 'Green Peas' -> 'Peas, green')", rows_changed=n_syn)

    # typo in a Yes/No column ('Ne' for 'No', Kiwi unripe)
    n_typo = int((df["top_ice"] == "Ne").sum())
    df["top_ice"] = df["top_ice"].replace({"Ne": "No"})
    log_step("S1 typo", "'Ne' -> 'No' in Top-Ice column", rows_changed=n_typo)
    return df


def s1_to_numeric(df: pd.DataFrame) -> pd.DataFrame:
    out = []
    for _, r in df.iterrows():
        t = parse_range(r["temp_f"])
        rh = parse_range(r["rh"])
        chill = parse_range(r["chill_f"])
        frz = parse_range(r["freeze_f"])
        ep = r["eth_prod"].strip().lower()
        es = r["eth_sens"].strip().lower()
        out.append(
            {
                "name": r["name"],
                "t_min_c": f_to_c(t[0]) if t else np.nan,
                "t_max_c": f_to_c(t[1]) if t else np.nan,
                "rh_min": rh[0] if rh else np.nan,
                "rh_max": rh[1] if rh else np.nan,
                "chill_point_c": f_to_c(chill[0]) if chill else np.nan,
                "freeze_point_c": f_to_c(frz[0]) if frz else np.nan,
                "ethylene_production": ETH_PROD.get(ep, np.nan) if ep else np.nan,
                "ethylene_sensitivity": ETH_SENS.get(es, np.nan) if es else np.nan,
                "shelf_life_days": parse_storage_life_days(r["life"]) or np.nan,
                "comment": r["comment"],
            }
        )
    num = pd.DataFrame(out)
    log_step(
        "S1 parse + F->C",
        "parsed F ranges ('30 - 40'), RH ranges, ethylene words -> ordinals, storage life text -> days (geometric mid)",
        rows=len(num),
        missing_freeze_point=int(num["freeze_point_c"].isna().sum()),
        missing_ethylene=int(num["ethylene_production"].isna().sum()),
        missing_shelf_life=int(num["shelf_life_days"].isna().sum()),
    )
    return num


def dedupe(num: pd.DataFrame, s2_temps: dict[str, tuple[float, float]]) -> pd.DataFrame:
    """S1 lists some products twice (e.g. Cauliflower: one row with freezing point + storage life,
    another with ethylene data). Keep the more complete row as the base and fill its gaps from
    the other; if both rows disagree on a filled value, keep the base's and log the conflict.
    When USDA HB66 (S2) lists the product, the duplicate whose temperature range matches HB66
    wins first -- an independent source is a better tie-break than cell count."""
    conflicts, merged_rows = [], []
    for name, grp in num.groupby("name", sort=False):
        if len(grp) == 1:
            merged_rows.append(grp.iloc[0])
            continue
        ref = s2_temps.get(name_key(name))

        def rank(idx):
            row = grp.loc[idx]
            agrees = ref is not None and abs(row["t_min_c"] - ref[0]) < 0.05 and abs(row["t_max_c"] - ref[1]) < 0.05
            return (agrees, int(row.notna().sum()))

        order = sorted(grp.index, key=rank, reverse=True)
        base = grp.loc[order[0]].copy()
        for other_idx in order[1:]:
            other = grp.loc[other_idx]
            for c in num.columns:
                if c == "name":
                    continue
                if pd.isna(base[c]) or base[c] == "":
                    base[c] = other[c]
                elif not (pd.isna(other[c]) or other[c] == "") and base[c] != other[c]:
                    conflicts.append({"product": name, "field": c, "kept": base[c], "dropped": other[c]})
        merged_rows.append(base)
    out = pd.DataFrame(merged_rows).reset_index(drop=True)
    log_step(
        "S1 dedupe",
        "merged duplicate product rows (row agreeing with USDA HB66 wins, else most-complete; gaps filled from the other)",
        rows_in=len(num),
        rows_out=len(out),
        conflicts=len(conflicts),
    )
    report["dedupe_conflicts"] = conflicts
    return out


# ---------------------------------------------------------------------------------------------
# S2 -- UMaine / USDA HB66
# ---------------------------------------------------------------------------------------------
S2_TO_S1 = {  # S2 names that don't token-match an S1 name
    "endive and escarole": ["Endive", "Escarole"],
    "grapes, american": ["Grapes"],
    "plums and prunes": ["Plums", "Prunes"],
    "tomatoes firm, ripe": ["Tomatoes, ripe"],
    "onion, dry": ["Onions, dry"],
    "peppers, chili (dry)": ["Peppers, hot chili"],
    "cantaloupe (full slip)": ["Cantaloupe"],
    "casaba": ["Melons, Casaba/Persian"],
    "crenshaw": ["Melons, Crenshaw"],
    "honey dew": ["Melons, Honey Dew"],
    "watermelon": ["Watermelon"],
    "potatoes, late crop": ["Potatoes"],
}
S2_ADD = {"onions, green": "Onions, green"}  # S2-only commodities worth adding as products


def clean_s2_name(raw: str) -> str:
    """HB66 indents sub-items ('Melons' -> '▪ Cantaloupe') with a bullet glyph; strip any
    leading non-letter characters."""
    return re.sub(r"^[^A-Za-z]+", "", raw).strip()


def load_s2():
    tables = read_tables(RAW / "S2_umaine_bulletin_4135.html", "cp1252")
    storage = []
    for r in tables[0][1:]:
        if len(r) != 5:
            continue  # section headers ('Fruits', 'Berries', 'Melons', ...)
        name = clean_s2_name(r[0])
        t, rh, frz = parse_range(r[1]), parse_range(r[2]), parse_range(r[4])
        storage.append(
            {
                "s2_name": name,
                "t_min_c": f_to_c(t[0]) if t else np.nan,
                "t_max_c": f_to_c(t[1]) if t else np.nan,
                "rh_min": rh[0] if rh else np.nan,
                "rh_max": rh[1] if rh else np.nan,
                "shelf_life_days": parse_storage_life_days(r[3]) or np.nan,
                "freeze_point_c": f_to_c(frz[0]) if frz else np.nan,
            }
        )
    storage = pd.DataFrame(storage)
    chill = []
    for r in tables[3][1:]:
        if len(r) != 3:
            continue
        rng = parse_range(r[1])
        if rng:
            chill.append({"s2_name": clean_s2_name(r[0]), "lowest_safe_c": f_to_c((rng[0] + rng[1]) / 2)})
    chill = pd.DataFrame(chill)
    log_step("S2 extract", "UMaine/HB66 storage table + 'lowest safe temperature' (chilling) table", storage_rows=len(storage), chill_rows=len(chill))
    return storage, chill


# HB66 chilling table names -> catalog names. 'Apples-certain cultivars' deliberately not mapped:
# it applies to specific cultivars only, while the catalog row is generic apples (stored 0 C).
CHILL_TO_S1 = {
    "Asparagus": ["Asparagus"],
    "Beans (lima)": ["Beans, Lima"],
    "Beans (snap)": ["Beans, green or snap"],
    "Cucumbers": ["Cucumbers"],
    "Eggplants": ["Eggplant"],
    "Cantaloupe": ["Cantaloupe"],
    "Honey Dew": ["Melons, Honey Dew"],
    "Casaba": ["Melons, Casaba/Persian"],
    "Crenshaw and Persian": ["Melons, Crenshaw"],
    "Watermelons": ["Watermelon"],
    "Okra": ["Okra"],
    "Peppers, sweet": ["Peppers, sweet"],
    "Potatoes": ["Potatoes"],
    "Pumpkins and hardshell squashes": ["Pumpkins", "Squashes, winter"],
    "Sweet Potatoes": ["Sweet Potatoes"],
    "Ripe": ["Tomatoes, ripe"],
    "Mature-green": ["Tomatoes, mature green"],
}


# ---------------------------------------------------------------------------------------------
# S3 -- McGregor compatibility groups (LABELS ONLY)
# ---------------------------------------------------------------------------------------------
def parse_s3() -> tuple[dict[int, list[str]], dict]:
    text = (RAW / "S3_fao_mcgregor_compatibility_groups.html").read_bytes().decode("cp1252", errors="replace")
    text = re.sub(r"(?is)<(script|style).*?</\1>", "", text)
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"</(p|tr|h\d|li|td|th)>", "\n", text)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    lines = [" ".join(line.split()) for line in text.splitlines() if line.strip()]
    groups, header = {}, {}
    cur = None
    for line in lines:
        m = re.match(r"Group (\d+):\s*(.*)", line)
        if m:
            cur = int(m.group(1))
            groups[cur] = []
            header[cur] = m.group(2)
            continue
        if line.startswith("Susceptibly to freezing"):
            break
        if cur is None or line.startswith("*") or line.startswith("Source:"):
            continue
        groups[cur].append(line)
    return groups, header


# McGregor member names -> catalog products. Written by hand (and printed in full in the
# report) because the vocabularies differ ('berries (except cranberries)', 'leafy greens').
MCGREGOR_TO_CATALOG = {
    "apples": ["apples"],
    "grapes (without sulfur dioxide)": ["grapes"],
    "parsnips": ["parsnips"], "parsnips*": ["parsnips"],
    "apricots": ["apricots"],
    "horseradish": ["horseradish"],
    "peaches": ["peaches"],
    "kohlrabi": ["kohlrabi"], "kohlrabi*": ["kohlrabi"],
    "pears": ["pears"],
    "leeks": ["leeks"], "leeks' (not with figs or grapes)": ["leeks"],
    "persimmons": ["persimmons"],
    "beets, topped": ["beets_topped"], "beets*": ["beets_bunched", "beets_topped"],
    "plums": ["plums"], "prunes": ["prunes"],
    "berries (except cranberries)": ["blackberries", "blueberries", "currants", "elderberries", "gooseberries", "raspberries", "strawberries"],
    "lychee": ["lychees"], "lychees": ["lychees"],
    "pomegranates": ["pomegranates"], "pomegranate": ["pomegranates"],
    "cherries": ["cherries_sour", "cherries_sweet"],
    "mushrooms": ["mushrooms"],
    "quinces": ["quinces"],
    "coconuts": ["coconuts"],
    "nectarines": ["nectarines"],
    "radishes": ["radishes_spring", "radishes_winter"], "radishes*": ["radishes_spring", "radishes_winter"],
    "figs (not with apples)": ["figs"],
    "oranges* ( Florida and Texas )": ["oranges"], "oranges ( Calif. and Arizona )": ["oranges"],
    "rutabagas": ["rutabagas"], "rutabagas*": ["rutabagas"],
    "turnips": ["turnips"], "turnips*": ["turnips"],
    "parsley*": ["parsley"],
    "artichokes*": ["artichokes"],
    "endive*": ["endive"], "escarole*": ["escarole"],
    "peas*": ["peas_green"], "snow peas": ["chinese_pea_pods"],
    "asparagus": ["asparagus"],
    "bean sprouts": ["beans_sprouts"],
    "Belgian endive": ["chicory_witloof"], "raddichio": ["chicory"],
    "Jerusalem artichoke": ["artichokes_jerusalem"],
    "rhubarb": ["rhubarb"],
    "kiwifruit": ["kiwi_ripe", "kiwi_unripe"],
    "salsify": ["salsify"],
    "bok choy": ["bok_choy"],
    "broccoli*": ["broccoli"],
    "leafy greens": ["greens_leafy", "bunched_greens", "collards", "kale", "chard", "turnip_greens"],
    "brussels sprouts*": ["brussels_sprouts"],
    "cabbage*": ["cabbage_early", "cabbage_late"],
    "lettuce": ["lettuce"],
    "spinach*": ["spinach"],
    "carrots*": ["carrots_bunched", "carrots_immature", "carrots_mature"],
    "Sweet corn*": ["corn_sweet"],
    "cauliflower": ["cauliflower"],
    "celeriac*": ["celeriac"],
    "celery*": ["celery"],
    "onions, green* (not with figs, grapes, mushrooms, rhubarb, or corn)": ["onions_green"],
    "watercress*": ["watercress"],
    "garlic": ["garlic"],
    "onions, dry": ["onions_dry"],
    "lemons*": ["lemons"],
    "tangerines*": ["tangerines"],
    "cantaloupes**": ["cantaloupe"],
    "cranberries": ["cranberries"],
    "beans": ["beans_green_or_snap", "beans_lima"], "haricot vert (fine beans)": ["beans_green_or_snap"],
    "cucumber": ["cucumbers"],
    "eggplant": ["eggplant"],
    "okra": ["okra"],
    "peppers": ["peppers_sweet"],
    "potatoes, storage": ["potatoes"], "potatoes, new": ["potatoes"],
    "squash, summer (soft shell)": ["squashes_summer"],
    "avocados": ["avocados_ripe", "avocados_unripe"],
    "bananas": ["bananas_green", "bananas_ripe"],
    "grapefruit": ["grapefruit"],
    "guava": ["guavas"],
    "limes*": ["limes"],
    "mangoes": ["mangos"],
    "papayas": ["papayas"],
    "pineapple": ["pineapples"],
    "melons (except cantaloupes)": ["melons_casaba_persian", "melons_crenshaw", "melons_honey_dew"],
    "tomatoes, ripe": ["tomatoes_ripe"],
    "ginger root": ["ginger_root"],
    "pumpkin": ["pumpkins"],
    "squash, winter (hard shell)": ["squashes_winter"],
    "jicama": ["jicama"],
    "sweetpotatoes*": ["sweet_potatoes"],
    "watermelon*": ["watermelon"],
    "tomatoes, mature green": ["tomatoes_mature_green"],
    # 'Pears (for ripening)' (G7) is intentionally unmapped: FROSTMIND plans transport, not
    # ripening rooms, and mapping it would put pears in both the coldest and warmest groups.
}

# McGregor's explicit "not with ..." notes and the G7 footnote ("separate from pears and
# tomatoes due to ethylene sensitivity") -> negative labels even within a shared group.
MCGREGOR_EXCEPTIONS = [
    ("figs", "apples"),
    ("leeks", "figs"), ("leeks", "grapes"),
    ("onions_green", "figs"), ("onions_green", "grapes"), ("onions_green", "mushrooms"),
    ("onions_green", "rhubarb"), ("onions_green", "corn_sweet"),
    ("sweet_potatoes", "tomatoes_mature_green"), ("watermelon", "tomatoes_mature_green"),
    ("sweet_potatoes", "pears"), ("watermelon", "pears"),
]


# ---------------------------------------------------------------------------------------------
# S4 -- VT Extension shelf life (non-produce)
# ---------------------------------------------------------------------------------------------
def load_vt_lookup() -> dict[tuple[str, str], str]:
    tables = read_tables(RAW / "S4_vt_extension_348-960_food_storage.html", "utf-8")
    lookup = {}
    for tb in tables:
        for r in tb:
            if len(r) == 4 and r[0] and r[0] != "Food":
                name = r[0].replace("‌", "").strip()
                for col, val in (("Refrigerator", r[2]), ("Freezer", r[3])):
                    val = val.replace("‌", "").strip()
                    # first listing wins -- the page repeats tables; later copies add ', opened'
                    if val and (name, col) not in lookup:
                        lookup[(name, col)] = val
    return lookup


def catalog_figure(cat: pd.DataFrame):
    """EDA figure for the submission: every product's recommended storage range, by category."""
    from common import plotstyle

    plotstyle.apply()
    import matplotlib.pyplot as plt

    order = ["fruit", "vegetable", "dairy", "eggs", "meat", "poultry", "seafood", "frozen", "pharma"]
    fig, ax = plt.subplots(figsize=(10, 4.8))
    rng = np.random.default_rng(0)
    for k, c in enumerate(order):
        sub = cat[cat["category"] == c]
        y = k + rng.uniform(-0.3, 0.3, len(sub))
        ax.hlines(y, sub["t_min_c"], sub["t_max_c"], color=plotstyle.SERIES[0], lw=1.2, alpha=0.7)
        ax.scatter(sub["t_opt_c"], y, s=10, color=plotstyle.SERIES[0], zorder=3)
        ax.text(31, k, f"n={len(sub)}", va="center", fontsize=8.5, color=plotstyle.TEXT_SECONDARY)
    ax.set_yticks(range(len(order)), order)
    ax.invert_yaxis()
    ax.set_xlim(-95, 36)
    ax.set_xlabel("Recommended storage temperature, C (line = range, dot = midpoint used as T_opt)")
    ax.set_title(f"Cleaned product catalog: {len(cat)} products, storage ranges by category")
    ax.grid(axis="y", visible=False)
    plotstyle.save(fig, "catalog_temperature_ranges.png")


def main():
    s2, s2_chill = load_s2()
    s2_temps = {}
    for _, r in s2.iterrows():
        for t in S2_TO_S1.get(r["s2_name"].lower(), [r["s2_name"]]):
            s2_temps[name_key(t)] = (r["t_min_c"], r["t_max_c"])
    s1 = s1_to_numeric(load_s1())
    s1 = dedupe(s1, s2_temps)

    # --- family / sibling structure used for imputation (e.g. 'Carrots, mature' <- 'Carrots, bunched')
    s1["head"] = s1["name"].str.split(",").str[0].str.strip().str.lower().map(singular)

    # --- cross-check against S2 (HB66) and fill S1 gaps from it
    s1_by_key = {name_key(n): n for n in s1["name"]}
    matches, s2_only = [], []
    for _, r in s2.iterrows():
        targets = S2_TO_S1.get(r["s2_name"].lower())
        if targets is None:
            hit = s1_by_key.get(name_key(r["s2_name"]))
            targets = [hit] if hit else []
        if not targets:
            s2_only.append(r["s2_name"])
        for t in targets:
            matches.append((t, r))

    agree = []
    imputed: dict[str, list[str]] = {n: [] for n in s1["name"]}
    for target, r in matches:
        i = s1.index[s1["name"] == target][0]
        agree.append(
            {
                "product": target,
                "tmid_s1": (s1.at[i, "t_min_c"] + s1.at[i, "t_max_c"]) / 2,
                "tmid_s2": (r["t_min_c"] + r["t_max_c"]) / 2,
                "freeze_s1": s1.at[i, "freeze_point_c"],
                "freeze_s2": r["freeze_point_c"],
            }
        )
        for c in ("freeze_point_c", "shelf_life_days", "rh_min", "rh_max"):
            if pd.isna(s1.at[i, c]) and not pd.isna(r[c]):
                s1.at[i, c] = r[c]
                imputed[target].append(f"{c}<-S2")
    agree = pd.DataFrame(agree)
    both_t = agree.dropna(subset=["tmid_s1", "tmid_s2"])
    both_f = agree.dropna(subset=["freeze_s1", "freeze_s2"])
    report["s1_vs_s2_agreement"] = {
        "matched_products": int(agree["product"].nunique()),
        "temp_mid_mae_c": round(float((both_t["tmid_s1"] - both_t["tmid_s2"]).abs().mean()), 3),
        "temp_mid_exact_match_pct": round(float(100 * ((both_t["tmid_s1"] - both_t["tmid_s2"]).abs() < 0.05).mean()), 1),
        "freeze_mae_c": round(float((both_f["freeze_s1"] - both_f["freeze_s2"]).abs().mean()), 3),
        "largest_temp_disagreements": both_t.assign(diff=(both_t["tmid_s1"] - both_t["tmid_s2"]).abs())
        .sort_values("diff", ascending=False)
        .head(6)[["product", "tmid_s1", "tmid_s2", "diff"]]
        .round(2)
        .to_dict("records"),
    }
    n_filled = sum(len(v) for v in imputed.values())
    log_step("S1 x S2 merge", "cross-checked against USDA HB66 (UMaine) and filled S1 gaps from it", matched=int(agree["product"].nunique()), values_filled=n_filled)

    # --- S2-only commodities worth adding
    for s2_name, cat_name in S2_ADD.items():
        r = s2[s2["s2_name"].str.lower() == s2_name].iloc[0]
        s1.loc[len(s1)] = {
            "name": cat_name, "t_min_c": r["t_min_c"], "t_max_c": r["t_max_c"], "rh_min": r["rh_min"], "rh_max": r["rh_max"],
            "chill_point_c": np.nan, "freeze_point_c": r["freeze_point_c"], "ethylene_production": np.nan,
            "ethylene_sensitivity": np.nan, "shelf_life_days": r["shelf_life_days"], "comment": "", "head": singular(cat_name.split(",")[0].lower()),
        }
        imputed[cat_name] = ["row<-S2"]
    report["s2_only_not_added"] = [n for n in s2_only if n.lower() not in S2_ADD]
    log_step("S2-only rows", "added S2-only commodities not present in S1", added=len(S2_ADD), skipped=len(report["s2_only_not_added"]))

    # --- chilling thresholds (HB66 lowest-safe-temperature table, else S1 chill point)
    s1["chill_threshold_c"] = s1["chill_point_c"]
    n_hb66 = 0
    for _, r in s2_chill.iterrows():
        for target in CHILL_TO_S1.get(r["s2_name"], []):
            s1.loc[s1["name"] == target, "chill_threshold_c"] = r["lowest_safe_c"]
            n_hb66 += 1
    # Chilling-sensitive = a real chilling limit well above freezing, or a tropical storage range.
    s1["chilling_sensitive"] = (s1["chill_threshold_c"] >= 2.0) | (s1["t_min_c"] >= 7.0)
    log_step(
        "chilling sensitivity",
        "threshold from HB66 lowest-safe-temperature table (preferred) or S1 chill point; sensitive if threshold >= 2 C or t_min >= 7 C",
        from_hb66=n_hb66,
        chilling_sensitive=int(s1["chilling_sensitive"].sum()),
    )

    # --- sibling imputation for ethylene / freezing point / shelf life / RH
    for c in ("ethylene_production", "ethylene_sensitivity", "freeze_point_c", "shelf_life_days", "rh_min", "rh_max"):
        filled = 0
        for i in s1.index[s1[c].isna()]:
            sib = s1[(s1["head"] == s1.at[i, "head"]) & s1[c].notna() & (s1.index != i)]
            if len(sib):
                val = sib[c].mode().iloc[0] if c.startswith("ethylene") else float(np.median(sib[c]))
                s1.at[i, c] = val
                imputed[s1.at[i, "name"]].append(f"{c}<-sibling({', '.join(sib['name'])})")
                filled += 1
        log_step(f"sibling impute {c}", "filled from same-commodity rows (e.g. 'Carrots, mature' <- 'Carrots, bunched')", filled=filled)

    # --- category assignment, then category-level fallback imputation (flagged)
    s1["product_id"] = s1["name"].map(slug)
    s1["category"] = np.where(s1["product_id"].isin(FRUITS), "fruit", "vegetable")
    for c in ("ethylene_production", "ethylene_sensitivity", "freeze_point_c", "shelf_life_days", "rh_min", "rh_max"):
        filled = 0
        for i in s1.index[s1[c].isna()]:
            pool = s1[(s1["category"] == s1.at[i, "category"]) & s1[c].notna()][c]
            val = pool.mode().iloc[0] if c.startswith("ethylene") else float(pool.median())
            s1.at[i, c] = val
            imputed[s1.at[i, "name"]].append(f"{c}<-category_{'mode' if c.startswith('ethylene') else 'median'}")
            filled += 1
        log_step(f"category impute {c}", "remaining gaps filled with the fruit/vegetable median (mode for ethylene classes); flagged in imputed_fields", filled=filled)

    produce = s1.assign(
        t_opt_c=(s1["t_min_c"] + s1["t_max_c"]) / 2,
        safety_class="produce",
        frostmind_category="fresh_produce_generic",
        hard_lo_c=np.nan,
        hard_hi_c=np.nan,
        q10=q10_from_ea(PRODUCT_LIBRARY["fresh_produce_generic"].activation_energy_j_per_mol, PRODUCT_LIBRARY["fresh_produce_generic"].reference_temp_c),
        source="S1 Engineering ToolBox (+S2 USDA HB66 via UMaine 4135)",
        source_url=S1_URL,
        notes=s1["comment"].fillna(""),
    )
    produce["imputed_fields"] = produce["name"].map(lambda n: "; ".join(imputed.get(n, [])))

    # --- McGregor labels (S3) -- label columns only
    groups, headers = parse_s3()
    ids = set(produce["product_id"])
    membership: dict[str, set[int]] = {pid: set() for pid in ids}
    unmatched = []
    for g, members in groups.items():
        for m in members:
            targets = MCGREGOR_TO_CATALOG.get(m)
            if targets is None:
                unmatched.append({"group": g, "member": m})
                continue
            for t in targets:
                if t not in ids:
                    raise SystemExit(f"McGregor map points at unknown product_id {t!r}")
                membership[t].add(g)
    produce["compat_groups"] = produce["product_id"].map(lambda p: ";".join(str(g) for g in sorted(membership[p])))
    report["mcgregor"] = {
        "groups": {str(g): headers[g] for g in groups},
        "members_listed": int(sum(len(v) for v in groups.values())),
        "members_without_catalog_match": unmatched,
        "catalog_products_labelled": int((produce["compat_groups"] != "").sum()),
        "catalog_products_multi_group": int(produce["compat_groups"].str.contains(";").sum()),
        "exceptions": MCGREGOR_EXCEPTIONS,
    }
    log_step(
        "McGregor labels",
        "attached compatibility group sets (labels only, never features)",
        labelled=report["mcgregor"]["catalog_products_labelled"],
        multi_group=report["mcgregor"]["catalog_products_multi_group"],
        mcgregor_members_unmatched=len(unmatched),
    )

    # --- non-produce rows: cited temperature bands + VT shelf life
    manual = pd.read_csv(RAW / "non_produce_manual.csv")
    vt = load_vt_lookup()
    rows = []
    for _, r in manual.iterrows():
        sl, sl_note = np.nan, ""
        if isinstance(r["vt_row"], str):
            key = next((k for k in vt if k[1] == r["vt_column"] and k[0].lower().startswith(r["vt_row"].lower())), None)
            if key:
                sl = parse_storage_life_days(vt[key]) or np.nan
                sl_note = f"shelf_life<-VT '{key[0]}' {key[1]}: '{vt[key]}'"
        if np.isnan(sl) and not pd.isna(r["fallback_shelf_life_days"]):
            sl = float(r["fallback_shelf_life_days"])
            sl_note = f"shelf_life<-{r['fallback_basis']}"
        lib = PRODUCT_LIBRARY[r["frostmind_category"]]
        fp = r["freeze_point_c"]
        rows.append(
            {
                "name": r["name"],
                "product_id": slug(r["name"]),
                "category": r["category"],
                "frostmind_category": r["frostmind_category"],
                "safety_class": r["safety_class"],
                "t_min_c": r["t_min_c"],
                "t_max_c": r["t_max_c"],
                "t_opt_c": (r["t_min_c"] + r["t_max_c"]) / 2,
                "rh_min": np.nan,
                "rh_max": np.nan,
                "freeze_point_c": fp,
                "chill_threshold_c": np.nan,
                "chilling_sensitive": False,
                "shelf_life_days": sl,
                "q10": q10_from_ea(lib.activation_energy_j_per_mol, lib.reference_temp_c),
                "ethylene_production": 0,
                "ethylene_sensitivity": 0,
                "hard_lo_c": r["hard_lo_c"],
                "hard_hi_c": r["hard_hi_c"],
                "compat_groups": "",
                "source": r["temp_basis"],
                "source_url": r["temp_source_url"],
                "notes": "",
                "imputed_fields": "; ".join(
                    x
                    for x in (sl_note, f"freeze_point_c<-{r['freeze_basis']}" if not pd.isna(fp) else "", "t_min_c<-assumption" if "assumption" in r["temp_basis"] else "")
                    if x
                ),
            }
        )
    nonprod = pd.DataFrame(rows)
    log_step(
        "non-produce rows",
        "cited FDA/CDC/USP temperature bands + VT 348-960 shelf life (text -> days)",
        rows=len(nonprod),
        shelf_life_from_vt=int(nonprod["imputed_fields"].str.contains("VT").sum()),
    )

    cols = [
        "product_id", "name", "category", "frostmind_category", "safety_class", "t_min_c", "t_max_c", "t_opt_c",
        "rh_min", "rh_max", "freeze_point_c", "chilling_sensitive", "chill_threshold_c", "shelf_life_days", "q10",
        "ethylene_production", "ethylene_sensitivity", "hard_lo_c", "hard_hi_c", "compat_groups", "source",
        "source_url", "notes", "imputed_fields",
    ]
    cat = pd.concat([produce[cols], nonprod[cols]], ignore_index=True)

    # --- validation
    problems = []
    for _, r in cat.iterrows():
        if not (r["t_min_c"] <= r["t_opt_c"] <= r["t_max_c"]):
            problems.append((r["product_id"], "t_min <= t_opt <= t_max violated"))
        if not pd.isna(r["freeze_point_c"]) and r["freeze_point_c"] - SUPERCOOL_DELTA > r["t_max_c"]:
            problems.append((r["product_id"], "freezing point above storage range"))
        if not pd.isna(r["rh_min"]) and not (0 <= r["rh_min"] <= r["rh_max"] <= 100):
            problems.append((r["product_id"], "RH out of range"))
        if r["safety_class"] != "pharma" and not (0 < r["shelf_life_days"] < 1000):
            problems.append((r["product_id"], "shelf life missing/implausible"))
    if cat["product_id"].duplicated().any():
        problems += [(p, "duplicate product_id") for p in cat.loc[cat["product_id"].duplicated(), "product_id"]]
    report["validation_problems"] = problems
    log_step("validation", "range/ordering/uniqueness checks on the final table", rows=len(cat), problems=len(problems))
    if problems:
        raise SystemExit(f"validation failed: {problems}")

    num_cols = ["t_min_c", "t_max_c", "t_opt_c", "freeze_point_c", "chill_threshold_c", "shelf_life_days", "q10"]
    cat[num_cols] = cat[num_cols].round(3)
    cat.to_csv(OUT / "product_catalog_clean.csv", index=False)

    report["final"] = {
        "rows": len(cat),
        "by_category": cat["category"].value_counts().to_dict(),
        "by_safety_class": cat["safety_class"].value_counts().to_dict(),
        "rows_with_any_imputation": int((cat["imputed_fields"] != "").sum()),
        "columns": cols,
    }
    (OUT / "cleaning_report.json").write_text(json.dumps(report, indent=2, default=float))
    catalog_figure(cat)
    print(f"\nSaved {len(cat)} products -> {OUT / 'product_catalog_clean.csv'}")
    print(json.dumps(report["final"], indent=2))
    print(json.dumps(report["s1_vs_s2_agreement"], indent=2, default=float))


if __name__ == "__main__":
    main()

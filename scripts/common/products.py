"""Shared product-catalog logic for Model 4 (mixed-load setpoint) and Model 5 (co-shipment
compatibility).

Imported by BOTH the offline training scripts (scripts/train_model4_*.py, train_model5_*.py) AND
the live backend (backend/app/load_planner.py, the same way backend/app/ml.py imports
model3_shelf_life) -- one implementation of every feature and every physics term, so what the
models were trained on is byte-for-byte what they're scored on in production (no train/serve
skew).

Physics quality-loss model (Model 4's "teacher"), fraction of shelf life consumed per day for one
product at actual temperature X, where the reefer setpoint is mu and X = mu + eps,
eps ~ N(0, sigma^2) (sigma = the reefer's real temperature fluctuation):

    l_i(X) = Q10_i ** ((X - T_opt,i) / 10) / SL_i        Arrhenius/Q10 decay vs. rated shelf life
           + kappa_i * (L_i - X)_+ ** 2                  lower wall at t_min (chilling injury)
           + kappa_f * (T_f,i - delta - X)_+             freezing damage below freezing point

pharma products instead use a symmetric band penalty kappa_p * [(t_min - X)_+^2 + (X - t_max)_+^2],
which puts their optimum at the band centre (5.0 C for 2-8 C vaccines, as the CDC toolkit says).
All three expectations over eps have closed forms (lognormal factor for the Q10 term, normal
partial moments for the walls), so no Monte Carlo is needed and the optimum is exact on a grid.

Hard, regulatory limits (pharma band, FDA Food Code <=5 C for TCS foods, <=-17.8 C for frozen,
produce >= freezing point - delta) are enforced as chance constraints: the setpoint must sit
Z_CHANCE sigmas inside every limit, i.e. ~97.7% of readings stay legal on each side.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

R = 8.314  # J / (mol*K)

ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = ROOT / "data" / "product_catalog" / "product_catalog_clean.csv"

# ---- physics constants (sensitivity analysis in train_model4_mixed_setpoint.py) ----
KAPPA_CHILL = 0.05  # 1/(C^2*day): lower-wall stiffness for chilling-sensitive products
KAPPA_SOFT = 0.01  # 1/(C^2*day): lower-wall stiffness for everything else
KAPPA_FREEZE = 1.0  # 1/(C*day): freezing damage per degree below (freezing point - delta)
KAPPA_PHARMA = 0.05  # 1/(C^2*day): pharma band penalty
SUPERCOOL_DELTA = 0.5  # C: HB66 freezing points are where ice first forms; brief dips are tolerated
Z_CHANCE = 2.0  # setpoint must be 2 sigma inside every hard limit (~97.7% per side)
SIGMA_FLOOR = 0.2  # C: sensors report in 0.5 C steps, so smaller measured sigmas aren't real
GRID_STEP = 0.05  # C
GRID_LO, GRID_HI = -95.0, 30.0

ETHYLENE_PRODUCTION_LABELS = ["none", "very low", "low", "medium", "high"]
ETHYLENE_SENSITIVITY_LABELS = ["not sensitive", "sensitive", "very sensitive"]

# Model 5 pair features. The McGregor compatibility group is deliberately NOT among them --
# it's the label, and tests assert these columns are unchanged when compat_groups is shuffled.
PAIR_FEATURE_COLS = [
    "temp_overlap_c",
    "topt_diff_c",
    "topt_mean_c",
    "rh_overlap",
    "rh_mid_diff",
    "ethylene_risk",
    "ethylene_prod_max",
    "ethylene_sens_max",
    "chill_risk_c",
    "freeze_risk_c",
    "n_chilling_sensitive",
    "log_shelf_life_ratio",
    "same_category",
]

# Model 4 student features -- permutation-invariant aggregates of a load.
LOAD_FEATURE_COLS = [
    "n_products",
    "sigma_c",
    "feasible_lo_c",
    "feasible_hi_c",
    "feasible_width_c",
    "tmin_max_c",
    "tmin_wmean_c",
    "tmax_min_c",
    "tmax_wmean_c",
    "topt_min_c",
    "topt_max_c",
    "topt_wmean_c",
    "topt_wstd_c",
    "wall_max_c",
    "wall_sensitive_max_c",
    "frac_chilling_sensitive",
    "freeze_max_c",
    "q10_wmean",
    "log_sl_wmean",
    "log_sl_min",
    "frac_produce",
    "frac_tcs",
    "frac_frozen",
    "frac_pharma",
    "w_max",
]


# ---------------------------------------------------------------------------------------------
# catalog
# ---------------------------------------------------------------------------------------------
def load_catalog(path: Path | str = CATALOG_PATH) -> pd.DataFrame:
    cat = pd.read_csv(path)
    cat["compat_groups"] = cat["compat_groups"].fillna("").astype(str)
    cat["chilling_sensitive"] = cat["chilling_sensitive"].astype(bool)
    return cat.reset_index(drop=True)


def group_set(value: str) -> frozenset[int]:
    """'1;2' -> {1, 2}; '' -> empty set (product McGregor never grouped)."""
    return frozenset(int(g) for g in str(value).split(";") if g.strip() not in ("", "nan"))


def q10_from_ea(ea_j_per_mol: float, t_ref_c: float) -> float:
    """Q10 implied by an Arrhenius activation energy around t_ref -- lets Model 4 reuse Model 3's
    Ea constants (scripts/model3_shelf_life.py) so the two models agree on how fast each
    category spoils."""
    t1 = t_ref_c + 273.15
    t2 = t1 + 10.0
    return math.exp(10.0 * ea_j_per_mol / (R * t1 * t2))


def hard_bounds(products: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Per-product hard lower/upper limits (C). -inf/+inf where no regulatory limit applies."""
    lo = products["hard_lo_c"].to_numpy(dtype=float).copy()
    freeze = products["freeze_point_c"].to_numpy(dtype=float)
    no_lo = np.isnan(lo)
    lo[no_lo] = freeze[no_lo] - SUPERCOOL_DELTA
    lo[np.isnan(lo)] = -np.inf
    hi = products["hard_hi_c"].to_numpy(dtype=float).copy()
    hi[np.isnan(hi)] = np.inf
    return lo, hi


def feasible_interval(products: pd.DataFrame, sigma: float) -> tuple[float, float]:
    """Setpoint range that keeps every product Z_CHANCE sigma inside its hard limits.
    Empty (lo > hi) means no single setpoint is legal for this load."""
    sigma = max(float(sigma), SIGMA_FLOOR)
    lo, hi = hard_bounds(products)
    return float(np.max(lo) + Z_CHANCE * sigma), float(np.min(hi) - Z_CHANCE * sigma)


# ---------------------------------------------------------------------------------------------
# physics loss (Model 4 teacher)
# ---------------------------------------------------------------------------------------------
def _pos_part_mean(a, mu, sigma):
    """E[(a - X)_+] for X ~ N(mu, sigma^2); broadcasts."""
    d = (a - mu) / sigma
    return (a - mu) * norm.cdf(d) + sigma * norm.pdf(d)


def _pos_part_sq_mean(a, mu, sigma):
    """E[(a - X)_+^2] for X ~ N(mu, sigma^2); broadcasts."""
    d = (a - mu) / sigma
    return ((a - mu) ** 2 + sigma**2) * norm.cdf(d) + (a - mu) * sigma * norm.pdf(d)


def expected_loss_matrix(products: pd.DataFrame, mu_grid: np.ndarray, sigma: float) -> np.ndarray:
    """E[l_i(mu + eps)] for every product i (rows) and every candidate setpoint mu (columns),
    in fraction-of-shelf-life per day."""
    sigma = max(float(sigma), SIGMA_FLOOR)
    mu = np.asarray(mu_grid, dtype=float)[None, :]
    n = len(products)
    out = np.zeros((n, mu.shape[1]))

    is_pharma = (products["safety_class"] == "pharma").to_numpy()
    t_min = products["t_min_c"].to_numpy(dtype=float)[:, None]
    t_max = products["t_max_c"].to_numpy(dtype=float)[:, None]
    t_opt = products["t_opt_c"].to_numpy(dtype=float)[:, None]
    q10 = products["q10"].to_numpy(dtype=float)[:, None]
    sl = products["shelf_life_days"].to_numpy(dtype=float)[:, None]
    freeze = products["freeze_point_c"].to_numpy(dtype=float)[:, None]
    kappa = np.where(products["chilling_sensitive"].to_numpy(), KAPPA_CHILL, KAPPA_SOFT)[:, None]

    # Q10 decay term: E[Q10^((X - t_opt)/10)] = Q10^((mu - t_opt)/10) * exp(0.5 * (sigma*ln Q10/10)^2)
    ln_q = np.log(q10) / 10.0
    decay = np.exp(ln_q * (mu - t_opt) + 0.5 * (sigma * ln_q) ** 2) / sl
    wall = kappa * _pos_part_sq_mean(t_min, mu, sigma)
    freeze_term = np.where(
        np.isnan(freeze), 0.0, KAPPA_FREEZE * _pos_part_mean(np.nan_to_num(freeze) - SUPERCOOL_DELTA, mu, sigma)
    )
    food = decay + wall + freeze_term

    band = KAPPA_PHARMA * (_pos_part_sq_mean(t_min, mu, sigma) + _pos_part_sq_mean(-t_max, -mu, sigma))

    out[:] = np.where(is_pharma[:, None], band, np.nan_to_num(food, nan=0.0))
    return out


def optimize_setpoint(products: pd.DataFrame, weights, sigma: float) -> dict:
    """Exact robust optimum on a GRID_STEP grid. Returns setpoint, feasibility, safe interval,
    a near-optimal tolerance band, and each product's expected loss (%/day) at the setpoint."""
    sigma = max(float(sigma), SIGMA_FLOOR)
    w = np.asarray(weights, dtype=float)
    w = w / w.sum()
    lo, hi = feasible_interval(products, sigma)
    feasible = lo <= hi

    if feasible:
        g_lo = GRID_LO if not math.isfinite(lo) else max(GRID_LO, math.floor(lo / GRID_STEP) * GRID_STEP)
        g_hi = min(GRID_HI, hi)
        grid = np.arange(g_lo, g_hi + GRID_STEP / 2, GRID_STEP)
        grid = grid[(grid >= lo - 1e-9) & (grid <= hi + 1e-9)]
        if grid.size == 0:
            grid = np.array([(lo + hi) / 2])
    else:
        grid = np.arange(GRID_LO, GRID_HI + GRID_STEP / 2, GRID_STEP)

    losses = expected_loss_matrix(products, grid, sigma)
    j = w @ losses
    k = int(np.argmin(j))
    j_min = float(j[k])
    # Flat optimum (e.g. a wide pharma band where the penalty is ~0 everywhere inside): take the
    # middle of the flat run rather than whichever end argmin happens to hit first.
    flat = j <= j_min + 1e-12
    a = b = k
    while a > 0 and flat[a - 1]:
        a -= 1
    while b < len(grid) - 1 and flat[b + 1]:
        b += 1
    k = (a + b) // 2

    # Tolerance band: contiguous setpoints around the optimum within 10% (or 0.05 %/day) of it.
    tol = max(0.10 * j_min, 0.0005)
    ok = j <= j_min + tol
    left = k
    while left > 0 and ok[left - 1]:
        left -= 1
    right = k
    while right < len(grid) - 1 and ok[right + 1]:
        right += 1

    return {
        "setpoint_c": round(float(grid[k]), 2),
        "feasible": bool(feasible),
        "safe_lo_c": float(lo),
        "safe_hi_c": float(hi),
        "band_lo_c": round(float(grid[left]), 2),
        "band_hi_c": round(float(grid[right]), 2),
        "expected_loss_pct_per_day": round(100.0 * j_min, 4),
        "per_product_loss_pct_per_day": [round(100.0 * float(x), 4) for x in losses[:, k]],
    }


def weighted_loss_at(products: pd.DataFrame, weights, sigma: float, setpoint: float) -> float:
    w = np.asarray(weights, dtype=float)
    w = w / w.sum()
    return float(w @ expected_loss_matrix(products, np.array([setpoint]), sigma)[:, 0])


# ---------------------------------------------------------------------------------------------
# Model 5 pair features, policy layer, explanations
# ---------------------------------------------------------------------------------------------
def pair_feature_frame(cat: pd.DataFrame, idx_a, idx_b) -> pd.DataFrame:
    """Symmetric pair features for many pairs at once (rows of `cat` given by index arrays)."""
    a = cat.iloc[np.asarray(idx_a)].reset_index(drop=True)
    b = cat.iloc[np.asarray(idx_b)].reset_index(drop=True)

    def col(df, name):
        return df[name].to_numpy(dtype=float)

    ta_min, ta_max, ta_opt = col(a, "t_min_c"), col(a, "t_max_c"), col(a, "t_opt_c")
    tb_min, tb_max, tb_opt = col(b, "t_min_c"), col(b, "t_max_c"), col(b, "t_opt_c")
    ea_p, ea_s = col(a, "ethylene_production"), col(a, "ethylene_sensitivity")
    eb_p, eb_s = col(b, "ethylene_production"), col(b, "ethylene_sensitivity")
    sens_a = a["chilling_sensitive"].to_numpy(dtype=bool)
    sens_b = b["chilling_sensitive"].to_numpy(dtype=bool)
    chill_a = np.where(np.isnan(col(a, "chill_threshold_c")), ta_min, col(a, "chill_threshold_c"))
    chill_b = np.where(np.isnan(col(b, "chill_threshold_c")), tb_min, col(b, "chill_threshold_c"))
    fa, fb = col(a, "freeze_point_c"), col(b, "freeze_point_c")

    chill_ab = np.where(sens_a, np.maximum(0.0, chill_a - tb_opt), 0.0)
    chill_ba = np.where(sens_b, np.maximum(0.0, chill_b - ta_opt), 0.0)
    freeze_ab = np.nan_to_num(np.maximum(0.0, fa - tb_min), nan=0.0)
    freeze_ba = np.nan_to_num(np.maximum(0.0, fb - ta_min), nan=0.0)

    return pd.DataFrame(
        {
            "temp_overlap_c": np.minimum(ta_max, tb_max) - np.maximum(ta_min, tb_min),
            "topt_diff_c": np.abs(ta_opt - tb_opt),
            "topt_mean_c": (ta_opt + tb_opt) / 2,
            "rh_overlap": np.minimum(col(a, "rh_max"), col(b, "rh_max")) - np.maximum(col(a, "rh_min"), col(b, "rh_min")),
            "rh_mid_diff": np.abs((col(a, "rh_min") + col(a, "rh_max")) / 2 - (col(b, "rh_min") + col(b, "rh_max")) / 2),
            "ethylene_risk": np.maximum(ea_p * eb_s, eb_p * ea_s),
            "ethylene_prod_max": np.maximum(ea_p, eb_p),
            "ethylene_sens_max": np.maximum(ea_s, eb_s),
            "chill_risk_c": np.maximum(chill_ab, chill_ba),
            "freeze_risk_c": np.maximum(freeze_ab, freeze_ba),
            "n_chilling_sensitive": sens_a.astype(int) + sens_b.astype(int),
            "log_shelf_life_ratio": np.abs(np.log(col(a, "shelf_life_days")) - np.log(col(b, "shelf_life_days"))),
            "same_category": (a["category"].to_numpy() == b["category"].to_numpy()).astype(int),
        }
    )[PAIR_FEATURE_COLS]


def policy_vetoes(a: pd.Series, b: pd.Series) -> list[str]:
    """Regulatory segregation rules. These are POLICY, not ML -- they're never used as training
    labels (that would make Model 5's accuracy circular), only applied on top of its output."""
    reasons = []
    pa, pb = a["safety_class"] == "pharma", b["safety_class"] == "pharma"
    if pa != pb:
        reasons.append(
            "Medicines must be segregated from food (WHO TRS 961 Annex 9; EU GDP Guidelines 2013/C 343/01)."
        )
    raw = {"raw_animal"}
    clean = {"produce", "ready_to_eat"}
    if (a["safety_class"] in raw and b["safety_class"] in clean) or (b["safety_class"] in raw and a["safety_class"] in clean):
        raw_name = a["name"] if a["safety_class"] in raw else b["name"]
        reasons.append(
            f"{raw_name} is a raw animal food: keep it separated from produce / ready-to-eat food (FDA Food Code 3-302.11)."
        )
    return reasons


# Odor notes that actually appear in the downloaded sources (S1 comments, S3 footnotes). Used as
# non-blocking warnings only -- not a model feature, because the sources don't cover odor
# systematically enough to train on.
ODOR_NOTES = [
    ({"lemons", "limes", "oranges", "tangerines", "grapefruit"}, None, "Citrus treated with biphenyl may give odors to other products (McGregor 1989 via FAO)."),
    ({"pineapples"}, {"avocados_ripe", "avocados_unripe"}, "Pineapple odor may influence avocados (Engineering ToolBox note)."),
]


def pair_warnings(a: pd.Series, b: pd.Series) -> list[str]:
    out = []
    for emitters, receivers, text in ODOR_NOTES:
        for x, y in ((a, b), (b, a)):
            if x["product_id"] in emitters and (receivers is None or y["product_id"] in receivers):
                out.append(text)
                break
    return out


def pair_reasons(a: pd.Series, b: pd.Series, feats: pd.Series) -> list[str]:
    """Plain-English physical reasons a pair may clash, derived from the same features the
    classifier sees (so the explanation matches what the model looked at)."""
    reasons = []
    for x, y in ((a, b), (b, a)):
        # A heavy producer next to another heavy producer isn't flagged: the receiver is already
        # bathed in its own ethylene (McGregor's group 1 deliberately ships producers together).
        if x["ethylene_production"] >= 3 and y["ethylene_sensitivity"] >= 1 and y["ethylene_production"] <= 2:
            reasons.append(
                f"Ethylene: {x['name']} produces ethylene ({ETHYLENE_PRODUCTION_LABELS[int(x['ethylene_production'])]}) "
                f"and {y['name']} is {ETHYLENE_SENSITIVITY_LABELS[int(y['ethylene_sensitivity'])]}."
            )
    if feats["temp_overlap_c"] < 0:
        lo, hi = (a, b) if a["t_opt_c"] < b["t_opt_c"] else (b, a)
        reasons.append(
            f"Temperature: {lo['name']} is stored at {lo['t_min_c']:.1f}-{lo['t_max_c']:.1f} C but "
            f"{hi['name']} needs {hi['t_min_c']:.1f}-{hi['t_max_c']:.1f} C (no overlap)."
        )
    if feats["chill_risk_c"] >= 2:
        reasons.append(f"Chilling injury: the colder item's temperature is {feats['chill_risk_c']:.1f} C below the other's chilling limit.")
    if feats["freeze_risk_c"] >= 0.5:
        reasons.append(f"Freezing: one item's recommended low end is {feats['freeze_risk_c']:.1f} C below the other's freezing point.")
    if not np.isnan(feats["rh_mid_diff"]) and feats["rh_mid_diff"] >= 15:
        reasons.append(
            f"Humidity: {a['name']} wants {a['rh_min']:.0f}-{a['rh_max']:.0f}% RH, "
            f"{b['name']} wants {b['rh_min']:.0f}-{b['rh_max']:.0f}% RH."
        )
    return reasons


# ---------------------------------------------------------------------------------------------
# Model 4 student features
# ---------------------------------------------------------------------------------------------
def load_features(products: pd.DataFrame, weights, sigma: float) -> dict:
    sigma = max(float(sigma), SIGMA_FLOOR)
    w = np.asarray(weights, dtype=float)
    w = w / w.sum()
    lo, hi = feasible_interval(products, sigma)
    t_min = products["t_min_c"].to_numpy(dtype=float)
    t_max = products["t_max_c"].to_numpy(dtype=float)
    t_opt = products["t_opt_c"].to_numpy(dtype=float)
    sens = products["chilling_sensitive"].to_numpy(dtype=bool)
    freeze = products["freeze_point_c"].to_numpy(dtype=float)
    q10 = products["q10"].to_numpy(dtype=float)
    sl = products["shelf_life_days"].to_numpy(dtype=float)
    cls = products["safety_class"].to_numpy()
    tcs = ~np.isnan(products["hard_hi_c"].to_numpy(dtype=float)) & (cls != "pharma") & (cls != "frozen")
    topt_wmean = float(w @ t_opt)
    sl_valid = np.where(np.isnan(sl), np.nanmedian(sl) if np.any(~np.isnan(sl)) else 30.0, sl)
    return {
        "n_products": len(products),
        "sigma_c": sigma,
        "feasible_lo_c": lo,
        "feasible_hi_c": hi,
        "feasible_width_c": hi - lo,
        "tmin_max_c": float(t_min.max()),
        "tmin_wmean_c": float(w @ t_min),
        "tmax_min_c": float(t_max.min()),
        "tmax_wmean_c": float(w @ t_max),
        "topt_min_c": float(t_opt.min()),
        "topt_max_c": float(t_opt.max()),
        "topt_wmean_c": topt_wmean,
        "topt_wstd_c": float(np.sqrt(w @ (t_opt - topt_wmean) ** 2)),
        "wall_max_c": float(t_min.max()),
        "wall_sensitive_max_c": float(t_min[sens].max()) if sens.any() else float(np.nan),
        "frac_chilling_sensitive": float(w @ sens.astype(float)),
        "freeze_max_c": float(np.nanmax(freeze)) if np.any(~np.isnan(freeze)) else float(np.nan),
        "q10_wmean": float(w @ q10),
        "log_sl_wmean": float(w @ np.log(sl_valid)),
        "log_sl_min": float(np.log(sl_valid).min()),
        "frac_produce": float(w @ (cls == "produce").astype(float)),
        "frac_tcs": float(w @ tcs.astype(float)),
        "frac_frozen": float(w @ (cls == "frozen").astype(float)),
        "frac_pharma": float(w @ (cls == "pharma").astype(float)),
        "w_max": float(w.max()),
    }


# ---------------------------------------------------------------------------------------------
# grouping
# ---------------------------------------------------------------------------------------------
def dsatur_groups(n: int, incompatible: set[tuple[int, int]]) -> list[list[int]]:
    """Colour the incompatibility graph with DSatur (Brelaz 1979): repeatedly colour the vertex
    whose neighbours already use the most distinct colours. Each colour class is a set of
    mutually-compatible products = one compartment / truck. Greedy, so not always the minimum
    number of groups, but optimal on many graph families and fast for a truckload."""
    adj = [set() for _ in range(n)]
    for i, j in incompatible:
        adj[i].add(j)
        adj[j].add(i)
    colour = [-1] * n
    for _ in range(n):
        best, best_key = None, None
        for v in range(n):
            if colour[v] != -1:
                continue
            sat = len({colour[u] for u in adj[v] if colour[u] != -1})
            key = (sat, len(adj[v]), -v)
            if best_key is None or key > best_key:
                best, best_key = v, key
        used = {colour[u] for u in adj[best] if colour[u] != -1}
        c = 0
        while c in used:
            c += 1
        colour[best] = c
    groups: dict[int, list[int]] = {}
    for v, c in enumerate(colour):
        groups.setdefault(c, []).append(v)
    return [groups[c] for c in sorted(groups)]


# ---------------------------------------------------------------------------------------------
# Model 4 student design (shared by training and serving)
# ---------------------------------------------------------------------------------------------
# Tree models cannot extrapolate beyond the targets they were trained on, so a student fed raw
# temperatures fails on bands it never saw (first run: ultra-cold mRNA vaccines at -75 C and
# room-temperature medicines at 22.5 C sat only in the held-out split -> errors of 7-14 C). The
# student therefore works in coordinates RELATIVE to the load's weighted-mean optimum: every
# absolute temperature feature is shifted by it and the target is (setpoint - anchor). The
# physics is shift-invariant in the same way, so this loses nothing and generalises to any band.
STUDENT_ANCHOR = "topt_wmean_c"
STUDENT_RELATIVE_COLS = [
    "feasible_lo_c", "feasible_hi_c", "tmin_max_c", "tmin_wmean_c", "tmax_min_c", "tmax_wmean_c",
    "topt_min_c", "topt_max_c", "wall_max_c", "wall_sensitive_max_c", "freeze_max_c",
]
STUDENT_FEATURE_COLS = [c for c in LOAD_FEATURE_COLS if c != STUDENT_ANCHOR]


def student_matrix(feats: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    """Load-feature frame -> (student design matrix, anchor per row)."""
    f = feats.replace([np.inf, -np.inf], np.nan)
    anchor = f[STUDENT_ANCHOR].to_numpy(dtype=float)
    x = f[STUDENT_FEATURE_COLS].copy()
    for c in STUDENT_RELATIVE_COLS:
        x[c] = f[c] - anchor
    return x, anchor


def student_predict(model, feats: pd.DataFrame) -> np.ndarray:
    """Student setpoint, clipped into the chance-constrained safe interval (the safety wrapper)."""
    x, anchor = student_matrix(feats)
    pred = model.predict(x) + anchor
    lo = feats["feasible_lo_c"].replace(-np.inf, np.nan).fillna(-np.inf).to_numpy(dtype=float)
    hi = feats["feasible_hi_c"].replace(np.inf, np.nan).fillna(np.inf).to_numpy(dtype=float)
    return np.clip(pred, lo, hi)

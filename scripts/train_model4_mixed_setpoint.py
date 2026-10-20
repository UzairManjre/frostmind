"""
Model 4 -- mixed-load setpoint recommender: "one reefer, many products: what temperature?"

Teacher: the physics-informed robust optimizer in common.products (Arrhenius/Q10 decay,
chilling-injury wall, freezing damage, regulatory chance constraints, all in closed form under
the reefer's real temperature fluctuation sigma). It is exact but needs the full per-product
kinetic model for every item on the truck.

Student (the trained ML model): a gradient-boosting / random-forest regressor over 24
permutation-invariant load features (common.products.STUDENT_FEATURE_COLS), expressed relative
to the load's weighted-mean optimum so it generalises to temperature bands it never saw
(see common.products.student_matrix for why). It is
trained on ~20k SIMULATED mixed loads -- random combinations of REAL catalog products, with
Dirichlet quantity shares and sigma drawn from the REAL milk-transport fluctuation distribution
(estimate_reefer_fluctuation.py) -- each labelled by the teacher. This is teacher-student
distillation / surrogate modelling: be explicit in the write-up that the labels come from our
physics model, not from measured outcomes. The student is the piece that gets fine-tuned once
FROSTMIND logs real delivery-quality outcomes (same plan as Model 3's "learned correction").

Honest evaluation:
  * product-disjoint: test loads are built only from products the student never saw;
  * compared against three hand-rule baselines;
  * regret = extra shelf-life loss (%/day) caused by using the prediction instead of the optimum;
  * external validation of BOTH teacher and student against McGregor 1989's published group
    temperatures (never used anywhere in training);
  * sensitivity of the teacher to its own constants.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline

sys.path.insert(0, str(Path(__file__).parent))

import common.products as P  # noqa: E402
from common import plotstyle  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "models"
DATA_OUT = ROOT / "data" / "product_catalog"
FLUCT = DATA_OUT / "reefer_fluctuation.json"
SEED = 42
N_TRAIN_LOADS = 16000
N_TEST_LOADS = 4000
MAX_PRODUCTS = 8

# McGregor 1989 published group conditions (FAO ae075e16) -- external validation targets.
MCGREGOR_RANGES = {1: (0.0, 2.0), 2: (0.0, 2.0), 3: (0.0, 2.0), 4: (3.5, 5.5), 5: (9.0, 11.0), 6: (13.0, 15.0), 7: (18.0, 21.0)}
MCGREGOR_NOTE = "G4 and G5 are single published values (4.5 C, 10 C), scored as +/-1 C."

WORKED_EXAMPLES = {
    "Apples + pears + grapes": ["apples", "pears", "grapes"],
    "Lettuce + broccoli + spinach": ["lettuce", "broccoli", "spinach"],
    "Bananas + mangos + avocados (ripe)": ["bananas_ripe", "mangos", "avocados_ripe"],
    "Cucumbers + peppers + eggplant": ["cucumbers", "peppers_sweet", "eggplant"],
    "Milk + yogurt + cheese": ["milk_pasteurized", "yogurt", "cheese_hard_cheddar_swiss"],
    "Chicken + beef (raw)": ["poultry_fresh", "beef_fresh_steaks_and_roasts"],
    "Vaccines + insulin": ["vaccines_refrigerated", "insulin_unopened"],
    "Frozen vegetables + ice cream": ["frozen_vegetables", "ice_cream"],
    "Lettuce + bananas (incompatible)": ["lettuce", "bananas_ripe"],
}


def vetoed(sub: pd.DataFrame) -> bool:
    cls = set(sub["safety_class"])
    if "pharma" in cls and len(cls) > 1:
        return True
    return "raw_animal" in cls and bool(cls & {"produce", "ready_to_eat"})


def sample_loads(cat: pd.DataFrame, pool: np.ndarray, n: int, sigmas: np.ndarray, rng) -> list[dict]:
    groups = {i: P.group_set(cat.at[i, "compat_groups"]) for i in pool}
    t_opt = cat["t_opt_c"].to_numpy()
    loads, tries = [], 0
    while len(loads) < n and tries < n * 50:
        tries += 1
        strategy = rng.choice(["same_group", "same_regime", "random"], p=[0.4, 0.3, 0.3])
        anchor = rng.choice(pool)
        if strategy == "same_group" and groups[anchor]:
            g = rng.choice(sorted(groups[anchor]))
            cand = np.array([i for i in pool if g in groups[i]])
        elif strategy == "same_regime":
            cand = pool[np.abs(t_opt[pool] - t_opt[anchor]) <= 3.0]
        else:
            cand = pool
        k = int(rng.integers(1, MAX_PRODUCTS + 1))
        k = min(k, len(cand))
        idx = rng.choice(cand, size=k, replace=False)
        sub = cat.loc[idx]
        if vetoed(sub):
            continue
        w = rng.dirichlet(np.ones(k))
        sigma = float(rng.choice(sigmas))
        res = P.optimize_setpoint(sub, w, sigma)
        if not res["feasible"]:
            continue
        loads.append({"idx": idx, "w": w, "sigma": sigma, "strategy": strategy, **res})
    return loads


def to_frame(cat: pd.DataFrame, loads: list[dict]) -> pd.DataFrame:
    rows = []
    for ld in loads:
        f = P.load_features(cat.loc[ld["idx"]], ld["w"], ld["sigma"])
        rows.append({**f, "target_setpoint_c": ld["setpoint_c"], "optimum_loss": ld["expected_loss_pct_per_day"], "strategy": ld["strategy"]})
    df = pd.DataFrame(rows)
    return df.replace([np.inf, -np.inf], np.nan)


def clip_to_safe(pred, df):
    lo = df["feasible_lo_c"].fillna(-np.inf).to_numpy()
    hi = df["feasible_hi_c"].fillna(np.inf).to_numpy()
    return np.clip(pred, lo, hi)


def baselines(cat: pd.DataFrame, loads: list[dict], df: pd.DataFrame) -> dict[str, np.ndarray]:
    mid, wmean, warm = [], [], []
    for ld in loads:
        sub = cat.loc[ld["idx"]]
        lo, hi = sub["t_min_c"].max(), sub["t_max_c"].min()
        mid.append((lo + hi) / 2 if lo <= hi else sub["t_opt_c"].mean())
        wmean.append(float(np.asarray(ld["w"]) @ sub["t_opt_c"].to_numpy()))
        warm.append(float(sub["t_opt_c"].max()))
    return {
        "baseline_range_midpoint": clip_to_safe(np.asarray(mid), df),
        "baseline_weighted_mean_topt": clip_to_safe(np.asarray(wmean), df),
        "baseline_warmest_product_topt": clip_to_safe(np.asarray(warm), df),
    }


def score(cat, loads, df, pred) -> dict:
    y = df["target_setpoint_c"].to_numpy()
    err = np.abs(pred - y)
    regret = np.array(
        [100 * P.weighted_loss_at(cat.loc[ld["idx"]], ld["w"], ld["sigma"], p) - ld["expected_loss_pct_per_day"] for ld, p in zip(loads, pred)]
    )
    return {
        "mae_c": round(float(err.mean()), 4),
        "rmse_c": round(float(np.sqrt(mean_squared_error(y, pred))), 4),
        "r2": round(float(r2_score(y, pred)), 4),
        "within_0_5c_pct": round(float(100 * (err <= 0.5).mean()), 2),
        "within_1c_pct": round(float(100 * (err <= 1.0).mean()), 2),
        "mean_regret_pct_per_day": round(float(np.maximum(regret, 0).mean()), 5),
        "p95_regret_pct_per_day": round(float(np.percentile(np.maximum(regret, 0), 95)), 5),
    }


def main():
    plotstyle.apply()
    rng = np.random.default_rng(SEED)
    cat = P.load_catalog()
    fl = json.loads(FLUCT.read_text())
    normal = np.asarray(fl["normal_sigmas_clipped"])
    stress = np.maximum(np.asarray(fl["stress_sigmas"]), P.SIGMA_FLOOR)
    # 75% normal operation, 25% excursion-prone reefers
    sigmas = np.concatenate([np.repeat(normal, 3), stress])

    # ---- product-disjoint split (stratified by safety class so pharma/frozen land on both sides)
    idx = cat.index.to_numpy()
    tr_p, te_p = train_test_split(idx, test_size=0.3, random_state=SEED, stratify=cat["safety_class"])
    print(f"products: train {len(tr_p)}, test {len(te_p)}")
    train_loads = sample_loads(cat, np.asarray(tr_p), N_TRAIN_LOADS, sigmas, rng)
    test_loads = sample_loads(cat, np.asarray(te_p), N_TEST_LOADS, sigmas, rng)
    tr_df, te_df = to_frame(cat, train_loads), to_frame(cat, test_loads)
    print(f"loads: train {len(tr_df)}, test {len(te_df)} (feasible only)")
    tr_df.assign(split="train").to_csv(DATA_OUT / "mixed_load_scenarios_train.csv.gz", index=False)
    te_df.assign(split="test").to_csv(DATA_OUT / "mixed_load_scenarios_test.csv.gz", index=False)

    x_tr, anchor_tr = P.student_matrix(tr_df)
    y_tr = tr_df["target_setpoint_c"].to_numpy() - anchor_tr

    candidates = {
        "hist_gradient_boosting": HistGradientBoostingRegressor(
            learning_rate=0.05, max_iter=600, max_depth=6, min_samples_leaf=20, l2_regularization=1.0, random_state=SEED
        ),
        "random_forest": make_pipeline(
            SimpleImputer(strategy="median"), RandomForestRegressor(n_estimators=300, min_samples_leaf=3, random_state=SEED, n_jobs=-1)
        ),
    }
    results, preds = {}, {}
    for name, model in candidates.items():
        model.fit(x_tr, y_tr)
        preds[name] = P.student_predict(model, te_df)
        results[name] = score(cat, test_loads, te_df, preds[name])
    for name, p in baselines(cat, test_loads, te_df).items():
        preds[name] = p
        results[name] = score(cat, test_loads, te_df, p)
    for name, r in results.items():
        print(f"  {name:<32} MAE {r['mae_c']:.3f} C  within0.5 {r['within_0_5c_pct']:.1f}%  R2 {r['r2']:.3f}  regret {r['mean_regret_pct_per_day']:.4f} %/day")
    best = min(candidates, key=lambda n: results[n]["mae_c"])

    # ---- external validation vs McGregor group temperatures (teacher + held-out student)
    sigma0 = fl["default_sigma_c"]
    student_eval = candidates[best]
    mc_rows = []
    for g, (glo, ghi) in MCGREGOR_RANGES.items():
        members = cat.index[cat["compat_groups"].map(lambda s, g=g: g in P.group_set(s))].to_numpy()
        subsets = [members] + [rng.choice(members, size=int(rng.integers(2, min(5, len(members)) + 1)), replace=False) for _ in range(100 if len(members) > 2 else 0)]
        for sub_idx in subsets:
            sub = cat.loc[sub_idx]
            w = np.ones(len(sub))
            teacher = P.optimize_setpoint(sub, w, sigma0)
            if not teacher["feasible"]:
                continue
            f = pd.DataFrame([P.load_features(sub, w, sigma0)]).replace([np.inf, -np.inf], np.nan)
            stud = float(P.student_predict(student_eval, f)[0])
            unseen = bool(np.isin(sub_idx, te_p).all())
            for who, val in (("teacher", teacher["setpoint_c"]), ("student", stud)):
                dist = max(glo - val, 0.0, val - ghi)
                mc_rows.append({"group": g, "who": who, "setpoint": val, "inside": dist == 0, "within_0_5": dist <= 0.5, "dist": dist, "full_group": len(sub_idx) == len(members), "all_unseen": unseen})
    mc = pd.DataFrame(mc_rows)
    # How often do the per-product source ranges (S1/HB66) even overlap McGregor's group range?
    # Low overlap means the disagreement is between the SOURCES, not a modelling error.
    consistency = {}
    for g, (glo, ghi) in MCGREGOR_RANGES.items():
        members = cat[cat["compat_groups"].map(lambda s, g=g: g in P.group_set(s))]
        overlap = (members["t_min_c"] <= ghi + 0.5) & (members["t_max_c"] >= glo - 0.5)
        consistency[g] = {"members": int(len(members)), "own_range_overlaps_group_pct": round(100 * float(overlap.mean()), 1),
                          "non_overlapping": members.loc[~overlap, "product_id"].tolist()}
    print(json.dumps(consistency, indent=1))
    mc_summary = (
        mc.groupby(["group", "who"])
        .agg(n=("inside", "size"), inside_pct=("inside", lambda s: round(100 * s.mean(), 1)), within_0_5_pct=("within_0_5", lambda s: round(100 * s.mean(), 1)), mean_dist_c=("dist", lambda s: round(s.mean(), 3)), median_setpoint=("setpoint", "median"))
        .reset_index()
    )
    print(mc_summary.to_string(index=False))

    # ---- sanity: single products inside their own published range
    single = []
    for i in cat.index[cat["safety_class"] != "pharma"]:
        r = P.optimize_setpoint(cat.loc[[i]], [1.0], sigma0)
        single.append(cat.at[i, "t_min_c"] - 0.5 <= r["setpoint_c"] <= cat.at[i, "t_max_c"] + 0.5)
    single_pct = round(100 * float(np.mean(single)), 1)

    # ---- teacher sensitivity to its own constants (300 test loads)
    probe = test_loads[:300]
    base = np.array([ld["setpoint_c"] for ld in probe])
    sensitivity = {}
    for const, values in {"KAPPA_FREEZE": [0.3, 3.0], "KAPPA_CHILL": [0.02, 0.1], "KAPPA_SOFT": [0.003, 0.03], "SUPERCOOL_DELTA": [0.0, 1.0]}.items():
        orig = getattr(P, const)
        for v in values:
            setattr(P, const, v)
            new = np.array([P.optimize_setpoint(cat.loc[ld["idx"]], ld["w"], ld["sigma"])["setpoint_c"] for ld in probe])
            sensitivity[f"{const}={v}"] = {"mean_abs_shift_c": round(float(np.abs(new - base).mean()), 3), "max_abs_shift_c": round(float(np.abs(new - base).max()), 3)}
        setattr(P, const, orig)
    for mult in (0.8, 1.2):
        c2 = cat.copy()
        c2.loc[c2["safety_class"] == "produce", "q10"] *= mult
        new = np.array([P.optimize_setpoint(c2.loc[ld["idx"]], ld["w"], ld["sigma"])["setpoint_c"] for ld in probe])
        sensitivity[f"produce_Q10_x{mult}"] = {"mean_abs_shift_c": round(float(np.abs(new - base).mean()), 3), "max_abs_shift_c": round(float(np.abs(new - base).max()), 3)}
    print(json.dumps(sensitivity, indent=1))

    # ---- final student on all simulated loads
    all_df = pd.concat([tr_df, te_df], ignore_index=True)
    from sklearn.base import clone

    final = clone(candidates[best])
    x_all, anchor_all = P.student_matrix(all_df)
    final.fit(x_all, all_df["target_setpoint_c"].to_numpy() - anchor_all)
    joblib.dump(final, OUT / "model4_mixed_setpoint.pkl")

    examples = []
    for label, pids in WORKED_EXAMPLES.items():
        sub = cat[cat["product_id"].isin(pids)]
        w = np.ones(len(sub))
        t = P.optimize_setpoint(sub, w, sigma0)
        f = pd.DataFrame([P.load_features(sub, w, sigma0)]).replace([np.inf, -np.inf], np.nan)
        s = float(P.student_predict(final, f)[0]) if t["feasible"] else None
        examples.append({"load": label, "products": pids, "sigma_c": sigma0, "feasible": t["feasible"], "teacher_setpoint_c": t["setpoint_c"], "student_setpoint_c": None if s is None else round(s, 2), "band_c": [t["band_lo_c"], t["band_hi_c"]], "expected_loss_pct_per_day": t["expected_loss_pct_per_day"]})
    print(pd.DataFrame(examples)[["load", "feasible", "teacher_setpoint_c", "student_setpoint_c", "band_c", "expected_loss_pct_per_day"]].to_string(index=False))

    metrics_out = {
        "model": best,
        "teacher": "common.products.optimize_setpoint (closed-form expected loss, 0.05 C grid, Z=2 chance constraints)",
        "physics_constants": {k: getattr(P, k) for k in ("KAPPA_CHILL", "KAPPA_SOFT", "KAPPA_FREEZE", "KAPPA_PHARMA", "SUPERCOOL_DELTA", "Z_CHANCE", "SIGMA_FLOOR", "GRID_STEP")},
        "feature_cols": P.STUDENT_FEATURE_COLS,
        "target": f"setpoint_c - {P.STUDENT_ANCHOR} (features shifted by the same anchor; see common.products.student_matrix)",
        "sigma_source": fl["source"],
        "default_sigma_c": sigma0,
        "n_products_train": int(len(tr_p)),
        "n_products_test": int(len(te_p)),
        "n_loads_train": int(len(tr_df)),
        "n_loads_test": int(len(te_df)),
        "load_strategy_mix": {"same_mcgregor_group": 0.4, "same_temperature_regime": 0.3, "random": 0.3},
        "product_disjoint_test": results,
        "mcgregor_external_validation": mc_summary.to_dict("records"),
        "mcgregor_note": MCGREGOR_NOTE,
        "mcgregor_source_consistency": consistency,
        "single_product_inside_own_range_pct": single_pct,
        "teacher_sensitivity": sensitivity,
        "worked_examples": examples,
        "serving_guard": "prediction clipped to the chance-constrained safe interval; backend falls back to the teacher if |student - teacher| > 0.5 C",
        "hyperparameters": {name: str(m) for name, m in candidates.items()},
    }
    (OUT / "model4_mixed_setpoint_metrics.json").write_text(json.dumps(metrics_out, indent=2, default=float))
    print(f"Saved model -> {OUT / 'model4_mixed_setpoint.pkl'}")

    # ------------------------------------------------------------------ figures
    import matplotlib.pyplot as plt

    y = te_df["target_setpoint_c"].to_numpy()
    fig, ax = plt.subplots(figsize=(5.2, 5))
    ax.scatter(y, preds[best], s=8, alpha=0.35, color=plotstyle.SERIES[0], edgecolors="none", label="Test load")
    lim = [min(y.min(), preds[best].min()) - 2, max(y.max(), preds[best].max()) + 2]
    ax.plot(lim, lim, color=plotstyle.TEXT_SECONDARY, lw=1, ls="--", label="Perfect prediction")
    ax.set(xlim=lim, ylim=lim, xlabel="Teacher (physics optimum) setpoint, C", ylabel="Student (ML) setpoint, C")
    ax.set_title(f"Model 4 student on unseen products\nMAE {results[best]['mae_c']:.2f} C, R² {results[best]['r2']:.3f}")
    ax.legend(loc="upper left")
    plotstyle.save(fig, "m4_pred_vs_true.png")

    order = [best] + [n for n in results if n.startswith("baseline")] + [n for n in candidates if n != best]
    pretty = {"hist_gradient_boosting": "Gradient boosting (student)", "random_forest": "Random forest", "baseline_range_midpoint": "Baseline: midpoint of shared range", "baseline_weighted_mean_topt": "Baseline: weighted mean optimum", "baseline_warmest_product_topt": "Baseline: warmest product's optimum"}
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.6), sharey=True)
    for ax, metric, title, fmt in ((axes[0], "mae_c", "Mean absolute error (C) - lower is better", "{:.2f}"), (axes[1], "within_0_5c_pct", "Within ±0.5 C of optimum (%) - higher is better", "{:.0f}%")):
        vals = [results[n][metric] for n in order]
        yy = np.arange(len(order))[::-1]
        colors = [plotstyle.SERIES[0] if n == best else ("#9ec5f4" if n in candidates else "#c3c2b7") for n in order]
        ax.barh(yy, vals, color=colors, height=0.6)
        for yi, v in zip(yy, vals):
            ax.text(v + max(vals) * 0.02, yi, fmt.format(v), va="center", fontsize=9, color=plotstyle.TEXT_PRIMARY)
        ax.set_yticks(yy, [pretty[n] for n in order])
        ax.set_xlim(0, max(vals) * 1.18)
        ax.set_title(title, fontsize=10.5)
        ax.grid(axis="y", visible=False)
    fig.tight_layout()
    plotstyle.save(fig, "m4_baselines.png")

    fig, ax = plt.subplots(figsize=(8, 4.2))
    for g, (glo, ghi) in MCGREGOR_RANGES.items():
        ax.fill_between([g - 0.4, g + 0.4], glo, ghi, color="#e4e3df", zorder=0, label="McGregor published range" if g == 1 else None)
        for k, who in enumerate(("teacher", "student")):
            v = mc[(mc["group"] == g) & (mc["who"] == who)]["setpoint"].to_numpy()
            jitter = rng.uniform(-0.12, 0.12, len(v)) + (-0.18 if who == "teacher" else 0.18)
            ax.scatter(np.full(len(v), g) + jitter, v, s=10, alpha=0.5, color=plotstyle.SERIES[k], edgecolors="none", label=("Teacher (physics)" if who == "teacher" else "Student (ML)") if g == 1 else None)
    ax.set_xticks(list(MCGREGOR_RANGES), [f"G{g}" for g in MCGREGOR_RANGES])
    ax.set(xlabel="McGregor compatibility group", ylabel="Recommended setpoint, C")
    ax.set_title("External check: recommended setpoints vs McGregor 1989 group temperatures")
    ax.legend(loc="upper left", markerscale=2)
    plotstyle.save(fig, "m4_mcgregor_validation.png")

    # loss curve anatomy for one mixed load
    sub = cat[cat["product_id"].isin(["lettuce", "apples", "cucumbers"])]
    grid = np.arange(-3, 16, 0.05)
    L = P.expected_loss_matrix(sub, grid, sigma0)
    J = L.mean(axis=0)
    fig, ax = plt.subplots(figsize=(8, 4))
    for k, (_, r) in enumerate(sub.iterrows()):
        ax.plot(grid, 100 * L[k], color=plotstyle.SERIES[k + 1], lw=1.5, label=r["name"])
    ax.plot(grid, 100 * J, color=plotstyle.SERIES[0], lw=2.5, label="Load objective J(μ)")
    t = P.optimize_setpoint(sub, np.ones(len(sub)), sigma0)
    ax.axvline(t["setpoint_c"], color=plotstyle.TEXT_SECONDARY, lw=1, ls="--")
    ax.text(t["setpoint_c"] + 0.2, 1.0, f"optimum {t['setpoint_c']:.1f} C", color=plotstyle.TEXT_PRIMARY, fontsize=9)
    ax.set_ylim(0, min(40, 100 * L.max()))
    ax.set(xlabel="Reefer setpoint μ, C", ylabel="Expected shelf life used, %/day")
    ax.set_title(f"How the teacher picks a setpoint (σ = {sigma0} C): lettuce + apples + cucumbers")
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    plotstyle.save(fig, "m4_loss_curve.png")

    fig, ax = plt.subplots(figsize=(7, 3.6))
    bins = np.linspace(0, max(1.5, stress.max()), 30)
    ax.hist(np.asarray(fl["normal_sigmas_clipped"]), bins=bins, color=plotstyle.SERIES[0], alpha=0.85, label="In-spec sessions (normal)")
    ax.hist(stress, bins=bins, color=plotstyle.SERIES[1], alpha=0.6, label="Sessions with excursions (stress)")
    ax.axvline(sigma0, color=plotstyle.TEXT_SECONDARY, lw=1, ls="--")
    ax.text(sigma0 + 0.02, ax.get_ylim()[1] * 0.9, f"default σ = {sigma0} C", fontsize=9, color=plotstyle.TEXT_PRIMARY)
    ax.set(xlabel="Per-session temperature std σ, C", ylabel="Sessions")
    ax.set_title("Real reefer fluctuation (Kaggle cold-chain milk, 92 sessions)")
    ax.legend(loc="upper right")
    plotstyle.save(fig, "m4_sigma_distribution.png")


if __name__ == "__main__":
    main()

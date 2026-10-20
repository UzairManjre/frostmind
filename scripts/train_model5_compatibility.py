"""
Model 5 -- co-shipment compatibility classifier: "can product A and product B travel in the same
reefer compartment?"

Labels (expert, not rule-generated): McGregor 1989, USDA Agricultural Handbook 668 mixed-load
compatibility groups (via FAO), attached by build_product_catalog.py. A produce pair is
compatible (1) when the two products share a McGregor group, unless McGregor explicitly says
"not with ..." for that pair; otherwise 0. Only products McGregor actually grouped get pairs --
non-produce pairs are NOT labelled by rules (that would make the accuracy circular); the
backend handles them with the cited policy vetoes + Model 4's feasibility check instead.

Features: 13 symmetric physical pair features from common.products.pair_feature_frame
(temperature-range overlap, RH overlap, ethylene producer x sensitivity, chilling / freezing
risk, ...). The McGregor group is never a feature.

Evaluation -- why it's product-disjoint: every product appears in ~100 pairs, so a random PAIR
split would let the model see each test product during training and just memorise it. Instead:
  1. split PRODUCTS 70/30 (stratified by McGregor group),
  2. train on pairs whose both products are in the train set,
  3. test on pairs whose both products are in the test set (strict cold start: "a product the
     model has never seen"), and separately on pairs with exactly one unseen product,
  4. pick the decision threshold by Youden's J on out-of-fold predictions from a 5-fold
     product-level CV inside the training products (test set never touched),
  5. repeat for 30 random product partitions; report mean +/- std.
Compared against two rule baselines a domain expert might write by hand.
"""
from __future__ import annotations

import json
import sys
from itertools import combinations
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    matthews_corrcoef,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import KFold, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).parent))

from build_product_catalog import MCGREGOR_EXCEPTIONS  # noqa: E402
from common import plotstyle  # noqa: E402
from common.features import youden_threshold  # noqa: E402
from common.products import PAIR_FEATURE_COLS, group_set, load_catalog, pair_feature_frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "models"
DATA_OUT = ROOT / "data" / "product_catalog"
N_PARTITIONS = 30
TEST_FRAC = 0.30
SEED = 42

MODELS = {
    "logistic_regression": make_pipeline(
        SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=5000)
    ),
    "random_forest": make_pipeline(
        SimpleImputer(strategy="median"),
        RandomForestClassifier(n_estimators=300, min_samples_leaf=3, class_weight="balanced", random_state=SEED, n_jobs=-1),
    ),
    "hist_gradient_boosting": HistGradientBoostingClassifier(
        learning_rate=0.05, max_iter=300, max_depth=4, l2_regularization=1.0, class_weight="balanced", random_state=SEED
    ),
}
PRETTY = {
    "logistic_regression": "Logistic regression",
    "random_forest": "Random forest",
    "hist_gradient_boosting": "Gradient boosting",
    "rule_overlap_no_ethylene": "Rule: ranges overlap & no ethylene clash",
    "rule_topt_within_2c": "Rule: optimal temps within 2 C",
}


def build_pairs(cat: pd.DataFrame) -> pd.DataFrame:
    labelled = cat.index[cat["compat_groups"] != ""].to_numpy()
    exceptions = {frozenset(p) for p in MCGREGOR_EXCEPTIONS}
    groups = {i: group_set(cat.at[i, "compat_groups"]) for i in labelled}
    rows = []
    for i, j in combinations(labelled, 2):
        pid_i, pid_j = cat.at[i, "product_id"], cat.at[j, "product_id"]
        shared = bool(groups[i] & groups[j])
        excepted = frozenset((pid_i, pid_j)) in exceptions
        rows.append({"a": i, "b": j, "label": int(shared and not excepted), "excepted": excepted})
    pairs = pd.DataFrame(rows)
    feats = pair_feature_frame(cat, pairs["a"], pairs["b"])
    return pd.concat([pairs, feats], axis=1)


def rule_scores(x: pd.DataFrame) -> dict[str, np.ndarray]:
    return {
        "rule_overlap_no_ethylene": ((x["temp_overlap_c"] >= 0) & (x["ethylene_risk"] <= 1)).astype(float).to_numpy(),
        "rule_topt_within_2c": (x["topt_diff_c"] <= 2.0).astype(float).to_numpy(),
    }


def metrics(y, proba, threshold) -> dict:
    pred = (proba >= threshold).astype(int)
    both = len(set(y)) > 1
    return {
        "roc_auc": roc_auc_score(y, proba) if both else np.nan,
        "pr_auc": average_precision_score(y, proba) if both else np.nan,
        "accuracy": accuracy_score(y, pred),
        "balanced_accuracy": balanced_accuracy_score(y, pred),
        "precision": precision_score(y, pred, zero_division=0),
        "recall": recall_score(y, pred, zero_division=0),
        "f1": f1_score(y, pred, zero_division=0),
        "mcc": matthews_corrcoef(y, pred) if both else np.nan,
    }


def pairs_within(pairs: pd.DataFrame, products: set) -> pd.Series:
    return pairs["a"].isin(products) & pairs["b"].isin(products)


def oof_threshold(model, pairs: pd.DataFrame, products: np.ndarray, seed: int) -> float:
    """Youden threshold from product-level K-fold OOF predictions inside `products` only."""
    ys, ps = [], []
    for tr_idx, va_idx in KFold(5, shuffle=True, random_state=seed).split(products):
        tr, va = set(products[tr_idx]), set(products[va_idx])
        m_tr, m_va = pairs_within(pairs, tr), pairs_within(pairs, va)
        if pairs.loc[m_va, "label"].nunique() < 2 or pairs.loc[m_tr, "label"].nunique() < 2:
            continue
        m = clone(model).fit(pairs.loc[m_tr, PAIR_FEATURE_COLS], pairs.loc[m_tr, "label"])
        ys.append(pairs.loc[m_va, "label"].to_numpy())
        ps.append(m.predict_proba(pairs.loc[m_va, PAIR_FEATURE_COLS])[:, 1])
    return youden_threshold(np.concatenate(ys), np.concatenate(ps))


def main():
    plotstyle.apply()
    cat = load_catalog()
    pairs = build_pairs(cat)
    products = np.unique(np.concatenate([pairs["a"], pairs["b"]]))
    primary_group = pd.Series({i: min(group_set(cat.at[i, "compat_groups"])) for i in products})
    print(f"Labelled products: {len(products)}   pairs: {len(pairs)}   positive: {pairs['label'].mean() * 100:.1f}%")
    pairs.assign(product_a=cat.loc[pairs["a"], "product_id"].values, product_b=cat.loc[pairs["b"], "product_id"].values).to_csv(
        DATA_OUT / "compatibility_pairs_labelled.csv", index=False
    )

    results = {name: [] for name in list(MODELS) + list(rule_scores(pairs.head(1)))}
    results_one_unseen = {name: [] for name in MODELS}
    pooled = {name: {"y": [], "p": [], "pred": []} for name in MODELS}
    importances = []

    for rep in range(N_PARTITIONS):
        seed = SEED + rep
        strat = primary_group.loc[products].replace({3: 2})  # G3 has only 2 crops -- merge with G2 for stratification only
        tr_p, te_p = train_test_split(products, test_size=TEST_FRAC, random_state=seed, stratify=strat)
        tr_set, te_set = set(tr_p), set(te_p)
        m_tr = pairs_within(pairs, tr_set)
        m_te = pairs_within(pairs, te_set)
        m_one = (pairs["a"].isin(te_set) ^ pairs["b"].isin(te_set))
        x_tr, y_tr = pairs.loc[m_tr, PAIR_FEATURE_COLS], pairs.loc[m_tr, "label"]
        x_te, y_te = pairs.loc[m_te, PAIR_FEATURE_COLS], pairs.loc[m_te, "label"].to_numpy()
        if len(set(y_te)) < 2:
            continue

        for name, model in MODELS.items():
            thr = oof_threshold(model, pairs, np.asarray(tr_p), seed)
            fitted = clone(model).fit(x_tr, y_tr)
            proba = fitted.predict_proba(x_te)[:, 1]
            results[name].append({**metrics(y_te, proba, thr), "threshold": thr, "n_test_pairs": int(m_te.sum())})
            p_one = fitted.predict_proba(pairs.loc[m_one, PAIR_FEATURE_COLS])[:, 1]
            results_one_unseen[name].append(metrics(pairs.loc[m_one, "label"].to_numpy(), p_one, thr))
            pooled[name]["y"].append(y_te)
            pooled[name]["p"].append(proba)
            pooled[name]["pred"].append((proba >= thr).astype(int))
            if name == "hist_gradient_boosting" and rep < 10:
                pi = permutation_importance(fitted, x_te, y_te, scoring="roc_auc", n_repeats=5, random_state=seed)
                importances.append(pi.importances_mean)
        for name, score in rule_scores(pairs.loc[m_te]).items():
            results[name].append(metrics(y_te, score, 0.5))
        print(f"partition {rep + 1:>2}/{N_PARTITIONS}: train pairs {m_tr.sum()}, test pairs {m_te.sum()} "
              f"(HGB AUC {results['hist_gradient_boosting'][-1]['roc_auc']:.3f}, MCC {results['hist_gradient_boosting'][-1]['mcc']:.3f})")

    def summarise(rows):
        df = pd.DataFrame(rows)
        return {c: {"mean": round(float(df[c].mean()), 4), "std": round(float(df[c].std()), 4)} for c in df.columns}

    summary = {name: summarise(rows) for name, rows in results.items()}
    summary_one = {name: summarise(rows) for name, rows in results_one_unseen.items()}
    best = max(MODELS, key=lambda n: (summary[n]["mcc"]["mean"], summary[n]["roc_auc"]["mean"]))
    print(f"\nBest model by mean MCC: {best}")
    for name, s in summary.items():
        print(f"  {PRETTY[name]:<44} AUC {s['roc_auc']['mean']:.3f}+/-{s['roc_auc']['std']:.3f}  "
              f"bal-acc {s['balanced_accuracy']['mean']:.3f}  F1 {s['f1']['mean']:.3f}  MCC {s['mcc']['mean']:.3f}+/-{s['mcc']['std']:.3f}")

    # --- final model: all labelled pairs, threshold from product-level OOF on all products
    final_threshold = oof_threshold(MODELS[best], pairs, products, SEED)
    final = clone(MODELS[best]).fit(pairs[PAIR_FEATURE_COLS], pairs["label"])
    joblib.dump(final, OUT / "model5_compatibility.pkl")

    imp = pd.Series(np.mean(importances, axis=0), index=PAIR_FEATURE_COLS).sort_values(ascending=False)
    y_all = np.concatenate(pooled[best]["y"])
    pred_all = np.concatenate(pooled[best]["pred"])
    cm = confusion_matrix(y_all, pred_all)

    # --- predictions for produce McGregor never grouped (the model's real job)
    unlabelled = cat.index[(cat["safety_class"] == "produce") & (cat["compat_groups"] == "")].to_numpy()
    labelled_names = cat.loc[products, "product_id"].to_numpy()
    examples = {}
    for u in unlabelled:
        f = pair_feature_frame(cat, np.full(len(products), u), products)
        p = final.predict_proba(f)[:, 1]
        top = np.argsort(-p)[:5]
        examples[cat.at[u, "product_id"]] = [(labelled_names[t], round(float(p[t]), 3)) for t in top]

    metrics_out = {
        "model": best,
        "algorithm": type(final[-1] if hasattr(final, "steps") else final).__name__,
        "calibrated_threshold": final_threshold,
        "feature_cols": PAIR_FEATURE_COLS,
        "label_source": "McGregor 1989, USDA Agricultural Handbook 668 compatibility groups (via FAO ae075e16), with McGregor's explicit 'not with' exceptions as negatives",
        "n_labelled_products": int(len(products)),
        "n_pairs": int(len(pairs)),
        "positive_rate": round(float(pairs["label"].mean()), 4),
        "n_partitions": N_PARTITIONS,
        "test_fraction_products": TEST_FRAC,
        "cold_start_test": summary,
        "one_product_unseen_test": summary_one,
        "pooled_confusion_matrix_best": {"tn": int(cm[0, 0]), "fp": int(cm[0, 1]), "fn": int(cm[1, 0]), "tp": int(cm[1, 1])},
        "permutation_importance_roc_auc_hgb": imp.round(4).to_dict(),
        "unlabelled_produce_top_partners": examples,
        "hyperparameters": {name: str(m) for name, m in MODELS.items()},
    }
    (OUT / "model5_compatibility_metrics.json").write_text(json.dumps(metrics_out, indent=2, default=float))
    print(f"Saved model -> {OUT / 'model5_compatibility.pkl'} (threshold {final_threshold:.3f})")

    # ------------------------------------------------------------------ figures
    import matplotlib.pyplot as plt

    order = list(MODELS) + ["rule_overlap_no_ethylene", "rule_topt_within_2c"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.8), sharey=True)
    for ax, metric, title in ((axes[0], "roc_auc", "ROC-AUC"), (axes[1], "mcc", "Matthews correlation (MCC)")):
        means = [summary[n][metric]["mean"] for n in order]
        stds = [summary[n][metric]["std"] for n in order]
        colors = [plotstyle.SERIES[0] if n == best else ("#9ec5f4" if n in MODELS else "#c3c2b7") for n in order]
        y = np.arange(len(order))[::-1]
        ax.barh(y, means, xerr=stds, color=colors, height=0.6, error_kw={"ecolor": plotstyle.TEXT_SECONDARY, "lw": 1})
        for yi, m, sd in zip(y, means, stds):
            ax.text(m + sd + 0.02, yi, f"{m:.2f}", va="center", fontsize=9, color=plotstyle.TEXT_PRIMARY)
        ax.set_yticks(y, [PRETTY[n] for n in order])
        ax.set_xlim(0, 1.15)
        ax.set_title(title)
        ax.grid(axis="y", visible=False)
    fig.suptitle(f"Model 5 on unseen products - mean ± std over {N_PARTITIONS} product-disjoint splits", x=0.01, ha="left", fontsize=12, color=plotstyle.TEXT_PRIMARY)
    fig.tight_layout()
    plotstyle.save(fig, "m5_model_comparison.png")

    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    for k, name in enumerate(MODELS):
        y_, p_ = np.concatenate(pooled[name]["y"]), np.concatenate(pooled[name]["p"])
        fpr, tpr, _ = roc_curve(y_, p_)
        prec, rec, _ = precision_recall_curve(y_, p_)
        axes[0].plot(fpr, tpr, color=plotstyle.SERIES[k], label=f"{PRETTY[name]} (AUC {roc_auc_score(y_, p_):.2f})")
        axes[1].plot(rec, prec, color=plotstyle.SERIES[k], label=f"{PRETTY[name]} (AP {average_precision_score(y_, p_):.2f})")
    axes[0].plot([0, 1], [0, 1], color=plotstyle.GRID, lw=1, ls="--")
    axes[1].axhline(y_all.mean(), color=plotstyle.GRID, lw=1, ls="--")
    axes[0].set(xlabel="False positive rate", ylabel="True positive rate", title="ROC (pooled test pairs)")
    axes[1].set(xlabel="Recall", ylabel="Precision", title="Precision-recall (pooled test pairs)")
    for ax in axes:
        ax.legend(loc="lower right" if ax is axes[0] else "upper right")
    fig.tight_layout()
    plotstyle.save(fig, "m5_roc_pr.png")

    fig, ax = plt.subplots(figsize=(4.2, 3.6))
    ax.imshow(cm, cmap=plt.matplotlib.colors.ListedColormap(plotstyle.SEQ_BLUE[:5]), vmin=0)
    for (i, j), v in np.ndenumerate(cm):
        ax.text(j, i, f"{v}", ha="center", va="center", fontsize=12, color="white" if v > cm.max() * 0.6 else plotstyle.TEXT_PRIMARY)
    ax.set_xticks([0, 1], ["Predicted:\nseparate", "Predicted:\ncompatible"])
    ax.set_yticks([0, 1], ["Expert:\nseparate", "Expert:\ncompatible"])
    ax.grid(False)
    ax.set_title(f"{PRETTY[best]} - pooled confusion matrix")
    plotstyle.save(fig, "m5_confusion_matrix.png")

    fig, ax = plt.subplots(figsize=(7, 4))
    y = np.arange(len(imp))[::-1]
    ax.barh(y, imp.values, color=plotstyle.SERIES[0], height=0.6)
    ax.set_yticks(y, imp.index)
    ax.set_xlabel("Drop in ROC-AUC when feature is shuffled")
    ax.set_title("Model 5 - permutation importance (gradient boosting)")
    ax.grid(axis="y", visible=False)
    plotstyle.save(fig, "m5_feature_importance.png")


if __name__ == "__main__":
    main()

"""Unit tests for scripts/common/products.py -- the physics, features and grouping shared by
Model 4/5 training and the live Load Planner. The setpoint targets below are the sanity checks
from the design review: if a change to the loss function breaks one, the optimizer has started
recommending something a postharvest handbook would reject.
"""
from __future__ import annotations

import sys
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import common.products as P  # noqa: E402
from model3_shelf_life import PRODUCT_LIBRARY  # noqa: E402

CAT = P.load_catalog()


def _load(*pids):
    sub = CAT[CAT["product_id"].isin(pids)]
    assert len(sub) == len(pids), f"missing products: {set(pids) - set(sub['product_id'])}"
    return sub


def _opt(*pids, sigma=0.5):
    sub = _load(*pids)
    return P.optimize_setpoint(sub, np.ones(len(sub)), sigma)


@pytest.mark.parametrize("sigma", [0.25, 0.5, 1.0])
def test_lettuce_stays_just_above_freezing(sigma):
    assert -0.2 <= _opt("lettuce", sigma=sigma)["setpoint_c"] <= 2.0


def test_apples_and_pears_near_zero():
    assert -1.2 <= _opt("apples", "pears")["setpoint_c"] <= 1.2


def test_tropical_fruit_kept_above_chilling_limits():
    assert 12.5 <= _opt("bananas_ripe", "mangos", "avocados_ripe")["setpoint_c"] <= 14.0


@pytest.mark.parametrize("sigma", [0.2, 0.5, 1.2])
def test_vaccines_centred_at_5c_whatever_the_fluctuation(sigma):
    assert _opt("vaccines_refrigerated", sigma=sigma)["setpoint_c"] == pytest.approx(5.0, abs=0.05)


def test_wide_pharma_bands_resolve_to_their_centre():
    assert _opt("vaccines_frozen_e_g_varicella")["setpoint_c"] == pytest.approx(-32.5, abs=0.05)


def test_frozen_and_chilled_together_is_infeasible():
    assert _opt("milk_pasteurized", "frozen_vegetables")["feasible"] is False


def test_tcs_food_limit_is_a_chance_constraint():
    sigma = 0.8
    assert _opt("milk_pasteurized", sigma=sigma)["setpoint_c"] <= 5.0 - P.Z_CHANCE * sigma + 1e-9


def test_q10_from_model3_ea_for_milk():
    lib = PRODUCT_LIBRARY["pasteurized_milk"]
    assert P.q10_from_ea(lib.activation_energy_j_per_mol, lib.reference_temp_c) == pytest.approx(2.67, abs=0.02)


def test_pair_features_are_symmetric():
    ids = CAT.index[:25].to_numpy()
    a, b = zip(*combinations(ids, 2))
    fab = P.pair_feature_frame(CAT, a, b)
    fba = P.pair_feature_frame(CAT, b, a)
    np.testing.assert_allclose(fab.to_numpy(dtype=float), fba.to_numpy(dtype=float), equal_nan=True)


def test_labels_never_leak_into_pair_features():
    """Shuffling the McGregor groups (the Model 5 label) must not change a single feature."""
    ids = CAT.index[:40].to_numpy()
    a, b = zip(*combinations(ids, 2))
    before = P.pair_feature_frame(CAT, a, b)
    shuffled = CAT.copy()
    shuffled["compat_groups"] = np.random.default_rng(0).permutation(shuffled["compat_groups"].to_numpy())
    after = P.pair_feature_frame(shuffled, a, b)
    np.testing.assert_allclose(before.to_numpy(dtype=float), after.to_numpy(dtype=float), equal_nan=True)
    assert "compat_groups" not in P.PAIR_FEATURE_COLS


def test_policy_vetoes():
    by = CAT.set_index("product_id")
    assert P.policy_vetoes(by.loc["vaccines_refrigerated"], by.loc["milk_pasteurized"])
    assert P.policy_vetoes(by.loc["poultry_fresh"], by.loc["lettuce"])
    assert not P.policy_vetoes(by.loc["poultry_fresh"], by.loc["beef_fresh_steaks_and_roasts"])
    assert not P.policy_vetoes(by.loc["apples"], by.loc["pears"])


def test_dsatur_produces_a_valid_colouring():
    rng = np.random.default_rng(1)
    n = 12
    edges = {(i, j) for i in range(n) for j in range(i + 1, n) if rng.random() < 0.35}
    groups = P.dsatur_groups(n, edges)
    assert sorted(v for g in groups for v in g) == list(range(n))
    for g in groups:
        for i, j in combinations(sorted(g), 2):
            assert (i, j) not in edges


def test_student_design_is_shift_invariant():
    sub = _load("apples", "pears")
    shifted = sub.copy()
    for c in ("t_min_c", "t_max_c", "t_opt_c", "freeze_point_c"):
        shifted[c] = shifted[c] + 10
    xf, _ = P.student_matrix(pd.DataFrame([P.load_features(sub, [1, 1], 0.4)]))
    xg, _ = P.student_matrix(pd.DataFrame([P.load_features(shifted, [1, 1], 0.4)]))
    np.testing.assert_allclose(xf.to_numpy(dtype=float), xg.to_numpy(dtype=float), atol=1e-9)

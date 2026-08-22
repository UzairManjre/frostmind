"""app/ml.py's Model 1 seam: confirms (a) the real current state -- no
models/model1_isolation_forest_frostmind.pkl exists, so MODEL1_ACTIVE is False and
score_with_model1() stays the documented no-op -- and (b) the loading/scoring *mechanism* itself
works correctly, using a throwaway synthetic model written only to a pytest tmp_path.

That synthetic model is NOT a real trained Model 1 (no real hardware-logged sessions exist yet --
see app/ml.py's module docstring) -- it exists only to prove the seam activates and scores
correctly the moment a real .pkl is dropped in place, without fabricating or claiming anything
about production training data.
"""
from __future__ import annotations

import json

from app import ml


def test_real_repo_state_has_no_model1_active():
    # This is the actual state of the repo as shipped in this pass -- models/
    # model1_isolation_forest_frostmind.pkl genuinely does not exist (no real hardware sessions
    # have been logged/labeled yet), so the seam must be inert.
    assert ml.MODEL1_ACTIVE is False
    score, is_anomaly = ml.score_with_model1(1.0, 1.0, 1.0, 1.0)
    assert score is None
    assert is_anomaly is None


def test_load_model1_returns_none_when_pkl_missing(tmp_path):
    model, threshold = ml._load_model1(tmp_path / "missing.pkl", tmp_path / "missing_metrics.json")
    assert model is None
    assert threshold is None


def test_load_model1_and_score_when_pkl_present(tmp_path):
    import joblib
    from sklearn.ensemble import IsolationForest

    # Synthetic, tiny IsolationForest fit only to prove the load/score mechanics work -- not a
    # real Model 1 (see module docstring).
    X = [[0.0, 0.1, 0.0, 0.0]] * 20 + [[10.0, 5.0, 8.0, 5.0]] * 2
    clf = IsolationForest(random_state=0, contamination=0.1).fit(X)

    pkl_path = tmp_path / "model1_isolation_forest_frostmind.pkl"
    metrics_path = tmp_path / "model1_isolation_forest_frostmind_metrics.json"
    joblib.dump(clf, pkl_path)
    metrics_path.write_text(json.dumps({"calibrated_threshold": 0.0}))

    model, threshold = ml._load_model1(pkl_path, metrics_path)
    assert model is not None
    assert threshold == 0.0

    score_normal, _ = ml._score(model, threshold, 0.0, 0.1, 0.0, 0.0)
    score_outlier, flagged_outlier = ml._score(model, threshold, 10.0, 5.0, 8.0, 5.0)
    assert isinstance(score_normal, float)
    assert isinstance(flagged_outlier, bool)
    # The clear outlier (matches the injected outlier cluster) should score more anomalous than
    # the well-represented normal point.
    assert score_outlier > score_normal

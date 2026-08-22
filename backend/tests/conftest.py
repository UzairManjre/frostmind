"""Pytest fixtures shared by backend/tests/*.

Points FROSTMIND_DATABASE_URL at a throwaway temp-file SQLite DB *before* app.config/app.database
are ever imported, so nothing here ever touches the real dev DB (backend/frostmind.db). The env
var must be set at conftest.py's module level (which pytest always imports before collecting any
test module in this directory) -- setting it inside a fixture would be too late, since app.main
(and therefore app.database's `engine = create_engine(DATABASE_URL)`) gets imported the first
time any test module does `from app.main import app`.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

_tmp_db_fd, _TMP_DB_PATH = tempfile.mkstemp(suffix=".db", prefix="frostmind_test_")
os.close(_tmp_db_fd)
os.environ["FROSTMIND_DATABASE_URL"] = f"sqlite:///{_TMP_DB_PATH}"
os.environ.setdefault("FROSTMIND_ADMIN_EMAIL", "test-admin@frostmind.local")
os.environ.setdefault("FROSTMIND_ADMIN_PASSWORD", "test-admin-password")
os.environ.setdefault("FROSTMIND_JWT_SECRET", "test-secret-not-for-prod-0123456789abcdef")

from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def _no_real_ollama_calls():
    """Every /ingest call that creates an Alert enqueues a background LLM-reasoning call
    (app/llm_orchestrator.py) -- without this, every test file's alert-creating tests would
    each make a REAL call to whatever Ollama instance happens to be running locally, which is
    exactly what the LLM plan's own §7 says not to depend on in tests. Default: fail fast
    (ConnectError) so background tasks hit the documented "LLM unreachable" fallback path
    harmlessly and quickly in every test that doesn't care about LLM behavior specifically.
    tests/test_llm_orchestrator.py's own `with _mock_ollama_client(...):` blocks correctly
    override this default for the duration of that `with`, since mock.patch context managers
    nest -- this fixture's patch is just the outer, default layer.
    """
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(side_effect=httpx.ConnectError("no Ollama in tests by default"))
    with patch("app.llm_orchestrator.httpx.AsyncClient", return_value=mock_client):
        yield


@pytest.fixture()
def client():
    """Fresh tables (and a freshly re-seeded default admin) for every test -- cheap at this DB
    size and means tests never see leftover state from a previous test.
    """
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session", autouse=True)
def _cleanup_tmp_db():
    yield
    engine.dispose()
    try:
        os.remove(_TMP_DB_PATH)
    except OSError:
        pass

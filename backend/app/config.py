"""
FROSTMIND backend configuration.

Deviation from the Phase 2 plan's stack table (documented in backend/README.md too):
this uses SQLite via SQLAlchemy instead of a live Postgres server, because no Postgres
instance is available in this environment. All models/queries go through the SQLAlchemy
ORM (no raw/SQLite-specific SQL), so switching DATABASE_URL to a Postgres DSN later is a
one-line change -- nothing else in the codebase needs to change.
"""
from __future__ import annotations

import os
from pathlib import Path

# backend/app/config.py -> parents[2] is the project root ("AIOT project")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
MODELS_DIR = PROJECT_ROOT / "models"

DATABASE_URL = os.environ.get("FROSTMIND_DATABASE_URL", f"sqlite:///{BACKEND_ROOT / 'frostmind.db'}")

# Model 1 (anomaly detector) status -- see app/ml.py's module docstring and backend/README.md's
# "Model 1 status" section for the full reasoning. Short version: none of the pre-trained
# models/model1_*.pkl files are safe to score live /ingest telemetry with -- the shipment
# models use session-aggregate features that don't exist live, and the rolling-window models
# (milk/NAB) are calibrated to a different temperature domain than FROSTMIND's 6 categories, so
# they'd misfire constantly rather than degrade gracefully. Nothing is loaded/scored today;
# app/ml.py:score_with_model1() is a documented no-op seam. These constants describe the
# FUTURE pkl (scripts/train_model1_frostmind.py's output) the seam is written against, once
# real hardware logs exist to train it -- not something currently loaded.
MODEL1_NAME = os.environ.get("FROSTMIND_MODEL1_NAME", "model1_isolation_forest_frostmind")
MODEL1_PKL_PATH = MODELS_DIR / f"{MODEL1_NAME}.pkl"
MODEL1_METRICS_PATH = MODELS_DIR / f"{MODEL1_NAME}_metrics.json"
MODEL1_ROLLING_WINDOW = 10  # matches WINDOW in scripts/train_model1_frostmind.py

# JWT auth (minimal single-admin-role auth per Phase 2 plan §2.3/§7)
JWT_SECRET = os.environ.get("FROSTMIND_JWT_SECRET", "frostmind-dev-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = int(os.environ.get("FROSTMIND_JWT_EXPIRE_MINUTES", "480"))

# Default admin seeded on first startup if the users table is empty.
DEFAULT_ADMIN_EMAIL = os.environ.get("FROSTMIND_ADMIN_EMAIL", "admin@frostmind.local")
DEFAULT_ADMIN_PASSWORD = os.environ.get("FROSTMIND_ADMIN_PASSWORD", "frostmind-admin")

# Alerting thresholds
SHELF_LIFE_WARNING_FRACTION = 0.80
SHELF_LIFE_CRITICAL_FRACTION = 1.00
DOOR_OPEN_ALERT_SECONDS = 120
DOOR_ALERT_COOLDOWN_SECONDS = 600
# Cooldown between Alert rows created from the device's own on-device threshold-rule flag
# (the `alert` boolean in each BLE reading) -- without this, a sustained excursion that keeps
# alert=true for many consecutive ~2s readings would create one Alert per reading.
DEVICE_ALERT_COOLDOWN_SECONDS = 60

# Whether door:true in the ingest payload means "door open". The BLE/ingest contract only
# specifies a boolean named "door" with no documented polarity, and the firmware is being built
# by a separate agent with no shared channel to confirm the sign against. This is the single
# place to flip it if the real firmware turns out to send the opposite convention.
DOOR_TRUE_MEANS_OPEN = True

CORS_ORIGINS = os.environ.get("FROSTMIND_CORS_ORIGINS", "*").split(",")

# LLM orchestration (app/llm_orchestrator.py) -- local Ollama, no cloud API, no new hardware.
# Model chosen from what's already pulled on this machine (`ollama list`): a QAT-quantized
# instruction-tuned Gemma, which the "LLM Orchestration Plan" doc's own quantization guidance
# favors over a generic post-training quant for reliable structured JSON output.
OLLAMA_URL = os.environ.get("FROSTMIND_OLLAMA_URL", "http://localhost:11434/api/chat")
OLLAMA_MODEL = os.environ.get("FROSTMIND_OLLAMA_MODEL", "hf.co/unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL")
# 45s, not the 30s a generic guideline suggested -- measured a real cold-start (Ollama had
# unloaded the model after idling) at ~25s (17s model load + 8s inference) on this machine.
# 30s left almost no margin; a background task has no user waiting on it, so there's no cost to
# giving it room instead of spuriously falling back on every first call after an idle period.
OLLAMA_TIMEOUT_SECONDS = float(os.environ.get("FROSTMIND_OLLAMA_TIMEOUT_SECONDS", "45"))

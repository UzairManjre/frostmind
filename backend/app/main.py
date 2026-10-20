from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import CORS_ORIGINS, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD
from app.database import Base, SessionLocal, engine, ensure_columns
from app.logging_config import configure_logging, get_logger, log_event
from app.load_planner import MODEL4_ACTIVE, MODEL5_ACTIVE
from app.ml import MODEL1_ACTIVE, PRODUCT_LIBRARY
from app.models import User, UserRole
from app.llm_orchestrator import llm_status
from app.routers import ai, alerts, analytics, auth, devices, ingest, planner, shipments, trucks

configure_logging()
logger = get_logger("frostmind.main")


def seed_default_admin() -> None:
    db = SessionLocal()
    try:
        if db.query(User).count() == 0:
            from app.auth import hash_password

            admin = User(
                email=DEFAULT_ADMIN_EMAIL,
                hashed_password=hash_password(DEFAULT_ADMIN_PASSWORD),
                role=UserRole.admin,
            )
            db.add(admin)
            db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    added = ensure_columns()
    if added:
        log_event(logger, logging.INFO, "db_columns_added", columns=added)
    seed_default_admin()
    # Resolve which local LLM to use in the background (never blocks startup), so /health
    # reports it from the start.
    threading.Thread(target=llm_status, kwargs={"live": True}, daemon=True).start()
    yield


app = FastAPI(title="FROSTMIND Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(devices.router)
app.include_router(trucks.router)
app.include_router(shipments.router)
app.include_router(alerts.router)
app.include_router(ingest.router)
app.include_router(analytics.router)
app.include_router(planner.router)
app.include_router(ai.router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Catch-all for anything that isn't an HTTPException (those already get FastAPI's normal
    4xx handling and never reach here) -- logs the failure with request context before returning
    a generic 500, per Prototype-to-Production plan §3's structured-logging requirement.
    """
    log_event(
        logger,
        logging.ERROR,
        "unhandled_request_error",
        path=request.url.path,
        method=request.method,
        error=str(exc),
        error_type=type(exc).__name__,
    )
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/health")
def health():
    return {
        "status": "ok",
        # See app/ml.py's module docstring / backend/README.md "Model 1 status": honestly
        # reflects whether models/model1_isolation_forest_frostmind.pkl was actually found and
        # loaded at startup -- never claims "active" when it isn't.
        "model1_status": (
            "active (scoring live /ingest readings)"
            if MODEL1_ACTIVE
            else "not-yet-wired (device threshold rule is the live anomaly signal)"
        ),
        # Load Planner (app/load_planner.py): both degrade to physics/rules when the pkl is absent.
        "model4_status": (
            "active (ML setpoint, guarded by physics optimizer)" if MODEL4_ACTIVE else "physics-only (models/model4_mixed_setpoint.pkl not found)"
        ),
        "model5_status": (
            "active (ML compatibility + policy vetoes)" if MODEL5_ACTIVE else "rule-only (models/model5_compatibility.pkl not found)"
        ),
        # Last model the LLM layer resolved (cheap, no network call here); GET /ai/status checks live.
        "llm_status": llm_status(live=False),
    }


@app.get("/categories")
def list_categories():
    """The 6 product categories (Phase2 plan §1), for the setup wizard's category dropdown."""
    return [
        {
            "key": key,
            "name": product.name,
            "reference_temp_c": product.reference_temp_c,
            "shelf_life_at_ref_hours": product.shelf_life_at_ref_hours,
        }
        for key, product in PRODUCT_LIBRARY.items()
    ]

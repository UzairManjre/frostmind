"""Structured logging on unhandled request errors (Prototype-to-Production plan §3): a genuine
unhandled exception must be caught by app/main.py's catch-all handler, logged as a structured
JSON event, and turned into a clean 500 -- not an opaque stack trace or a broken response.
"""
from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app.main import app
from helpers import admin_headers


def test_unhandled_exception_returns_500_and_logs_structured_event(client, monkeypatch, caplog):
    # Get a valid token *before* breaking the DB layer -- login itself needs a working query.
    headers = admin_headers(client)

    from sqlalchemy.orm import Session

    def _boom_query(self, *args, **kwargs):
        raise RuntimeError("synthetic failure for logging test")

    monkeypatch.setattr(Session, "query", _boom_query)

    # The default TestClient re-raises unhandled exceptions into the test process for debugging
    # convenience, even when the app's own exception handler already built a response -- use
    # raise_server_exceptions=False here so we can assert on the handler's actual HTTP response.
    lenient_client = TestClient(app, raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="frostmind.main"):
        resp = lenient_client.get("/shipments", headers=headers)

    assert resp.status_code == 500
    assert resp.json() == {"detail": "Internal server error"}

    matching = [r for r in caplog.records if r.getMessage() == "unhandled_request_error"]
    assert matching, f"expected an 'unhandled_request_error' log record, got: {[r.getMessage() for r in caplog.records]}"
    record = matching[0]
    assert getattr(record, "context", {}).get("path") == "/shipments"
    assert getattr(record, "context", {}).get("error_type") == "RuntimeError"

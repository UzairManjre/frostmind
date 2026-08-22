"""Structured (JSON) logging -- stdlib `logging` only, no new dependency.

Configured once at app startup (see app/main.py's lifespan). Emits one JSON object per line to
stdout, so it's grep/jq-able and ready to forward to any log aggregator without a code change.

Per the Prototype-to-Production plan §3 ("structured logging... enough to actually debug a
production issue from logs, not exhaustive"), this is wired into three places:
  - app/main.py: a catch-all handler for unhandled request errors (500s).
  - app/routers/ingest.py: every Alert row created (anomaly/model1/threshold-override/door/
    shelf-life), plus device-auth rejections.
  - app/routers/devices.py: pairing state transitions.

Use `log_event(logger, level, "short_event_name", **context)` rather than raw `logger.info(...)`
so every line gets the same shape: {ts, level, logger, message, ...context}.
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

_CONFIGURED = False


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        context = getattr(record, "context", None)
        if context:
            payload.update(context)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    """Idempotent -- safe to call from main.py's lifespan and from tests without duplicating
    handlers (which would otherwise print every log line N times).
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_event(logger: logging.Logger, level: int, message: str, **context) -> None:
    """Structured log line: message is a short stable event name (e.g. "alert_created"),
    context fields (shipment_id=..., alert_type=..., ...) land at the top level of the emitted
    JSON object.
    """
    logger.log(level, message, extra={"context": context})

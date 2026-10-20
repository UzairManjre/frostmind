from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import DATABASE_URL

# check_same_thread only matters for SQLite; harmless / ignored for other backends but we only
# pass it when actually on SQLite so DATABASE_URL can be swapped for Postgres without edits.
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_columns() -> list[str]:
    """Tiny additive migration for existing SQLite/Postgres databases: create_all() makes missing
    TABLES but never adds new COLUMNS to an existing table, so an existing frostmind.db would
    crash on the first query that touches a newly added field. This adds any model column that's
    missing from the live table (all such columns are nullable, so existing rows stay valid).
    Never drops or alters anything. Returns the columns it added."""
    added = []
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing or not col.nullable:
                    continue
                coltype = col.type.compile(dialect=engine.dialect)
                conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{col.name}" {coltype}'))
                added.append(f"{table.name}.{col.name}")
    return added

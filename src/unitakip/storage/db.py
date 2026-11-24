"""SQLite deposu (WAL). Tek süreç, düşük yazma hacmi, kolay yedek."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

from ..models import Item, canonical_json, iso, parse_iso, utcnow

SCHEMA_VERSION = 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS platform_state(
  platform TEXT PRIMARY KEY,
  auth_status TEXT NOT NULL DEFAULT 'unknown',
  baseline_done INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_success_at TEXT,
  next_run_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  reauth_notified_at TEXT,
  unreachable_notified_at TEXT,
  last_keepalive_at TEXT
);
CREATE TABLE IF NOT EXISTS scopes(
  platform TEXT NOT NULL,
  scope TEXT NOT NULL,
  first_complete_at TEXT NOT NULL,
  last_complete_at TEXT NOT NULL,
  PRIMARY KEY(platform, scope)
);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  course_id TEXT,
  course_name TEXT,
  title TEXT NOT NULL,
  url TEXT,
  due_at TEXT,
  version TEXT,
  content_hash TEXT NOT NULL,
  data TEXT NOT NULL,
  text TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_items_scope ON items(platform, scope);
CREATE TABLE IF NOT EXISTS changes(
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  platform TEXT NOT NULL,
  change_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  detected_at TEXT NOT NULL,
  summary TEXT,
  ai_json TEXT,
  silent INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  notify_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_pending ON changes(notified_at, silent);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  item_external_id TEXT,
  url TEXT,
  filename TEXT,
  sha256 TEXT,
  size INTEGER,
  mime TEXT,
  path TEXT,
  status TEXT NOT NULL,
  error TEXT,
  downloaded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_files_item ON files(platform, item_external_id);
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  items_seen INTEGER,
  changes INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS ai_cache(
  cache_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage(
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  month TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_files(
  change_id INTEGER NOT NULL REFERENCES changes(id),
  source_key TEXT NOT NULL,
  newly_downloaded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(change_id, source_key)
);
CREATE TABLE IF NOT EXISTS system_notices(
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
"""


@dataclass(slots=True)
class PlatformState:
    platform: str
    auth_status: str
    baseline_done: bool
    last_run_at: datetime | None
    last_success_at: datetime | None
    next_run_at: datetime | None
    consecutive_failures: int
    last_error: str | None
    reauth_notified_at: datetime | None
    unreachable_notified_at: datetime | None
    last_keepalive_at: datetime | None


_STATE_DT = {
    "last_run_at", "last_success_at", "next_run_at", "reauth_notified_at",
    "unreachable_notified_at", "last_keepalive_at",
}


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        if self.path != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self._migrate()

    def close(self) -> None:
        self.conn.close()

    def _migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            self.conn.executescript(_SCHEMA)
        if version < 2:
            # v2: şüpheli kapsam düşüşü sayacı + indirme deneme sayısı
            self.conn.execute("ALTER TABLE scopes ADD COLUMN suspect_runs INTEGER NOT NULL DEFAULT 0")
            self.conn.execute("ALTER TABLE files ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS scope_failures(platform TEXT NOT NULL, scope TEXT NOT NULL,"
                " consecutive INTEGER NOT NULL DEFAULT 0, first_failed_at TEXT, last_error TEXT,"
                " PRIMARY KEY(platform, scope))")
        if version < SCHEMA_VERSION:
            self.conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield self.conn
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        else:
            self.conn.execute("COMMIT")

    # ------------------------------------------------------------------ durum
    def get_state(self, platform: str) -> PlatformState:
        self.conn.execute("INSERT OR IGNORE INTO platform_state(platform) VALUES (?)", (platform,))
        row = self.conn.execute("SELECT * FROM platform_state WHERE platform=?", (platform,)).fetchone()
        values = dict(row)
        for key in _STATE_DT:
            values[key] = parse_iso(values[key])
        values["baseline_done"] = bool(values["baseline_done"])
        return PlatformState(**values)

    def update_state(self, platform: str, **fields: Any) -> None:
        if not fields:
            return
        self.get_state(platform)
        cols, vals = [], []
        for key, value in fields.items():
            if key in _STATE_DT and isinstance(value, datetime):
                value = iso(value)
            elif isinstance(value, bool):
                value = int(value)
            cols.append(f"{key}=?")
            vals.append(value)
        vals.append(platform)
        self.conn.execute(f"UPDATE platform_state SET {', '.join(cols)} WHERE platform=?", vals)

    # ---------------------------------------------------------------- kapsam
    def known_scopes(self, platform: str) -> set[str]:
        rows = self.conn.execute("SELECT scope FROM scopes WHERE platform=?", (platform,))
        return {r[0] for r in rows}

    def mark_scopes_complete(self, platform: str, scopes: set[str], now: datetime) -> None:
        ts = iso(now)
        self.conn.executemany(
            "INSERT INTO scopes(platform, scope, first_complete_at, last_complete_at) VALUES (?,?,?,?) "
            "ON CONFLICT(platform, scope) DO UPDATE SET last_complete_at=excluded.last_complete_at",
            [(platform, s, ts, ts) for s in scopes],
        )

    def count_active_in_scope(self, platform: str, scope: str) -> int:
        return int(self.conn.execute(
            "SELECT COUNT(*) FROM items WHERE platform=? AND scope=? AND removed_at IS NULL", (platform, scope)
        ).fetchone()[0])

    def bump_scope_suspect(self, platform: str, scope: str) -> int:
        self.conn.execute("UPDATE scopes SET suspect_runs=suspect_runs+1 WHERE platform=? AND scope=?",
                          (platform, scope))
        row = self.conn.execute("SELECT suspect_runs FROM scopes WHERE platform=? AND scope=?",
                                (platform, scope)).fetchone()
        return int(row[0]) if row else 0

    def reset_scope_suspect(self, platform: str, scope: str) -> None:
        self.conn.execute("UPDATE scopes SET suspect_runs=0 WHERE platform=? AND scope=? AND suspect_runs>0",
                          (platform, scope))

    def record_scope_health(self, platform: str, failed: dict[str, str], ok: set[str], now: datetime) -> None:
        for scope, err in failed.items():
            self.conn.execute(
                "INSERT INTO scope_failures(platform, scope, consecutive, first_failed_at, last_error)"
                " VALUES (?,?,1,?,?) ON CONFLICT(platform, scope) DO UPDATE SET"
                " consecutive=consecutive+1, last_error=excluded.last_error",
                (platform, scope, iso(now), err[:300]))
        self.conn.executemany("DELETE FROM scope_failures WHERE platform=? AND scope=?",
                              [(platform, s) for s in ok])

    def persistent_scope_failures(self, platform: str, min_runs: int) -> list[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT * FROM scope_failures WHERE platform=? AND consecutive >= ? ORDER BY scope", (platform, min_runs)))

    def backup_to(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        dst = sqlite3.connect(tmp)
        try:
            self.conn.backup(dst)
        finally:
            dst.close()
        tmp.replace(path)

    def prune(self, now: datetime, runs_days: int = 90, cache_days: int = 180) -> None:
        self.conn.execute("DELETE FROM runs WHERE started_at < ?", (iso(now - timedelta(days=runs_days)),))
        self.conn.execute("DELETE FROM ai_cache WHERE created_at < ?", (iso(now - timedelta(days=cache_days)),))

    def stats(self) -> dict[str, Any]:
        def one(sql: str, *args: Any) -> Any:
            return self.conn.execute(sql, args).fetchone()[0]

        return {
            "items": one("SELECT COUNT(*) FROM items WHERE removed_at IS NULL"),
            "files": one("SELECT COUNT(*) FROM files WHERE status='ok'"),
            "files_bytes": one("SELECT COALESCE(SUM(size),0) FROM files WHERE status='ok'"),
            "pending": one("SELECT COUNT(*) FROM changes WHERE notified_at IS NULL AND silent=0"),
            "notified_7d": one("SELECT COUNT(*) FROM changes WHERE silent=0 AND notified_at >= ?",
                               iso(utcnow() - timedelta(days=7))),
        }

    # ----------------------------------------------------------------- öğeler
    def get_item(self, platform: str, external_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM items WHERE platform=? AND external_id=?", (platform, external_id)
        ).fetchone()

    def get_item_by_id(self, item_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()

    def insert_item(self, item: Item, content_hash: str, now: datetime) -> int:
        ts = iso(now)
        cur = self.conn.execute(
            "INSERT INTO items(platform, external_id, kind, scope, course_id, course_name, title, url,"
            " due_at, version, content_hash, data, text, first_seen_at, last_seen_at, last_changed_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                item.platform, item.external_id, str(item.kind), item.scope, item.course_id,
                item.course_name, item.title, item.url, iso(item.due_at), item.version,
                content_hash, canonical_json(item.data), item.text, ts, ts, ts,
            ),
        )
        return int(cur.lastrowid)

    def update_item(self, item_id: int, item: Item, content_hash: str, now: datetime) -> None:
        ts = iso(now)
        self.conn.execute(
            "UPDATE items SET kind=?, scope=?, course_id=?, course_name=?, title=?, url=?, due_at=?,"
            " version=?, content_hash=?, data=?, text=?, last_seen_at=?, last_changed_at=?, removed_at=NULL"
            " WHERE id=?",
            (
                str(item.kind), item.scope, item.course_id, item.course_name, item.title, item.url,
                iso(item.due_at), item.version, content_hash, canonical_json(item.data), item.text,
                ts, ts, item_id,
            ),
        )

    def touch_items(self, item_ids: list[int], now: datetime) -> None:
        ts = iso(now)
        self.conn.executemany("UPDATE items SET last_seen_at=? WHERE id=?", [(ts, i) for i in item_ids])

    def active_items_in_scope(self, platform: str, scope: str) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT * FROM items WHERE platform=? AND scope=? AND removed_at IS NULL", (platform, scope)
            )
        )

    def mark_removed(self, item_id: int, now: datetime) -> None:
        self.conn.execute("UPDATE items SET removed_at=? WHERE id=?", (iso(now), item_id))

    def count_items(self, platform: str | None = None) -> int:
        if platform:
            q = self.conn.execute(
                "SELECT COUNT(*) FROM items WHERE platform=? AND removed_at IS NULL", (platform,)
            )
        else:
            q = self.conn.execute("SELECT COUNT(*) FROM items WHERE removed_at IS NULL")
        return int(q.fetchone()[0])

    # ------------------------------------------------------------ değişiklik
    def add_change(
        self,
        *,
        item_id: int,
        platform: str,
        change_type: str,
        dedupe_key: str,
        summary: str | None,
        silent: bool,
        now: datetime,
    ) -> int | None:
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO changes(item_id, platform, change_type, dedupe_key, detected_at, summary,"
            " silent, notified_at) VALUES (?,?,?,?,?,?,?,?)",
            (item_id, platform, change_type, dedupe_key, iso(now), summary, int(silent),
             iso(now) if silent else None),
        )
        return int(cur.lastrowid) if cur.rowcount else None

    def pending_changes(self, platform: str | None = None) -> list[sqlite3.Row]:
        """Gönderilmemiş tüm bildirimler. Deneme sayısından bağımsız: hiçbir değişiklik kalıcı olarak düşmez."""
        sql = (
            "SELECT c.*, i.external_id, i.kind, i.scope, i.course_id, i.course_name, i.title, i.url,"
            " i.due_at, i.data, i.text, i.version FROM changes c JOIN items i ON i.id=c.item_id"
            " WHERE c.notified_at IS NULL AND c.silent=0"
        )
        args: list[Any] = []
        if platform:
            sql += " AND c.platform=?"
            args.append(platform)
        sql += " ORDER BY c.id"
        return list(self.conn.execute(sql, args))

    def set_change_ai(self, change_id: int, analysis: dict[str, Any]) -> None:
        self.conn.execute("UPDATE changes SET ai_json=? WHERE id=?", (canonical_json(analysis), change_id))

    def mark_notified(self, change_ids: list[int], now: datetime) -> None:
        self.conn.executemany(
            "UPDATE changes SET notified_at=?, notify_error=NULL WHERE id=?", [(iso(now), i) for i in change_ids]
        )

    def mark_notify_failed(self, change_ids: list[int], error: str) -> None:
        self.conn.executemany(
            "UPDATE changes SET notify_attempts=notify_attempts+1, notify_error=? WHERE id=?",
            [(error[:500], i) for i in change_ids],
        )

    def recent_changes(self, limit: int = 20) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT c.*, i.title, i.kind, i.course_name FROM changes c JOIN items i ON i.id=c.item_id"
                " ORDER BY c.id DESC LIMIT ?",
                (limit,),
            )
        )

    # ---------------------------------------------------------------- dosyalar
    def get_file(self, source_key: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM files WHERE source_key=?", (source_key,)).fetchone()

    def find_file_by_sha(self, sha256: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM files WHERE sha256=? AND status='ok' AND path IS NOT NULL LIMIT 1", (sha256,)
        ).fetchone()

    def files_for_item(self, platform: str, external_id: str) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT * FROM files WHERE platform=? AND item_external_id=? ORDER BY id", (platform, external_id)
            )
        )

    def upsert_file(self, **row: Any) -> None:
        cols = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        updates = ", ".join(f"{k}=excluded.{k}" for k in row if k != "source_key")
        self.conn.execute(
            f"INSERT INTO files({cols}) VALUES ({marks}) ON CONFLICT(source_key) DO UPDATE SET {updates}",
            list(row.values()),
        )

    def files_to_retry(self, platform: str, max_attempts: int, limit: int) -> list[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT * FROM files WHERE platform=? AND status='retry' AND attempts < ? ORDER BY id LIMIT ?",
            (platform, max_attempts, limit)))

    def changes_for_file(self, source_key: str) -> list[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT c.* FROM change_files cf JOIN changes c ON c.id=cf.change_id WHERE cf.source_key=?",
            (source_key,)))

    def link_change_file(self, change_id: int, source_key: str, newly: bool) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO change_files(change_id, source_key, newly_downloaded) VALUES (?,?,?)",
            (change_id, source_key, int(newly)),
        )

    def change_files(self, change_id: int) -> list[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT f.*, cf.newly_downloaded FROM change_files cf JOIN files f ON f.source_key=cf.source_key"
            " WHERE cf.change_id=? ORDER BY f.id", (change_id,)))

    def pending_count(self) -> int:
        return int(self.conn.execute(
            "SELECT COUNT(*) FROM changes WHERE notified_at IS NULL AND silent=0").fetchone()[0])

    # ------------------------------------------------------------- çalıştırma
    def start_run(self, platform: str, now: datetime) -> int:
        cur = self.conn.execute("INSERT INTO runs(platform, started_at) VALUES (?,?)", (platform, iso(now)))
        return int(cur.lastrowid)

    def finish_run(self, run_id: int, *, status: str, items_seen: int = 0, changes: int = 0,
                   error: str | None = None) -> None:
        self.conn.execute(
            "UPDATE runs SET finished_at=?, status=?, items_seen=?, changes=?, error=? WHERE id=?",
            (iso(utcnow()), status, items_seen, changes, (error or "")[:1000] or None, run_id),
        )

    def last_runs(self, limit: int = 10) -> list[sqlite3.Row]:
        return list(self.conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,)))

    # ----------------------------------------------------------------- yapay zekâ
    def ai_cache_get(self, key: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT result FROM ai_cache WHERE cache_key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def ai_cache_put(self, key: str, provider: str, result: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO ai_cache(cache_key, provider, result, created_at) VALUES (?,?,?,?)",
            (key, provider, canonical_json(result), iso(utcnow())),
        )

    def ai_record_usage(self, provider: str, model: str, input_tokens: int, output_tokens: int,
                        cost_usd: float) -> None:
        now = utcnow()
        self.conn.execute(
            "INSERT INTO ai_usage(provider, model, month, input_tokens, output_tokens, cost_usd, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (provider, model, now.strftime("%Y-%m"), input_tokens, output_tokens, cost_usd, iso(now)),
        )

    def ai_month_cost(self, provider: str, month: str | None = None) -> float:
        month = month or utcnow().strftime("%Y-%m")
        row = self.conn.execute(
            "SELECT COALESCE(SUM(cost_usd),0) FROM ai_usage WHERE provider=? AND month=?", (provider, month)
        ).fetchone()
        return float(row[0])

    # ------------------------------------------------------------ sistem notları
    def notice_sent_at(self, key: str) -> datetime | None:
        row = self.conn.execute("SELECT sent_at FROM system_notices WHERE key=?", (key,)).fetchone()
        return parse_iso(row[0]) if row else None

    def mark_notice(self, key: str, now: datetime) -> None:
        self.conn.execute("INSERT OR REPLACE INTO system_notices(key, sent_at) VALUES (?,?)", (key, iso(now)))

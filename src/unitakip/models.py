"""Platformdan bağımsız veri modeli."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


class Kind(StrEnum):
    COURSE = "course"
    SECTION = "section"
    MODULE = "module"
    FILE = "file"
    LINK = "link"
    ANNOUNCEMENT = "announcement"
    FORUM_POST = "forum_post"
    ASSIGNMENT = "assignment"
    QUIZ = "quiz"
    EVENT = "event"
    GRADE = "grade"
    ATTENDANCE = "attendance"
    NOTIFICATION = "notification"
    PAGE = "page"
    TABLE_ROW = "table_row"


KIND_LABELS = {
    Kind.COURSE: "Ders",
    Kind.SECTION: "Bölüm / hafta",
    Kind.MODULE: "Etkinlik / kaynak",
    Kind.FILE: "Dosya",
    Kind.LINK: "Bağlantı",
    Kind.ANNOUNCEMENT: "Duyuru",
    Kind.FORUM_POST: "Forum gönderisi",
    Kind.ASSIGNMENT: "Ödev",
    Kind.QUIZ: "Sınav / quiz",
    Kind.EVENT: "Takvim etkinliği",
    Kind.GRADE: "Not",
    Kind.ATTENDANCE: "Devamsızlık",
    Kind.NOTIFICATION: "Platform bildirimi",
    Kind.PAGE: "Sayfa içeriği",
    Kind.TABLE_ROW: "Tablo kaydı",
}

CHANGE_LABELS = {
    "new": "Yeni",
    "updated": "Güncellendi",
    "removed": "Kaldırıldı",
    "file_ready": "Dosya indirildi",
}

# Harici yapay zekâ servislerine ASLA gönderilmeyecek içerik türleri (gizlilik)
SENSITIVE_KINDS = {Kind.GRADE, Kind.ATTENDANCE}

_TOKEN_PARAMS = {
    "token", "wstoken", "sesskey", "privatetoken", "code", "password", "sifre",
    "access_token", "refresh_token", "id_token", "client_secret", "logintoken", "__requestverificationtoken",
}


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def from_epoch(value: Any) -> datetime | None:
    try:
        ts = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(ts, UTC) if ts > 0 else None


def strip_secrets_from_url(url: str) -> str:
    """URL'den kullanıcı bilgilerini ve oturum parametrelerini çıkar."""
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k.lower() not in _TOKEN_PARAMS]
    fragment = "" if any(k.lower() in _TOKEN_PARAMS for k, _ in parse_qsl(parts.fragment)) else parts.fragment
    return urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[-1], parts.path, urlencode(query), fragment))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


_WS = re.compile(r"[ \t\r\f\v]+")
_NL = re.compile(r"\n{3,}")


def normalize_text(text: str | None) -> str:
    if not text:
        return ""
    text = text.replace("\xa0", " ")
    lines = [_WS.sub(" ", ln).strip() for ln in text.splitlines()]
    return _NL.sub("\n\n", "\n".join(lines)).strip()


@dataclass(slots=True)
class RemoteFile:
    url: str
    filename: str
    size: int | None = None
    timemodified: int | None = None
    mimetype: str | None = None

    def source_key(self, platform: str) -> str:
        base = f"{platform}|{strip_secrets_from_url(self.url)}|{self.timemodified or ''}|{self.size or ''}"
        return sha256_text(base)

    @property
    def extension(self) -> str:
        name = self.filename.lower()
        return name.rsplit(".", 1)[-1] if "." in name else ""


@dataclass(slots=True)
class Item:
    platform: str
    external_id: str
    kind: Kind
    title: str
    scope: str
    course_id: str | None = None
    course_name: str | None = None
    url: str | None = None
    due_at: datetime | None = None
    version: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    text: str | None = None  # AI ve e-posta için düz metin (özete dahil edilmez)
    files: list[RemoteFile] = field(default_factory=list)

    def hash_payload(self) -> dict[str, Any]:
        return {
            "kind": str(self.kind),
            "title": self.title,
            "course": self.course_name,
            "url": strip_secrets_from_url(self.url) if self.url else None,
            "due_at": iso(self.due_at),
            "version": self.version,
            "data": self.data,
        }

    def content_hash(self) -> str:
        return sha256_text(canonical_json(self.hash_payload()))


@dataclass(slots=True)
class Snapshot:
    """Bir platformun tek seferlik görüntüsü.

    complete_scopes: eksiksiz çekilen kapsamlar. Burada görünmeyen eski öğeler "kaldırıldı" sayılır.
    partial_scopes: başarılı ama sayfalı/zaman pencereli kapsamlar (ör. son 15 duyuru, 90 günlük
                    takvim). Bunlarda kaldırma işaretlenmez.
    """

    platform: str
    items: list[Item] = field(default_factory=list)
    complete_scopes: set[str] = field(default_factory=set)
    partial_scopes: set[str] = field(default_factory=set)
    failed_scopes: dict[str, str] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)

    def add(self, item: Item) -> None:
        self.items.append(item)

    def ok(self, scope: str, *, removable: bool = True) -> None:
        (self.complete_scopes if removable else self.partial_scopes).add(scope)

    def fail(self, scope: str, error: str) -> None:
        self.failed_scopes[scope] = error
        self.complete_scopes.discard(scope)
        self.partial_scopes.discard(scope)

    @property
    def successful_scopes(self) -> set[str]:
        return self.complete_scopes | self.partial_scopes

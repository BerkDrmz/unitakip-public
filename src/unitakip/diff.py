"""Değişiklik algılama: Snapshot → items/changes tabloları.

Kurallar:
- Kimlik: (platform, external_id). Sürüm: normalize edilmiş verinin SHA-256 özeti.
- İlk tarama (platform baseline) ve ilk kez eksiksiz görülen kapsam (ör. yeni bir dersin
  içerikleri) "sessiz" kaydedilir: toplu e-posta üretmez.
- "Kaldırıldı" yalnızca bu çalıştırmada EKSİKSİZ çekilen kapsamlar için işaretlenir.
- dedupe_key UNIQUE: aynı değişiklik ikinci kez bildirilmez.
"""

from __future__ import annotations

import difflib
import json
import logging
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from .models import Item, Kind, Snapshot, iso, parse_iso
from .storage.db import Database

log = logging.getLogger(__name__)

FIELD_LABELS = {
    "title": "Başlık",
    "due_at": "Teslim/son tarih",
    "url": "Bağlantı",
    "version": "Sürüm",
    "course": "Ders",
    "name": "Ad",
    "summary": "Açıklama",
    "intro": "Açıklama",
    "message": "Mesaj",
    "subject": "Konu",
    "duedate": "Teslim tarihi",
    "cutoffdate": "Son kabul tarihi",
    "allowsubmissionsfromdate": "Teslim başlangıcı",
    "timeopen": "Açılış",
    "timeclose": "Kapanış",
    "timelimit": "Süre sınırı",
    "timestart": "Başlangıç",
    "timeduration": "Süre",
    "filesize": "Dosya boyutu",
    "timemodified": "Değiştirilme zamanı",
    "visible": "Görünür",
    "uservisible": "Erişilebilir",
    "grade": "Not",
    "gradeformatted": "Not",
    "percentageformatted": "Yüzde",
    "feedback": "Geri bildirim",
    "rangeformatted": "Not aralığı",
    "attachments": "Ekler",
    "files": "Dosyalar",
    "cells": "Değerler",
    "text": "Metin",
    "availability": "Erişim koşulu",
}

_LONG = 120
DISPLAY_TZ = ZoneInfo("Europe/Istanbul")
# Bu veri alanlarından biri değiştiyse genel "Teslim/son tarih" satırı tekrar yazılmaz
_DUE_KEYS = {"duedate", "timeclose", "timeopen", "timestart", "cutoffdate"}


# Toplu düşüş koruması: daha önce en az GUARD_MIN_PREVIOUS öğesi olan bir kapsam birden %30'un altına
# düşerse (bakım sayfası, boş yanıt, yarım yüklenen sayfa) o kapsam bu çalıştırmada işlenmez. Durum
# GUARD_CONFIRM_RUNS çalıştırma (~3 saat) sürerse gerçek kabul edilir.
GUARD_MIN_PREVIOUS = 3
GUARD_DROP_RATIO = 0.3
GUARD_CONFIRM_RUNS = 3


@dataclass(slots=True)
class DetectedChange:
    change_id: int
    item_id: int
    item: Item
    change_type: str
    summary: str | None
    silent: bool


def _fmt(value: object) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, bool):
        return "evet" if value else "hayır"
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)[:_LONG]
    return str(value)


def _text_delta(old: str, new: str) -> str:
    old_lines = [ln for ln in old.splitlines() if ln.strip()]
    new_lines = [ln for ln in new.splitlines() if ln.strip()]
    added = [ln[2:] for ln in difflib.ndiff(old_lines, new_lines) if ln.startswith("+ ")]
    removed = [ln[2:] for ln in difflib.ndiff(old_lines, new_lines) if ln.startswith("- ")]
    parts = []
    if added:
        parts.append("eklenen: " + " | ".join(added)[:300])
    if removed:
        parts.append("çıkarılan: " + " | ".join(removed)[:200])
    return "; ".join(parts) or "metin değişti"


def describe_diff(old_row, new_item: Item, tz: ZoneInfo = DISPLAY_TZ) -> str:
    """İnsan okunur alan farkı: 'Teslim tarihi: 12.11 → 15.11; Final: — → 55' (yerel saatle)."""
    lines: list[str] = []
    try:
        old_data = json.loads(old_row["data"] or "{}")
    except json.JSONDecodeError:
        old_data = {}
    new_data = new_item.data
    due_in_data = any(old_data.get(k) != new_data.get(k) for k in _DUE_KEYS)

    old_simple = {"title": old_row["title"], "due_at": old_row["due_at"], "url": old_row["url"],
                  "course": old_row["course_name"]}
    new_simple = {"title": new_item.title, "due_at": iso(new_item.due_at), "url": new_item.url,
                  "course": new_item.course_name}
    for key, old_val in old_simple.items():
        new_val = new_simple[key]
        if (old_val or None) == (new_val or None) or (key == "due_at" and due_in_data):
            continue
        if key == "due_at":
            old_val, new_val = _fmt_dt(old_val, tz), _fmt_dt(new_val, tz)
        lines.append(f"{FIELD_LABELS[key]}: {_fmt(old_val)} → {_fmt(new_val)}")

    for key in sorted(set(old_data) | set(new_data)):
        a, b = old_data.get(key), new_data.get(key)
        if a == b:
            continue
        label = FIELD_LABELS.get(key, key)
        if key == "cells" and isinstance(a, dict) and isinstance(b, dict):
            # tablo satırı: yalnızca değişen hücreler ("Final: - → 55")
            for col in [c for c in b if a.get(c) != b.get(c)] + [c for c in a if c not in b]:
                lines.append(f"{col}: {_fmt(a.get(col))} → {_fmt(b.get(col))}")
        elif isinstance(a, str) and isinstance(b, str) and (len(a) > _LONG or len(b) > _LONG or "\n" in a + b):
            lines.append(f"{label}: {_text_delta(a, b)}")
        elif key.startswith("time") or key.endswith("date"):
            lines.append(f"{label}: {_fmt_epoch(a, tz)} → {_fmt_epoch(b, tz)}")
        else:
            lines.append(f"{label}: {_fmt(a)} → {_fmt(b)}")
    return "; ".join(lines) if lines else "içerik güncellendi"


def _fmt_dt(value: str | None, tz: ZoneInfo = DISPLAY_TZ) -> str | None:
    dt = parse_iso(value) if value else None
    return dt.astimezone(tz).strftime("%d.%m.%Y %H:%M") if dt else None


def _fmt_epoch(value: object, tz: ZoneInfo = DISPLAY_TZ) -> str:
    try:
        ts = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return _fmt(value)
    if ts <= 0:
        return "—"
    return datetime.fromtimestamp(ts, UTC).astimezone(tz).strftime("%d.%m.%Y %H:%M")


def _dedupe(platform: str, external_id: str, change_type: str, content_hash: str, now: datetime | None = None) -> str:
    # "updated": aynı gün içindeki ileri-geri titreşim bastırılır, sonraki günlerde aynı değer yine bildirilir
    day = f"|{now.date().isoformat()}" if now is not None and change_type == "updated" else ""
    return f"{platform}|{external_id}|{change_type}|{content_hash}{day}"


def _guard_scopes(db: Database, snap: Snapshot, known_scopes: set[str]) -> set[str]:
    counts = Counter(i.scope for i in snap.items)
    held: set[str] = set()
    for scope in sorted(snap.successful_scopes & known_scopes):
        previous = db.count_active_in_scope(snap.platform, scope)
        current = counts.get(scope, 0)
        if previous >= GUARD_MIN_PREVIOUS and current < previous * GUARD_DROP_RATIO:
            strikes = db.bump_scope_suspect(snap.platform, scope)
            if strikes < GUARD_CONFIRM_RUNS:
                held.add(scope)
                snap.failed_scopes[scope] = f"şüpheli düşüş: {previous} → {current} öğe ({strikes}/{GUARD_CONFIRM_RUNS})"
                log.warning("%s: %s kapsamı %d → %d öğeye düştü; bakım/boş sayfa olabilir, bu çalıştırmada "
                            "işlenmedi (%d/%d).", snap.platform, scope, previous, current, strikes, GUARD_CONFIRM_RUNS)
                continue
            log.warning("%s: %s kapsamındaki düşüş %d çalıştırmadır sürüyor, gerçek kabul edildi.",
                        snap.platform, scope, strikes)
            snap.meta.setdefault("guard_accepted", []).append(f"{scope}: {previous} → {current} öğe")
        db.reset_scope_suspect(snap.platform, scope)
    return held


def apply_snapshot(
    db: Database,
    snap: Snapshot,
    now: datetime,
    *,
    notify_removed: bool = False,
    notify_new_course: bool = True,
    tz: ZoneInfo | None = None,
) -> list[DetectedChange]:
    tz = tz or DISPLAY_TZ
    platform = snap.platform
    state = db.get_state(platform)
    platform_baseline = not state.baseline_done
    known_scopes = db.known_scopes(platform)
    changes: list[DetectedChange] = []
    seen_ids: set[str] = set()
    touched: list[int] = []

    with db.transaction():
        held = set() if platform_baseline else _guard_scopes(db, snap, known_scopes)
        complete_scopes = snap.complete_scopes - held
        successful_scopes = snap.successful_scopes - held
        for item in snap.items:
            if item.scope in held:
                continue
            if item.external_id in seen_ids:
                log.debug("Yinelenen öğe atlandı: %s", item.external_id)
                continue
            seen_ids.add(item.external_id)
            content_hash = item.content_hash()
            row = db.get_item(platform, item.external_id)
            scope_is_new = item.scope not in known_scopes

            if row is None:
                item_id = db.insert_item(item, content_hash, now)
                silent = platform_baseline or scope_is_new
                if item.kind == Kind.COURSE and not platform_baseline and not notify_new_course:
                    silent = True
                summary = None
                ctype = "new"
            elif row["removed_at"] is not None:
                item_id = int(row["id"])
                db.update_item(item_id, item, content_hash, now)
                ctype, summary, silent = "updated", "yeniden yayında / tekrar erişilebilir", platform_baseline
            elif row["content_hash"] != content_hash:
                item_id = int(row["id"])
                summary = describe_diff(row, item, tz)
                db.update_item(item_id, item, content_hash, now)
                ctype, silent = "updated", platform_baseline
            else:
                touched.append(int(row["id"]))
                continue

            change_id = db.add_change(
                item_id=item_id, platform=platform, change_type=ctype,
                dedupe_key=_dedupe(platform, item.external_id, ctype, content_hash, now),
                summary=summary, silent=silent, now=now,
            )
            if change_id is not None:
                changes.append(DetectedChange(change_id, item_id, item, ctype, summary, silent))

        db.touch_items(touched, now)

        # Kaldırılanlar: yalnızca eksiksiz çekilen VE önceden bilinen kapsamlar
        for scope in complete_scopes & known_scopes:
            for row in db.active_items_in_scope(platform, scope):
                if row["external_id"] in seen_ids:
                    continue
                db.mark_removed(int(row["id"]), now)
                change_id = db.add_change(
                    item_id=int(row["id"]), platform=platform, change_type="removed",
                    dedupe_key=_dedupe(platform, row["external_id"], "removed", row["content_hash"]) + f"|{iso(now)}",
                    summary="platformda artık görünmüyor", silent=platform_baseline or not notify_removed, now=now,
                )
                if change_id is not None:
                    changes.append(
                        DetectedChange(change_id, int(row["id"]), _row_to_item(row), "removed",
                                       "platformda artık görünmüyor", platform_baseline or not notify_removed)
                    )

        db.mark_scopes_complete(platform, successful_scopes, now)
        if platform_baseline:
            db.update_state(platform, baseline_done=True)

    return changes


def _row_to_item(row) -> Item:
    return Item(
        platform=row["platform"], external_id=row["external_id"], kind=Kind(row["kind"]),
        title=row["title"], scope=row["scope"], course_id=row["course_id"], course_name=row["course_name"],
        url=row["url"], due_at=parse_iso(row["due_at"]), version=row["version"],
        data=json.loads(row["data"] or "{}"), text=row["text"],
    )


row_to_item = _row_to_item

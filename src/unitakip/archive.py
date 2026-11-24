"""Dosya arşivi: aynı sürümü yeniden indirmez, içeriği SHA-256 ile tekilleştirir."""

from __future__ import annotations

import logging
import re
import shutil
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .adapters.base import Adapter, AuthExpired, NotAFile
from .http import ResponseTooLarge, TransientError
from .models import Item, RemoteFile, iso, strip_secrets_from_url, utcnow
from .storage.db import Database

log = logging.getLogger(__name__)

_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def safe_name(name: str, max_len: int = 120, max_bytes: int = 180) -> str:
    """Güvenli dosya adı: yol ayırıcı yok, uzunluk hem karakter hem UTF-8 bayt olarak sınırlı
    (ext4/APFS ad sınırı 255 bayt; Türkçe karakterler 2 bayt)."""
    name = unicodedata.normalize("NFC", name or "dosya")
    name = _UNSAFE_CHARS.sub("_", name).strip(" .") or "dosya"
    stem, dot, ext = name.rpartition(".")
    if not dot or len(ext) > 8:
        stem, dot, ext = name, "", ""
    while len(stem + dot + ext) > max_len or len((stem + dot + ext).encode("utf-8")) > max_bytes:
        stem = stem[:-1]
        if not stem:
            break
    return (stem + dot + ext) or "dosya"


MAX_DOWNLOAD_ATTEMPTS = 3
MIN_FREE_BYTES = 500 * 1024 * 1024  # diskte en az 500 MB kalmalı


class DiskFull(RuntimeError):
    """Diskte yeterli yer yok: indirme yapılmadı."""


@dataclass(slots=True)
class ArchivedFile:
    filename: str
    path: Path | None
    size: int | None
    sha256: str | None
    status: str  # ok | skipped | error
    reason: str | None = None
    reused: bool = False


class Archive:
    def __init__(self, db: Database, files_dir: Path):
        self.db = db
        self.files_dir = files_dir
        self.tmp_dir = files_dir / ".tmp"

    def cleanup_tmp(self) -> None:
        """Yarım kalan indirmeleri temizle (yeniden başlatma sonrası)."""
        if self.tmp_dir.is_dir():
            for p in self.tmp_dir.iterdir():
                p.unlink(missing_ok=True)

    def free_bytes(self) -> int:
        self.files_dir.mkdir(parents=True, exist_ok=True)
        return shutil.disk_usage(self.files_dir).free

    def fetch(self, adapter: Adapter, item: Item, rf: RemoteFile) -> ArchivedFile:
        key = rf.source_key(adapter.name)
        existing = self.db.get_file(key)
        if existing is not None and existing["status"] in ("ok", "skipped"):
            return ArchivedFile(rf.filename, Path(existing["path"]) if existing["path"] else None,
                                existing["size"], existing["sha256"], existing["status"], existing["error"], True)
        attempts = int(existing["attempts"]) if existing is not None else 0
        return self._download(adapter, item.external_id, item.course_name, rf, key, attempts)

    def retry_pending(self, adapter: Adapter, limit: int = 10) -> list[tuple[Any, ArchivedFile]]:
        """Daha önce geçici hatayla inmeyen dosyaları yeniden dene. (files satırı, sonuç) döner."""
        results = []
        for row in self.db.files_to_retry(adapter.name, MAX_DOWNLOAD_ATTEMPTS, limit):
            item = self.db.get_item(adapter.name, row["item_external_id"])
            if item is None or item["removed_at"] is not None:
                continue
            rf = RemoteFile(url=row["url"], filename=row["filename"], size=row["size"], mimetype=row["mime"])
            res = self._download(adapter, row["item_external_id"], item["course_name"], rf, row["source_key"],
                                 int(row["attempts"]))
            results.append((row, res))
        return results

    def _download(self, adapter: Adapter, item_external_id: str, course_name: str | None, rf: RemoteFile,
                  key: str, attempts: int) -> ArchivedFile:
        pcfg = adapter.pcfg
        platform = adapter.name
        # url: dosyanın kendi adresi (token'sız); yeniden denemede bundan indirilir
        base_row = {"platform": platform, "source_key": key, "item_external_id": item_external_id,
                    "url": strip_secrets_from_url(rf.url), "filename": rf.filename, "mime": rf.mimetype}
        max_bytes = pcfg.max_file_mb * 1024 * 1024
        allowed = {e.lower() for e in pcfg.file_extensions}
        if allowed and rf.extension not in allowed:
            return self._skip(base_row, rf, f"uzantı izinli değil (.{rf.extension or '?'})")
        if rf.size and rf.size > max_bytes:
            return self._skip(base_row, rf, f"boyut sınırı aşıldı ({rf.size / 1048576:.1f} MB > {pcfg.max_file_mb} MB)")
        if self.free_bytes() < MIN_FREE_BYTES + (rf.size or 0):
            self.db.upsert_file(**base_row, size=rf.size, status="retry", error="disk dolu", attempts=attempts)
            raise DiskFull(f"Diskte yer kalmadı ({self.free_bytes() / 1048576:.0f} MB boş); indirme ertelendi.")

        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.tmp_dir / f"{key[:16]}.part"
        try:
            result = adapter.download(rf, tmp, max_bytes)
        except ResponseTooLarge as exc:
            tmp.unlink(missing_ok=True)
            return self._skip(base_row, rf, f"boyut sınırı aşıldı ({exc})")
        except NotAFile as exc:
            self.db.upsert_file(**base_row, status="error", error=str(exc)[:300], attempts=attempts + 1)
            return ArchivedFile(rf.filename, None, None, None, "error", str(exc))
        except AuthExpired:
            tmp.unlink(missing_ok=True)
            raise
        except (TransientError, httpx.HTTPError, OSError) as exc:
            tmp.unlink(missing_ok=True)
            attempts += 1
            final_try = attempts >= MAX_DOWNLOAD_ATTEMPTS
            status = "error" if final_try else "retry"
            reason = f"{type(exc).__name__}: {str(exc)[:200]}"
            self.db.upsert_file(**base_row, size=rf.size, status=status, error=reason, attempts=attempts)
            log.warning("İndirme başarısız (%s, deneme %d/%d): %s", rf.filename, attempts, MAX_DOWNLOAD_ATTEMPTS, reason)
            return ArchivedFile(rf.filename, None, None, None, "error",
                                "indirilemedi" if final_try else "geçici hata, sonraki kontrolde yeniden denenecek")

        dup = self.db.find_file_by_sha(result.sha256)
        if dup is not None and Path(dup["path"]).is_file():
            tmp.unlink(missing_ok=True)
            final = Path(dup["path"])
            reused = True
        else:
            course = safe_name(course_name or "genel", 60)
            final = self.files_dir / platform / course / f"{result.sha256[:10]}_{safe_name(rf.filename)}"
            final.parent.mkdir(parents=True, exist_ok=True)
            tmp.replace(final)
            reused = False
        self.db.upsert_file(**base_row, sha256=result.sha256, size=result.size, path=str(final),
                            status="ok", error=None, downloaded_at=iso(utcnow()), attempts=attempts + 1)
        log.info("Dosya arşivlendi: %s (%d bayt%s)", rf.filename, result.size, ", tekil kopya" if reused else "")
        return ArchivedFile(rf.filename, final, result.size, result.sha256, "ok", None, reused)

    def _skip(self, row: dict, rf: RemoteFile, reason: str) -> ArchivedFile:
        self.db.upsert_file(**row, size=rf.size, status="skipped", error=reason)
        return ArchivedFile(rf.filename, None, rf.size, None, "skipped", reason)

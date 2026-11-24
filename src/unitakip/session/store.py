"""Şifreli oturum / token / kimlik bilgisi deposu: data/secrets/<ad>.enc"""

from __future__ import annotations

import fcntl
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from ..crypto import SecretBox
from ..models import iso, parse_iso, utcnow

_NAME = re.compile(r"^[a-z0-9_.-]+$")


class SessionStore:
    def __init__(self, secrets_dir: Path, box: SecretBox):
        self.dir = secrets_dir
        self.box = box

    def _path(self, name: str) -> Path:
        if not _NAME.match(name):
            raise ValueError(f"Geçersiz gizli kayıt adı: {name!r}")
        return self.dir / f"{name}.enc"

    def exists(self, name: str) -> bool:
        return self._path(name).is_file()

    @contextmanager
    def _locked(self):  # type: ignore[no-untyped-def]
        self.dir.mkdir(parents=True, exist_ok=True)
        with (self.dir / ".lock").open("a") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def _write(self, name: str, data: dict[str, Any]) -> dict[str, Any]:
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass
        payload = dict(data)
        payload.setdefault("created_at", iso(utcnow()))
        payload["saved_at"] = utcnow().isoformat()  # mikro saniye: eşzamanlı yazımları ayırt etmek için
        path = self._path(name)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(self.box.encrypt_json(payload))
        os.replace(tmp, path)
        return payload

    def save(self, name: str, data: dict[str, Any]) -> dict[str, Any]:
        """Koşulsuz kaydet (ör. kullanıcı az önce giriş yaptı: bu kayıt esastır)."""
        with self._locked():
            return self._write(name, data)

    def save_if_unchanged(self, name: str, data: dict[str, Any], expected_saved_at: str | None) -> dict[str, Any] | None:
        """Yalnızca dosya, okunduğundan beri başka biri tarafından yazılmadıysa kaydet.

        Daemon bir kontrol yaparken kullanıcı yeniden giriş yaparsa (veya push-session yeni oturumu
        getirirse), kontrolün sonunda eski çerezler yeni oturumun ÜZERİNE YAZILMAZ. Yazılmadıysa None.
        """
        with self._locked():
            current = self.load(name)
            if current is not None and current.get("saved_at") != expected_saved_at:
                return None
            return self._write(name, data)

    def load(self, name: str) -> dict[str, Any] | None:
        path = self._path(name)
        if not path.is_file():
            return None
        return self.box.decrypt_json(path.read_bytes())

    def delete(self, name: str) -> bool:
        path = self._path(name)
        if path.is_file():
            path.unlink()
            return True
        return False

    def age(self, name: str) -> timedelta | None:
        data = self.load(name)
        created = parse_iso(data.get("created_at")) if data else None
        return utcnow() - created if created else None

    def created_at(self, name: str) -> datetime | None:
        data = self.load(name)
        return parse_iso(data.get("created_at")) if data else None


def cookies_from_storage_state(state: dict[str, Any]) -> httpx.Cookies:
    """Playwright storage_state → httpx çerez kavanozu."""
    jar = httpx.Cookies()
    for c in state.get("cookies", []):
        domain = c.get("domain", "")
        jar.set(c["name"], c["value"], domain=domain, path=c.get("path", "/"))
    return jar


def merge_cookies_into_state(state: dict[str, Any], jar: httpx.Cookies) -> dict[str, Any]:
    """HTTP yanıtlarıyla yenilenen çerezleri storage_state'e geri yaz (oturum tazeleme)."""
    by_key = {(c["name"], c.get("domain", ""), c.get("path", "/")): c for c in state.get("cookies", [])}
    for cookie in jar.jar:
        key = (cookie.name, cookie.domain, cookie.path)
        entry = by_key.get(key)
        if entry is None:
            entry = {
                "name": cookie.name, "domain": cookie.domain, "path": cookie.path,
                "httpOnly": True, "secure": bool(cookie.secure), "sameSite": "Lax",
            }
            by_key[key] = entry
        entry["value"] = cookie.value or ""
        entry["expires"] = float(cookie.expires) if cookie.expires else -1
    new_state = dict(state)
    new_state["cookies"] = list(by_key.values())
    return new_state

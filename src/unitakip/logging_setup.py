"""Loglama: gizli değerleri maskeleyen filtre + döner dosya logu."""

from __future__ import annotations

import logging
import logging.handlers
import re
import sys
import threading
from pathlib import Path

_SECRET_PARAM = re.compile(
    r"(?i)\b(wstoken|token|privatetoken|sesskey|password|passwd|sifre|şifre|code|"
    r"access_token|refresh_token|id_token|client_secret|logintoken|__RequestVerificationToken)"
    r"(=|%3D)([^&\s\"'<>]+)"
)
_SECRET_JSON = re.compile(
    r'(?i)("(?:token|privatetoken|password|sifre|refresh_token|access_token|id_token|client_secret|'
    r'sesskey|cookie|value)"\s*:\s*)"(?:\\.|[^"\\])*"'
)
_SECRET_HEADER = re.compile(r"(?i)\b(cookie|set-cookie|authorization|x-api-key)(\s*[:=]\s*)[^\n,]+")

_registered: set[str] = set()
_lock = threading.Lock()


def register_secret(value: str | None) -> None:
    """Çalışma anında bilinen gizli değeri (token, parola) log çıktısından maskele."""
    if value and len(value) >= 6:
        with _lock:
            _registered.add(value)


def redact(text: str) -> str:
    text = _SECRET_PARAM.sub(lambda m: f"{m.group(1)}{m.group(2)}***", text)
    text = _SECRET_JSON.sub(lambda m: f'{m.group(1)}"***"', text)
    text = _SECRET_HEADER.sub(lambda m: f"{m.group(1)}{m.group(2)}***", text)
    with _lock:
        secrets = list(_registered)
    for s in secrets:
        if s in text:
            text = text.replace(s, "***")
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 - biçimlendirme hatası logu düşürmesin
            return True
        record.msg = redact(msg)
        record.args = ()
        if record.exc_info and not record.exc_text:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = redact(record.exc_text)
        return True


def setup_logging(level: str = "INFO", log_dir: Path | None = None) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level.upper())
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    redactor = RedactingFilter()

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    console.addFilter(redactor)
    root.addHandler(console)

    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            log_dir / "unitakip.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        fh.setFormatter(fmt)
        fh.addFilter(redactor)
        root.addHandler(fh)

    for noisy in ("httpx", "httpcore", "googleapiclient.discovery_cache", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

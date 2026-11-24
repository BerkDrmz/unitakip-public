"""Nazik HTTP istemcisi: host başına hız sınırı, geçici hatalarda üstel geri çekilme."""

from __future__ import annotations

import hashlib
import logging
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx

from .config import HttpConfig
from .models import strip_secrets_from_url

log = logging.getLogger(__name__)

RETRY_STATUS = {429, 500, 502, 503, 504}


class TransientError(RuntimeError):
    """Ağ / sunucu kaynaklı geçici hata: sonra yeniden denenebilir."""


class ResponseTooLarge(TransientError):
    """Yanıt boyut sınırını aştı (http.max_response_mb / max_file_mb). Kapsam hatası gibi ele alınır."""


@dataclass(slots=True)
class DownloadResult:
    sha256: str
    size: int
    content_type: str
    final_url: str


class HttpClient:
    def __init__(
        self,
        cfg: HttpConfig,
        *,
        cookies: httpx.Cookies | None = None,
        headers: dict[str, str] | None = None,
        user_agent: str | None = None,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.cfg = cfg
        self._sleep = sleep
        self._clock = clock
        self._last: dict[str, float] = {}
        base_headers = {"User-Agent": user_agent or cfg.user_agent, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5"}
        base_headers.update(headers or {})
        self.client = httpx.Client(
            timeout=httpx.Timeout(cfg.timeout_seconds),
            follow_redirects=True,
            headers=base_headers,
            cookies=cookies,
            transport=transport,
        )
        self.request_count = 0

    @property
    def cookies(self) -> httpx.Cookies:
        return self.client.cookies

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "HttpClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ----------------------------------------------------------- iç yardımcılar
    def _throttle(self, url: str) -> None:
        host = urlsplit(url).netloc
        last = self._last.get(host)
        if last is not None:
            wait = self.cfg.min_request_interval_seconds - (self._clock() - last)
            if wait > 0:
                self._sleep(wait)
        self._last[host] = self._clock()

    def _backoff(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(float(retry_after), 60.0)
            except ValueError:
                pass
        return min(2.0 * (2**attempt) + random.uniform(0, 1), 30.0)

    # ------------------------------------------------------------- genel API
    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        safe_url = strip_secrets_from_url(url)
        last_exc: Exception | None = None
        for attempt in range(self.cfg.max_retries + 1):
            self._throttle(url)
            self.request_count += 1
            try:
                resp = self._send_limited(method, url, **kwargs)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_exc = exc
                log.warning("Ağ hatası (%s %s, deneme %d): %s", method, safe_url, attempt + 1, type(exc).__name__)
            else:
                if resp.status_code not in RETRY_STATUS:
                    return resp
                last_exc = TransientError(f"HTTP {resp.status_code}")
                log.warning("Geçici sunucu yanıtı %d (%s, deneme %d)", resp.status_code, safe_url, attempt + 1)
                if attempt < self.cfg.max_retries:
                    self._sleep(self._backoff(attempt, resp.headers.get("Retry-After")))
                    continue
                break
            if attempt < self.cfg.max_retries:
                self._sleep(self._backoff(attempt, None))
        raise TransientError(f"{method} {safe_url} başarısız: {last_exc}") from last_exc

    def _send_limited(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """İsteği akış halinde gönder; http.max_response_mb sınırını aşan yanıtı belleğe almadan reddet."""
        limit = self.cfg.max_response_mb * 1024 * 1024
        request = self.client.build_request(method, url, **kwargs)
        resp = self.client.send(request, stream=True)
        try:
            declared = int(resp.headers.get("Content-Length") or 0)
            if declared > limit:
                raise ResponseTooLarge(f"{strip_secrets_from_url(url)}: {declared} bayt > {limit}")
            body = bytearray()
            for chunk in resp.iter_bytes(64 * 1024):
                body += chunk
                if len(body) > limit:
                    raise ResponseTooLarge(f"{strip_secrets_from_url(url)}: > {limit} bayt")
        finally:
            resp.close()
        # iter_bytes() gövdeyi zaten açtı (gzip/br): kodlama başlıkları atılmazsa ikinci kez açılmaya çalışılır
        headers = httpx.Headers([(k, v) for k, v in resp.headers.multi_items()
                                 if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")])
        return httpx.Response(resp.status_code, headers=headers, content=bytes(body),
                              request=resp.request, history=resp.history, extensions=resp.extensions)

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    def download(self, url: str, dest: Path, max_bytes: int) -> DownloadResult:
        """Akış halinde indir, SHA-256 hesapla, boyut sınırını uygula."""
        safe_url = strip_secrets_from_url(url)
        last_exc: Exception | None = None
        for attempt in range(self.cfg.max_retries + 1):
            self._throttle(url)
            self.request_count += 1
            digest = hashlib.sha256()
            size = 0
            try:
                with self.client.stream("GET", url) as resp:
                    if resp.status_code in RETRY_STATUS:
                        raise TransientError(f"HTTP {resp.status_code}")
                    resp.raise_for_status()
                    declared = int(resp.headers.get("Content-Length") or 0)
                    if declared and declared > max_bytes:
                        raise ResponseTooLarge(f"{declared} bayt > sınır {max_bytes}")
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with dest.open("wb") as fh:
                        for chunk in resp.iter_bytes(64 * 1024):
                            size += len(chunk)
                            if size > max_bytes:
                                raise ResponseTooLarge(f"> {max_bytes} bayt")
                            digest.update(chunk)
                            fh.write(chunk)
                    return DownloadResult(
                        sha256=digest.hexdigest(), size=size,
                        content_type=resp.headers.get("Content-Type", ""),
                        final_url=strip_secrets_from_url(str(resp.url)),
                    )
            except (ResponseTooLarge, httpx.HTTPStatusError):
                dest.unlink(missing_ok=True)
                raise
            except (httpx.TransportError, httpx.TimeoutException, TransientError) as exc:
                dest.unlink(missing_ok=True)
                last_exc = exc
                log.warning("İndirme hatası (%s, deneme %d): %s", safe_url, attempt + 1, exc)
                if attempt < self.cfg.max_retries:
                    self._sleep(self._backoff(attempt, None))
        raise TransientError(f"İndirme başarısız: {safe_url}: {last_exc}") from last_exc

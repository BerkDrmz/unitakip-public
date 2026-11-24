"""Adaptör arayüzü ve ortak hata türleri."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from ..config import AppConfig, PlatformConfig
from ..http import DownloadResult
from ..models import RemoteFile, Snapshot
from ..session.store import SessionStore


class AdapterError(RuntimeError):
    pass


class AuthMissing(AdapterError):
    """Bu platform için hiç giriş yapılmamış (oturum/token yok)."""


class AuthExpired(AdapterError):
    """Oturum veya token geçersiz: kullanıcının yeniden giriş yapması gerekiyor."""


class LoginFailed(AdapterError):
    """Giriş denemesi reddedildi (yanlış bilgi, kilitli hesap vb.)."""


class NotAFile(AdapterError):
    """Dosya beklenirken HTML döndü (çoğunlukla oturum düşmüş demektir)."""


class Adapter(ABC):
    def __init__(self, name: str, pcfg: PlatformConfig, app: AppConfig, store: SessionStore):
        self.name = name
        self.pcfg = pcfg
        self.app = app
        self.store = store

    @property
    def session_key(self) -> str:
        return f"{self.name}.session"

    @property
    def credentials_key(self) -> str:
        return f"{self.name}.credentials"

    @abstractmethod
    def fetch(self) -> Snapshot:
        """Platformun güncel durumunu salt-okunur biçimde çek."""

    @abstractmethod
    def download(self, rf: RemoteFile, dest: Path, max_bytes: int) -> DownloadResult:
        """Dosyayı dest yoluna indir (oturum bilgisiyle)."""

    def keepalive(self) -> bool:
        """Oturumu canlı tut. True: oturum geçerli."""
        return True

    def close(self) -> None:  # noqa: B027 - isteğe bağlı kanca
        pass

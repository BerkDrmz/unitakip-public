"""Şifreleme: Fernet (AES-128-CBC + HMAC-SHA256, kimliği doğrulanmış).

Anahtar veriyle aynı yerde DURMAZ: `UNITAKIP_MASTER_KEY` ortam değişkeni (.env / Docker env_file).
"""

from __future__ import annotations

import json
import os
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from .config import ConfigError

ENV_KEY = "UNITAKIP_MASTER_KEY"


class DecryptionError(RuntimeError):
    """Şifreli veri çözülemedi (yanlış anahtar veya bozuk dosya)."""


class SecretBox:
    def __init__(self, key: str | bytes):
        try:
            self._fernet = Fernet(key.encode() if isinstance(key, str) else key)
        except (ValueError, TypeError) as exc:
            raise ConfigError(f"{ENV_KEY} geçerli bir Fernet anahtarı değil.") from exc

    @staticmethod
    def generate_key() -> str:
        return Fernet.generate_key().decode()

    @classmethod
    def from_env(cls) -> "SecretBox":
        key = os.environ.get(ENV_KEY, "").strip()
        if not key:
            raise ConfigError(
                f"{ENV_KEY} tanımlı değil. `unitakip init` ile üret ve .env dosyasında sakla."
            )
        return cls(key)

    def encrypt_bytes(self, data: bytes) -> bytes:
        return self._fernet.encrypt(data)

    def decrypt_bytes(self, blob: bytes) -> bytes:
        try:
            return self._fernet.decrypt(blob)
        except InvalidToken as exc:
            raise DecryptionError(
                "Şifreli veri çözülemedi: anahtar değişmiş veya dosya bozulmuş olabilir."
            ) from exc

    def encrypt_json(self, obj: Any) -> bytes:
        return self.encrypt_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def decrypt_json(self, blob: bytes) -> Any:
        return json.loads(self.decrypt_bytes(blob).decode("utf-8"))

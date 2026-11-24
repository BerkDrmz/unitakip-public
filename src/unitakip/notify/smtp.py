"""Google Cloud gerektirmeyen Gmail SMTP gönderimi; uygulama şifresi şifreli saklanır."""

from __future__ import annotations

import re
import smtplib
import ssl
from contextlib import contextmanager
from email.utils import formatdate, make_msgid
from typing import Iterator

from ..logging_setup import register_secret
from ..session.store import SessionStore
from .base import Email, NotifierError

SECRET_NAME = "gmail.smtp"


def _credentials(username: str, password: str) -> tuple[str, str]:
    username = username.strip()
    register_secret(password)
    password = "".join(password.split())
    register_secret(password)
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@(gmail\.com|googlemail\.com)", username, re.IGNORECASE):
        raise NotifierError("Gönderen adresi kişisel bir Gmail adresi olmalı (@gmail.com).")
    if not re.fullmatch(r"[A-Za-z0-9]{16}", password):
        raise NotifierError("Google'ın oluşturduğu 16 karakterli uygulama şifresini gir; normal hesap şifreni kullanma.")
    return username, password


@contextmanager
def _connection(username: str, password: str) -> Iterator[smtplib.SMTP_SSL]:
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context()) as smtp:
            smtp.login(username, password)
            yield smtp
    except smtplib.SMTPAuthenticationError:
        raise NotifierError("Gmail uygulama şifresini reddetti. `unitakip smtp-auth` ile yeniden tanımla.") from None
    except (smtplib.SMTPException, OSError):
        # Sunucunun ham yanıtı adres veya başka kişisel bilgi içerebilir.
        raise NotifierError("Gmail SMTP bağlantısı veya gönderimi başarısız. Bildirim daha sonra yeniden denenebilir.") from None


def configure_smtp(store: SessionStore, username: str, password: str) -> None:
    """Giriş bilgisini e-posta göndermeden doğrula; yalnızca başarılıysa şifreli kaydet."""
    username, password = _credentials(username, password)
    with _connection(username, password):
        pass
    store.save(SECRET_NAME, {"username": username, "password": password})


class GmailSMTPNotifier:
    name = "gmail_smtp"

    def __init__(self, store: SessionStore, to: str):
        if not to.strip():
            raise NotifierError("Bildirim alıcısı boş: .env içinde UNITAKIP_NOTIFY_TO adresini tanımla.")
        self.store = store
        self.to = to.strip()

    def send(self, email: Email) -> str:
        saved = self.store.load(SECRET_NAME)
        if not saved:
            raise NotifierError("Gmail uygulama şifresi yok: `unitakip smtp-auth` çalıştır.")
        username, password = _credentials(saved.get("username", ""), saved.get("password", ""))
        msg = email.to_mime(self.to, sender=username)
        msg["Date"] = formatdate(localtime=False)
        msg["Message-ID"] = make_msgid(domain=username.rsplit("@", 1)[1])
        with _connection(username, password) as smtp:
            refused = smtp.send_message(msg, from_addr=username, to_addrs=[self.to])
            if refused:
                raise NotifierError("Gmail SMTP alıcı adresini kabul etmedi; bildirim gönderilmiş sayılmadı.")
        return str(msg["Message-ID"])

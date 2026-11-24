"""Bildirim arayüzü + konsol/dosya bildirici (test ve kuru çalıştırma için)."""

from __future__ import annotations

import logging
import mimetypes
from dataclasses import dataclass, field
from email.message import EmailMessage
from pathlib import Path
from typing import Protocol

from ..models import utcnow

log = logging.getLogger(__name__)


@dataclass(slots=True)
class Attachment:
    filename: str
    path: Path

    @property
    def size(self) -> int:
        return self.path.stat().st_size


@dataclass(slots=True)
class Email:
    subject: str
    text: str
    html: str
    attachments: list[Attachment] = field(default_factory=list)

    def to_mime(self, to: str, sender: str | None = None) -> EmailMessage:
        msg = EmailMessage()
        msg["To"] = to
        if sender:
            msg["From"] = sender
        msg["Subject"] = self.subject
        msg.set_content(self.text)
        msg.add_alternative(self.html, subtype="html")
        for att in self.attachments:
            ctype, _ = mimetypes.guess_type(att.filename)
            maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
            msg.add_attachment(att.path.read_bytes(), maintype=maintype, subtype=subtype, filename=att.filename)
        return msg


class Notifier(Protocol):
    name: str

    def send(self, email: Email) -> str: ...


class NotifierError(RuntimeError):
    """Bildirim gönderilemedi (sonra yeniden denenir).

    permanent=True: kanal çalışıyor ama BU ileti reddedildi (ör. boyut/biçim, HTTP 400/413). Böyle bir
    ileti kanalı kilitlemez: tek başına, gerekirse eksiz yeniden denenir.
    """

    def __init__(self, message: str, *, permanent: bool = False):
        super().__init__(message)
        self.permanent = permanent


class ConsoleNotifier:
    """E-posta göndermez: konuyu loglar, .eml dosyasını data/outbox altına yazar."""

    name = "console"

    def __init__(self, outbox: Path, to: str = "test@example.invalid"):
        self.outbox = outbox
        self.to = to or "test@example.invalid"
        self.sent: list[Email] = []

    def send(self, email: Email) -> str:
        self.outbox.mkdir(parents=True, exist_ok=True)
        stamp = utcnow().strftime("%Y%m%dT%H%M%S%f")
        path = self.outbox / f"{stamp}.eml"
        path.write_bytes(bytes(email.to_mime(self.to)))
        self.sent.append(email)
        log.info("[console] Bildirim hazırlandı: %s (%d ek) → %s", email.subject, len(email.attachments), path.name)
        return path.name

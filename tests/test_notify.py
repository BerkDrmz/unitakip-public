"""E-posta içeriği ve Gmail gönderimi (sahte servis)."""

from __future__ import annotations

import base64
import email
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from unitakip.ai.base import Analysis
from unitakip.models import Kind
from unitakip.notify.base import Attachment, Email, NotifierError
from unitakip.notify.gmail import GmailNotifier
from unitakip.notify.render import ChangeView, FileNote, render_digest
from unitakip.session.store import SessionStore


def _view(**kw) -> ChangeView:
    base = dict(change_id=1, platform="sanal", platform_name="Sanal Öğrenme", kind=Kind.ASSIGNMENT,
                change_type="new", title="Ödev <1>", course="Fizik", url="https://x/mod/assign/view.php?id=1&token=gizli",
                detected_at=datetime(2026, 11, 9, 9, 0, tzinfo=UTC), due_at=datetime(2026, 11, 20, 20, 59, tzinfo=UTC),
                summary=None, analysis=Analysis("Fizik", "Ödev", "Problem seti çözülecek.", "yüksek", None,
                                                ["Teslim et"], 2, "son teslim 20 Kasım"),
                files=[FileNote("soru.pdf", "attached")])
    base.update(kw)
    return ChangeView(**base)


def test_digest_contains_required_fields():
    em = render_digest([_view()], "Sanal Öğrenme", "[UniTakip]", ZoneInfo("Europe/Istanbul"), [])
    for needle in ("Sanal Öğrenme", "Fizik", "Ödev &lt;1&gt;", "Yeni", "Tespit tarihi", "09.11.2026 12:00",
                   "20.11.2026 23:59", "Problem seti", "Teslim et", "soru.pdf", "e-postaya eklendi",
                   "https://x/mod/assign/view.php?id=1"):
        assert needle in em.html, needle
    assert "token=gizli" not in em.html and "token=gizli" not in em.text
    assert em.subject.startswith("[UniTakip] [ÖNEMLİ] Sanal Öğrenme")


def test_digest_sorted_by_importance():
    low = _view(change_id=2, title="Sunum", kind=Kind.FILE,
                analysis=Analysis("Fizik", "x", "s", "düşük", None, [], 4))
    em = render_digest([low, _view()], "Sanal", "[U]", ZoneInfo("UTC"), [])
    assert em.text.index("Ödev <1>") < em.text.index("Sunum")
    assert "2 değişiklik" in em.subject


class FakeSend:
    def __init__(self):
        self.bodies = []

    def users(self):
        return self

    def messages(self):
        return self

    def send(self, userId, body, media_body=None):  # noqa: N803
        self.bodies.append((userId, body, media_body))
        return self

    def execute(self):
        return {"id": "msg-1"}


def test_gmail_send_builds_valid_mime(tmp_path, box):
    att = tmp_path / "soru.pdf"
    att.write_bytes(b"%PDF")
    n = GmailNotifier(SessionStore(tmp_path / "s", box), "ben@gmail.com")
    fake = FakeSend()
    n._gmail = lambda: fake  # type: ignore[method-assign]
    assert n.send(Email("Konu ğüş", "metin", "<b>html</b>", [Attachment("soru.pdf", att)])) == "msg-1"
    user, body, _ = fake.bodies[0]
    msg = email.message_from_bytes(base64.urlsafe_b64decode(body["raw"]))
    assert user == "me" and msg["To"] == "ben@gmail.com"
    assert [p.get_filename() for p in msg.walk() if p.get_filename()] == ["soru.pdf"]


def test_gmail_without_authorization(tmp_path, box):
    with pytest.raises(NotifierError):
        GmailNotifier(SessionStore(tmp_path / "s", box), "")
    n = GmailNotifier(SessionStore(tmp_path / "s", box), "ben@gmail.com")
    with pytest.raises(NotifierError, match="gmail-auth"):
        n.send(Email("a", "b", "c"))

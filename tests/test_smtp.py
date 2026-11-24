"""SMTP kimlik doğrulama, şifreli saklama ve başarısız gönderim sınırları (ağsız)."""

from __future__ import annotations

import argparse
import getpass
import smtplib
import ssl
import warnings

import pytest

from unitakip import cli
from unitakip.config import ConfigError
from unitakip.notify.base import Attachment, Email, NotifierError
from unitakip.notify.smtp import SECRET_NAME, GmailSMTPNotifier, configure_smtp
from unitakip.scheduler import App, Runner, make_notifier
from unitakip.session.store import SessionStore

USERNAME = "owner@gmail.com"
PASSWORD = "abcdefghijklmnop"


@pytest.fixture
def store(tmp_path, box):
    return SessionStore(tmp_path / "secrets", box)


@pytest.fixture
def smtp(monkeypatch):
    class FakeSMTP:
        login_error = None
        send_error = None
        refused = {}

        def __init__(self):
            self.connections = []
            self.logins = []
            self.messages = []

        def __call__(self, host, port, *, timeout, context):
            self.connections.append((host, port, timeout, context))
            return self

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def login(self, username, password):
            if self.login_error:
                raise self.login_error
            self.logins.append((username, password))

        def send_message(self, message, *, from_addr, to_addrs):
            if self.send_error:
                raise self.send_error
            self.messages.append((message, from_addr, to_addrs))
            return self.refused

    fake = FakeSMTP()
    monkeypatch.setattr("unitakip.notify.smtp.smtplib.SMTP_SSL", fake)
    return fake


def test_smtp_auth_verifies_then_encrypts_without_sending(store, smtp):
    configure_smtp(store, USERNAME, "abcd efgh ijkl mnop")
    assert smtp.logins == [(USERNAME, PASSWORD)]
    assert not smtp.messages
    raw = (store.dir / f"{SECRET_NAME}.enc").read_bytes()
    assert PASSWORD.encode() not in raw and USERNAME.encode() not in raw
    assert store.load(SECRET_NAME)["password"] == PASSWORD
    host, port, timeout, context = smtp.connections[0]
    assert (host, port) == ("smtp.gmail.com", 465)
    assert timeout > 0
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname


def test_failed_auth_preserves_previous_secret_and_redacts_server_error(store, smtp):
    store.save(SECRET_NAME, {"username": USERNAME, "password": PASSWORD})
    before = (store.dir / f"{SECRET_NAME}.enc").read_bytes()
    smtp.login_error = smtplib.SMTPAuthenticationError(535, PASSWORD.encode())
    with pytest.raises(NotifierError, match="smtp-auth") as exc:
        configure_smtp(store, USERNAME, "ponmlkjihgfedcba")
    assert PASSWORD not in str(exc.value)
    assert (store.dir / f"{SECRET_NAME}.enc").read_bytes() == before


@pytest.mark.parametrize("username,password", [
    ("owner@example.com", PASSWORD),
    ("owner@gmail.com\r\nBcc:other@gmail.com", PASSWORD),
    (USERNAME, "normal-parola"),
    (USERNAME, ""),
])
def test_invalid_smtp_credentials_never_connect_or_save(store, smtp, username, password):
    with pytest.raises(NotifierError):
        configure_smtp(store, username, password)
    assert not smtp.connections and not store.exists(SECRET_NAME)


def test_smtp_send_preserves_turkish_mime_and_attachments(store, smtp, tmp_path):
    store.save(SECRET_NAME, {"username": USERNAME, "password": PASSWORD})
    path = tmp_path / "ödev.pdf"
    path.write_bytes(b"%PDF test")
    notifier = GmailSMTPNotifier(store, "receiver@gmail.com")
    message_id = notifier.send(Email("Yeni ödev", "Türkçe metin", "<b>Ödev</b>", [Attachment(path.name, path)]))
    msg, sender, recipients = smtp.messages[0]
    assert sender == USERNAME and recipients == ["receiver@gmail.com"]
    assert str(msg["Subject"]) == "Yeni ödev" and msg["From"] == USERNAME
    assert msg["Message-ID"] == message_id and msg["Date"]
    assert msg.get_body(preferencelist=("plain",)).get_content().strip() == "Türkçe metin"
    assert next(msg.iter_attachments()).get_payload(decode=True) == b"%PDF test"


@pytest.mark.parametrize("error", [
    smtplib.SMTPServerDisconnected("private server response"),
    ssl.SSLCertVerificationError("private server response"),
    TimeoutError("private server response"),
])
def test_smtp_transport_failure_is_retryable_and_sanitized(store, smtp, error):
    store.save(SECRET_NAME, {"username": USERNAME, "password": PASSWORD})
    smtp.send_error = error
    with pytest.raises(NotifierError) as exc:
        GmailSMTPNotifier(store, USERNAME).send(Email("test", "text", "html"))
    assert "private server response" not in str(exc.value)
    assert store.exists(SECRET_NAME)


def test_refused_recipient_is_not_reported_as_sent(store, smtp):
    store.save(SECRET_NAME, {"username": USERNAME, "password": PASSWORD})
    smtp.refused = {USERNAME: (550, b"unavailable")}
    with pytest.raises(NotifierError, match="gönderilmiş sayılmadı"):
        GmailSMTPNotifier(store, USERNAME).send(Email("test", "text", "html"))


def test_missing_smtp_credentials_never_connect(store, smtp):
    with pytest.raises(NotifierError, match="smtp-auth"):
        GmailSMTPNotifier(store, USERNAME).send(Email("test", "text", "html"))
    assert not smtp.connections


def test_smtp_requires_recipient(store):
    with pytest.raises(NotifierError, match="UNITAKIP_NOTIFY_TO"):
        GmailSMTPNotifier(store, "")


def test_scheduler_selects_smtp_provider(cfg, store):
    cfg.notify.provider = "gmail_smtp"
    assert isinstance(make_notifier(cfg, store), GmailSMTPNotifier)


def test_cli_smtp_auth_prompts_and_saves_without_database(cfg, box, monkeypatch, smtp, capsys):
    cfg.notify.to = USERNAME
    monkeypatch.setattr(cli, "_load", lambda _: cfg)
    monkeypatch.setenv("UNITAKIP_MASTER_KEY", box.generate_key())
    monkeypatch.setattr("builtins.input", lambda _: "")
    monkeypatch.setattr(cli.getpass, "getpass", lambda _: "abcd efgh ijkl mnop")
    assert cli.cmd_smtp_auth(argparse.Namespace()) == 0
    output = capsys.readouterr().out
    assert PASSWORD not in output and "abcd efgh ijkl mnop" not in output
    assert "E-posta gönderilmedi" in output
    assert not cfg.db_path.exists() and not smtp.messages
    assert (cfg.secrets_dir / f"{SECRET_NAME}.enc").is_file()
    assert cli.build_parser().parse_args(["smtp-auth"]).func == cli.cmd_smtp_auth


def test_cli_refuses_password_echo_fallback(cfg, monkeypatch, smtp):
    monkeypatch.setattr(cli, "_load", lambda _: cfg)
    monkeypatch.setattr("builtins.input", lambda _: USERNAME)

    def unsafe_prompt(_):
        warnings.warn("Cannot hide input", getpass.GetPassWarning)
        return PASSWORD

    monkeypatch.setattr(cli.getpass, "getpass", unsafe_prompt)
    with pytest.raises(ConfigError, match="etkileşimli"):
        cli.cmd_smtp_auth(argparse.Namespace())
    assert not smtp.connections and not (cfg.secrets_dir / f"{SECRET_NAME}.enc").exists()


def test_smtp_outage_keeps_queued_change_then_delivers_once(app, moodle, smtp):
    app.store.save(SECRET_NAME, {"username": USERNAME, "password": PASSWORD})
    app._notifier = GmailSMTPNotifier(app.store, USERNAME)
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.discussions[50].insert(0, {"id": 808, "discussion": 808, "subject": "Yeni duyuru",
                                      "message": "x", "attachments": []})
    smtp.send_error = TimeoutError("bağlantı yok")
    runner.run_platform("sanal")
    assert app.db.pending_count() == 1 and not smtp.messages
    smtp.send_error = None
    runner._flush_backoff_until = None
    assert runner.flush() == 1 and app.db.pending_count() == 0
    assert runner.flush() == 0 and len(smtp.messages) == 1


def test_cli_dry_run_with_smtp_never_connects_or_consumes_change(app, moodle, cfg, box, smtp, monkeypatch):
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.discussions[50].insert(0, {"id": 809, "discussion": 809, "subject": "Yeni duyuru",
                                      "message": "x", "attachments": []})
    cfg.notify.provider = "gmail_smtp"
    monkeypatch.setattr(cli, "_load", lambda _: cfg)
    monkeypatch.setattr(cli, "_app", lambda conf, **kw: App(conf, box=box, adapter_factory=app.adapter_factory, **kw))
    assert cli.cmd_run_once(argparse.Namespace(platform="sanal", dry_run=True)) == 0
    assert not smtp.connections
    assert app.db.pending_count() == 0
    assert runner.run_platform("sanal").changes == 1

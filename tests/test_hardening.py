"""Gelecekteki arıza senaryolarına karşı sağlamlaştırma testleri (2026-11-09, ikinci inceleme)."""

from __future__ import annotations

import gzip
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest

from unitakip.adapters.moodle import MoodleAdapter
from unitakip.adapters.webpages import WebPagesAdapter
from unitakip.archive import safe_name
from unitakip.config import HttpConfig, PageConfig
from unitakip.discovery.web import _post_field_names
from unitakip.http import HttpClient, ResponseTooLarge, TransientError
from unitakip.notify.base import ConsoleNotifier, NotifierError
from unitakip.scheduler import Runner, _watchdog
from unitakip.session.store import SessionStore

from .conftest import WEB, emails, http_for


class Clock:
    def __init__(self, start: datetime):
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw) -> None:  # type: ignore[no-untyped-def]
        self.now += timedelta(**kw)


def _grade_page(n: int) -> str:
    rows = "".join(f"<tr><td>Ders{i}</td><td>{50 + i}</td></tr>" for i in range(n))
    return f"<html><body><table><tr><th>Ders</th><th>Not</th></tr>{rows}</table></body></html>"


# --- bakım sayfası / toplu düşüş -------------------------------------------------
def test_maintenance_page_produces_no_spam(app, site):
    site.page = _grade_page(10)
    runner = Runner(app)
    runner.run_platform("web")
    site.page = "<html><body><p>Sistem bakımda, lütfen sonra tekrar deneyin.</p></body></html>"
    runner.run_platform("web")
    site.page = _grade_page(10)
    runner.run_platform("web")
    assert emails(app) == []


def test_persistent_drop_is_accepted_and_reported(app, site):
    site.page = _grade_page(10)
    runner = Runner(app)
    runner.run_platform("web")
    site.page = _grade_page(1)
    for _ in range(3):
        runner.run_platform("web")
    subjects = [e.subject for e in emails(app)]
    assert any("beklenmedik şekilde azaldı" in s for s in subjects)
    assert app.db.count_active_in_scope("web", "page:ana") == 1  # 3. çalıştırmada gerçek kabul edildi


# --- oturum yarışı ---------------------------------------------------------------
def test_stale_session_never_overwrites_fresh_login(tmp_path, box):
    store = SessionStore(tmp_path, box)
    first = store.save("x.session", {"v": "eski"})
    store.save("x.session", {"v": "YENİ GİRİŞ"})  # kullanıcı bu sırada yeniden giriş yaptı
    assert store.save_if_unchanged("x.session", {"v": "eski-çerezler"}, first["saved_at"]) is None
    assert store.load("x.session")["v"] == "YENİ GİRİŞ"
    current = store.load("x.session")
    assert store.save_if_unchanged("x.session", {"v": "tazelendi"}, current["saved_at"]) is not None


# --- keşif ağ kaydı ----------------------------------------------------------------
def test_discovery_post_fields_never_raise_or_leak():
    class Raising:
        @property
        def post_data_json(self):  # type: ignore[no-untyped-def]
            raise RuntimeError("POST data is not a valid JSON object: password=gizli")

    assert _post_field_names(Raising()) == []
    assert _post_field_names(SimpleNamespace(post_data_json={"username": "a", "password": "b"})) == ["password", "username"]


# --- indirme yeniden denemesi --------------------------------------------------------
def test_failed_download_is_retried_and_followed_up(app, moodle):
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.files["hafta2.pdf"] = b"%PDF yeni"
    moodle.sections[10][0]["modules"][0]["contents"].append(moodle.file_entry("hafta2.pdf", 1700100000))
    original = moodle.handler
    state = {"fail": True}

    def flaky(req):  # type: ignore[no-untyped-def]
        if "pluginfile" in req.url.path and state["fail"]:
            return httpx.Response(503)
        return original(req)

    moodle.handler = flaky
    app.adapter_factory = lambda a, n: MoodleAdapter(n, a.cfg.platform(n), a.cfg, a.store, http=http_for(moodle.handler))
    runner.run_platform("sanal")
    first = emails(app)[-1]
    assert "hafta2.pdf" in first.text and first.attachments == []
    state["fail"] = False
    runner.run_platform("sanal")
    follow = emails(app)[-1]
    assert follow is not first and "Dosya indirildi" in follow.text
    assert [a.filename for a in follow.attachments] == ["hafta2.pdf"]


def test_disk_full_stops_downloads_but_not_notifications(app, moodle, monkeypatch):
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.files["hafta2.pdf"] = b"%PDF yeni"
    moodle.sections[10][0]["modules"][0]["contents"].append(moodle.file_entry("hafta2.pdf", 1700100000))
    monkeypatch.setattr(type(app.archive), "free_bytes", lambda self: 10 * 1024 * 1024)
    runner.run_platform("sanal")
    subjects = [e.subject for e in emails(app)]
    assert any("Disk dolu" in s for s in subjects) and any("hafta2.pdf" in e.text for e in emails(app))
    assert moodle.downloads == []


# --- HTTP sınırları -----------------------------------------------------------------
def test_response_limit_and_gzip():
    body = "Türkçe ğüşiöç".encode() * 50

    def handler(req):  # type: ignore[no-untyped-def]
        if req.url.path == "/r":
            return httpx.Response(302, headers={"Location": "/gz"})
        return httpx.Response(200, headers={"Content-Encoding": "gzip", "Content-Type": "text/html; charset=utf-8"},
                              content=gzip.compress(body))

    ok = HttpClient(HttpConfig(min_request_interval_seconds=0, max_retries=0, max_response_mb=1),
                    transport=httpx.MockTransport(handler), sleep=lambda s: None)
    resp = ok.get("https://x.test/r")
    assert resp.text == body.decode() and str(resp.url) == "https://x.test/gz"
    tiny = HttpClient(HttpConfig(min_request_interval_seconds=0, max_retries=0, max_response_mb=0),
                      transport=httpx.MockTransport(handler), sleep=lambda s: None)
    with pytest.raises(ResponseTooLarge):
        tiny.get("https://x.test/gz")
    assert issubclass(ResponseTooLarge, TransientError)  # sayfa düzeyinde kapsam hatası olur


def test_missing_chromium_message(monkeypatch, capsys):
    from unitakip import cli

    class PwError(Exception):
        pass

    PwError.__module__ = "playwright._impl._errors"

    def boom(args):  # type: ignore[no-untyped-def]
        raise PwError("BrowserType.launch: Executable doesn't exist at /x/chrome")

    monkeypatch.setattr(cli, "cmd_health", boom)
    assert cli.main(["health"]) == 1
    assert "playwright install chromium" in capsys.readouterr().err


# --- ileri-geri değişiklik ----------------------------------------------------------
def test_same_value_again_next_day_is_notified():
    from unitakip.diff import apply_snapshot
    from unitakip.models import Item, Kind, Snapshot
    from unitakip.storage.db import Database

    db = Database(":memory:")
    t0 = datetime(2026, 11, 9, 10, tzinfo=UTC)

    def snap(v: int) -> Snapshot:
        s = Snapshot(platform="p", items=[Item(platform="p", external_id="a", kind=Kind.ASSIGNMENT, title="Ödev",
                                               scope="s", data={"duedate": v})])
        s.ok("s")
        return s

    apply_snapshot(db, snap(1), t0)
    assert len(apply_snapshot(db, snap(2), t0 + timedelta(hours=1))) == 1
    apply_snapshot(db, snap(1), t0 + timedelta(hours=2))
    assert apply_snapshot(db, snap(2), t0 + timedelta(hours=3)) == []  # aynı gün titreşim: bastırıldı
    apply_snapshot(db, snap(1), t0 + timedelta(days=1))
    assert len(apply_snapshot(db, snap(2), t0 + timedelta(days=1, hours=1))) == 1  # ertesi gün: bildirildi


# --- sessiz arıza izleme -------------------------------------------------------------
def test_weekly_status_report_once(app):
    clock = Clock(datetime(2026, 11, 16, 5, 0, tzinfo=UTC))  # Pazartesi 08:00 İstanbul
    app.clock = clock
    app.cfg.notify.status_report = "weekly"
    runner = Runner(app)
    runner.housekeeping()
    assert emails(app) == []  # saat 09:00'dan önce
    clock.advance(hours=1, minutes=30)
    runner.housekeeping()
    runner.housekeeping()
    assert len(emails(app)) == 1 and "Haftalık durum özeti" in emails(app)[0].subject
    clock.advance(days=1)
    runner.housekeeping()
    assert len(emails(app)) == 1


def test_stale_platform_alert(app):
    clock = Clock(datetime(2026, 11, 10, 12, tzinfo=UTC))
    app.clock = clock
    app.db.update_state("sanal", auth_status="ok", last_success_at=clock() - timedelta(hours=30),
                        last_error="KeyError: 'courses'")
    runner = Runner(app)
    runner.housekeeping()
    runner.housekeeping()
    stale = [e for e in emails(app) if "saattir kontrol edilemiyor" in e.subject]
    assert len(stale) == 1 and "KeyError" in stale[0].text


def test_persistent_scope_failure_alert(app, moodle):
    app.cfg.notify.scope_failure_alert_runs = 3
    moodle.fail_functions = {"gradereport_user_get_grade_items"}
    runner = Runner(app)
    for _ in range(3):
        runner.run_platform("sanal")
    alerts = [e for e in emails(app) if "bazı bölümler alınamıyor" in e.subject]
    assert len(alerts) == 1 and "course:10:grades" in alerts[0].text


def test_clock_jump_back_does_not_freeze_schedule(app):
    now = app.clock()
    app.db.update_state("sanal", next_run_at=now + timedelta(days=3))
    assert "sanal" in Runner(app).due_platforms(now)


def test_watchdog_restarts_hung_run():
    runner = SimpleNamespace(current_run=("ubys", datetime.now(UTC) - timedelta(minutes=40)))
    stop = threading.Event()
    exits = []
    t = threading.Thread(target=_watchdog, args=(runner, stop, timedelta(minutes=25), exits.append, 0.01))
    t.start()
    t.join(timeout=2)
    stop.set()
    assert exits == [70]


def test_daily_backup_and_rotation(app):
    clock = Clock(datetime(2026, 11, 1, 12, tzinfo=UTC))
    app.clock = clock
    app.cfg.backup_keep_days = 3
    runner = Runner(app)
    for _ in range(5):
        runner.housekeeping()
        runner.housekeeping()  # aynı gün ikinci kez yedek alınmaz
        clock.advance(days=1)
    backups = sorted(p.name for p in app.cfg.backups_dir.glob("*.sqlite3"))
    assert backups == ["unitakip-20261103.sqlite3", "unitakip-20261104.sqlite3", "unitakip-20261105.sqlite3"]


# --- adaptör dayanıklılığı -----------------------------------------------------------
def test_moodle_maintenance_is_transient(app, moodle):
    def handler(req):  # type: ignore[no-untyped-def]
        if req.url.path.endswith("server.php"):
            return httpx.Response(200, text="<html>Site bakımda</html>")
        return moodle.handler(req)

    app.adapter_factory = lambda a, n: MoodleAdapter(n, a.cfg.platform(n), a.cfg, a.store, http=http_for(handler))
    assert Runner(app).run_platform("sanal").status == "transient"


def test_moodle_unexpected_structure_isolated_without_removals(app, moodle):
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.assignments = [{"course": 10, "name": "id alanı yok"}]  # Moodle güncellemesi sonrası beklenmeyen yapı
    res = runner.run_platform("sanal")
    assert res.status == "ok"
    assert app.db.count_active_in_scope("sanal", "course:10:assign") == 1  # ödev "kaldırıldı" sayılmadı
    assert app.db.count_active_in_scope("sanal", "course:10:contents") > 0


def test_gmail_rejection_retries_without_attachments(app, moodle, cfg):
    class Picky(ConsoleNotifier):
        def send(self, email):  # type: ignore[no-untyped-def]
            if email.attachments:
                raise NotifierError("Gmail API hatası: HTTP 400", permanent=True)
            return super().send(email)

    app._notifier = Picky(cfg.outbox_dir)
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.files["hafta2.pdf"] = b"%PDF yeni"
    moodle.sections[10][0]["modules"][0]["contents"].append(moodle.file_entry("hafta2.pdf", 1700100000))
    assert runner.run_platform("sanal").notified == 1
    assert app.db.pending_count() == 0 and "hafta2.pdf" in app.notifier.sent[-1].text


def test_web_page_renderer_error_isolated(app, site):
    class FlakyRenderer:
        def get(self, url, wait_selector=None):  # type: ignore[no-untyped-def]
            if url.endswith("/b"):
                raise TimeoutError("Page.goto: Timeout 45000ms exceeded")
            return site.page, url

    pcfg = app.cfg.platform("web")
    pcfg.pages = [PageConfig(id="a", url=f"{WEB}/a"), PageConfig(id="b", url=f"{WEB}/b")]
    snap = WebPagesAdapter("web", pcfg, app.cfg, app.store, http=http_for(site.handler), renderer=FlakyRenderer()).fetch()
    assert "page:a" in snap.complete_scopes and "page:b" in snap.failed_scopes


def test_safe_name_byte_limit():
    name = safe_name("ğ" * 200 + ".pdf")
    assert name.endswith(".pdf") and len(name.encode("utf-8")) <= 180

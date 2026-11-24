"""2026-11-09 kod incelemesinde bulunan hataların regresyon testleri."""

from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import httpx

from unitakip.adapters.moodle import MoodleAdapter
from unitakip.adapters.webpages import extract_items
from unitakip.ai.base import AnalysisInput
from unitakip.ai.heuristic import HeuristicAnalyzer
from unitakip.config import PageConfig, PlatformConfig
from unitakip.diff import apply_snapshot
from unitakip.models import Item, Kind, Snapshot
from unitakip.notify.base import ConsoleNotifier, NotifierError
from unitakip.scheduler import App, Runner, cleanup_dry_run, prepare_dry_run, run_daemon
from unitakip.session.browser import LoginDetector, _check_session, _site_storage_state
from unitakip.storage.db import Database

from .conftest import TOKEN, WEB, emails, http_for


def _new_announcement(moodle, n: int, subject: str = "Yeni") -> None:
    moodle.discussions[50].insert(0, {"id": n, "discussion": n, "subject": f"{subject} {n}", "message": "x",
                                      "attachments": []})


class Toggle(ConsoleNotifier):
    """broken=True iken kanal hatası (NotifierError) verir."""

    def __init__(self, outbox):  # type: ignore[no-untyped-def]
        super().__init__(outbox)
        self.broken = True

    def send(self, email):  # type: ignore[no-untyped-def]
        if self.broken:
            raise NotifierError("gmail yok")
        return super().send(email)


# --- 1) bildirim kaybı -------------------------------------------------------
def test_notifications_survive_long_outage(app, moodle, cfg):
    app._notifier = Toggle(cfg.outbox_dir)
    runner = Runner(app)
    runner.run_platform("sanal")
    _new_announcement(moodle, 601)
    runner.run_platform("sanal")
    for _ in range(30):  # ~saatlerce süren kesinti
        runner._flush_backoff_until = None
        runner.flush()
    assert app.db.pending_count() == 1 and len(app.db.pending_changes()) == 1  # düşürülmedi
    app.notifier.broken = False
    runner._flush_backoff_until = None
    assert runner.flush() == 1 and app.db.pending_count() == 0


def test_flush_backoff_grows_and_caps(app, cfg):
    runner = Runner(app)
    now = app.clock()
    waits = []
    for _ in range(5):
        runner._schedule_flush_retry(now)
        waits.append(round((runner._flush_backoff_until - now).total_seconds() / 60))
    assert waits == [10, 20, 40, 60, 60]


# --- 2) çökme döngüsü --------------------------------------------------------
def test_poison_change_is_isolated_and_others_are_sent(app, moodle, monkeypatch):
    runner = Runner(app)
    runner.run_platform("sanal")
    _new_announcement(moodle, 701, "Bozuk")
    _new_announcement(moodle, 702, "Sağlam")
    original = Runner._build_digest

    def build(self, name, rows):  # type: ignore[no-untyped-def]
        if any("Bozuk" in r["title"] for r in rows):
            raise ValueError("render hatası")
        return original(self, name, rows)

    monkeypatch.setattr(Runner, "_build_digest", build)
    res = runner.run_platform("sanal")  # istisna dışarı TAŞMAMALI
    assert res.status == "ok" and app.db.pending_count() == 2
    for _ in range(3):
        runner._flush_backoff_until = None
        runner.flush()
    titles = [e.subject for e in emails(app)]
    assert len(titles) == 1 and "Sağlam" in titles[0]  # sağlam olan tek başına gönderildi
    assert app.db.pending_count() == 1  # bozuk olan kuyrukta, kaybolmadı


def test_daemon_survives_unexpected_tick_error(app, monkeypatch):
    calls = {"n": 0}

    def boom(self, now):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        raise RuntimeError("beklenmeyen")

    monkeypatch.setattr(Runner, "due_platforms", boom)
    app.cfg.tick_seconds = 0
    run_daemon(app, threading.Event(), max_ticks=3)  # istisna fırlatmadan dönmeli
    assert calls["n"] == 3


def test_gmail_attachment_read_error_is_channel_error(tmp_path, box):
    from unitakip.notify.base import Attachment, Email
    from unitakip.notify.gmail import GmailNotifier
    from unitakip.session.store import SessionStore

    n = GmailNotifier(SessionStore(tmp_path / "s", box), "ben@gmail.com")
    try:
        n.send(Email("a", "b", "c", [Attachment("yok.pdf", tmp_path / "yok.pdf")]))
    except NotifierError as exc:
        assert "eki okunamadı" in str(exc)
    else:
        raise AssertionError("NotifierError bekleniyordu")


# --- 3) kuru çalıştırma -------------------------------------------------------
def test_dry_run_does_not_touch_real_database(app, moodle, cfg, box):
    runner = Runner(app)
    runner.run_platform("sanal")
    _new_announcement(moodle, 801)
    app.close()

    tmp, db_copy = prepare_dry_run(cfg)
    dry = App(cfg, notifier=ConsoleNotifier(cfg.outbox_dir), box=box, adapter_factory=app.adapter_factory,
              db_path=db_copy, files_dir=tmp / "files")
    try:
        assert Runner(dry).run_platform("sanal").notified == 1  # .eml olarak üretildi
    finally:
        dry.close()
        cleanup_dry_run(tmp)
    assert not tmp.exists()

    real = App(cfg, notifier=ConsoleNotifier(cfg.outbox_dir), box=box, adapter_factory=app.adapter_factory)
    try:
        real_runner = Runner(real)
        res = real_runner.run_platform("sanal")
        assert res.changes == 1 and res.notified == 1  # gerçek çalıştırma değişikliği hâlâ görüyor ve gönderiyor
    finally:
        real.close()


# --- 4) giriş algılama --------------------------------------------------------
def test_login_detector_requires_logout_then_two_positives_on_same_site():
    pcfg = PlatformConfig(type="webpages", display_name="Ü", base_url="https://ubys.test/",
                          logged_out_markers=['id="loginForm"'])
    d = LoginDetector(pcfg)
    assert not d.feed("<div>yükleniyor</div>", "https://ubys.test/")  # henüz giriş sayfası görülmedi
    assert not d.feed('<form id="loginForm">', "https://ubys.test/")
    assert not d.feed("<div>e-Devlet</div>", "https://giris.turkiye.gov.tr/")  # başka alan adı sayılmaz
    assert not d.feed("<div>Panel</div>", "https://ubys.test/Home")
    assert d.feed("<div>Panel</div>", "https://ubys.test/Home")


def test_session_check_rejects_unfinished_sso_and_checks_the_school_response():
    cfg = PlatformConfig(type="webpages", display_name="ÜBYS", base_url="https://ubys.test/",
                         logged_out_markers=['id="loginForm"'])
    context = Mock()
    redirect = Mock(status=302, headers={"location": "https://idp.test/login"})
    context.request.get.return_value = redirect
    assert not _check_session(context, cfg)
    context.request.get.assert_called_once_with(cfg.base_url, max_redirects=0, timeout=10000)
    redirect.dispose.assert_called_once()

    school = Mock(status=200, ok=True, headers={})
    context.request.get.return_value = school
    school.text.return_value = '<form id="loginForm">'
    assert not _check_session(context, cfg)
    school.text.return_value = '<main>Öğrenci ekranı</main>'
    assert _check_session(context, cfg)


def test_school_storage_excludes_sso_provider_state():
    cfg = PlatformConfig(type="webpages", display_name="ÜBYS", base_url="https://ubys.school.test/")
    school_cookie = {"domain": "ubys.school.test", "name": "session"}
    school_origin = {"origin": "https://ubys.school.test", "localStorage": []}
    context = Mock()
    context.storage_state.return_value = {
        "cookies": [school_cookie, {"domain": ".turkiye.gov.tr", "name": "sso"}],
        "origins": [school_origin, {"origin": "https://giris.turkiye.gov.tr", "localStorage": []}],
    }
    assert _site_storage_state(context, cfg) == {"cookies": [school_cookie], "origins": [school_origin]}


# --- 5) süresi dolmuş token ---------------------------------------------------
def test_expired_token_accessexception_triggers_renewal(app, moodle):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("server.php") and b"wstoken=eski" in req.content:
            return httpx.Response(200, json={"exception": "webservice_access_exception",
                                             "errorcode": "accessexception", "message": "token expired"})
        return moodle.handler(req)

    pcfg = app.cfg.platform("sanal")
    pcfg.auto_relogin = True
    app.store.save("sanal.token", {"token": "eski"})
    app.store.save("sanal.credentials", {"username": "ogrenci", "password": "dogru-parola"})
    snap = MoodleAdapter("sanal", pcfg, app.cfg, app.store, http=http_for(handler)).fetch()
    assert snap.items and app.store.load("sanal.token")["token"] == TOKEN


# --- 6) değişken satır filtresi -------------------------------------------------
def test_volatile_filter_keeps_real_content_drops_timestamps():
    page = PageConfig(id="t", url=f"{WEB}/", ignore_patterns=[r"^Sayaç:"])
    html = ("<p>Online sınav 20 Kasım'da yapılacak.</p><p>Çevrimiçi ders linki eklendi.</p>"
            "<p>Son giriş: 09.11.2026 13:12</p><p>12 kullanıcı çevrimiçi</p><p>09.11.2026 13:12</p>"
            "<p>Sayaç: 4521</p>")
    text = next(i for i in extract_items("u", page, html, WEB, []) if i.kind == Kind.PAGE).data["text"]
    assert "Online sınav 20 Kasım'da yapılacak." in text and "Çevrimiçi ders linki eklendi." in text
    for noise in ("Son giriş", "kullanıcı çevrimiçi", "13:12", "Sayaç"):
        assert noise not in text


# --- 7) tablo satır kimliği ---------------------------------------------------
def _rows(html: str, kind: str = "grade") -> list[Item]:
    page = PageConfig(id="n", url=f"{WEB}/", kind=kind)
    return [i for i in extract_items("u", page, html, WEB, []) if not i.external_id.endswith(":text")]


def test_row_header_th_is_kept():
    [row] = _rows("<table><tr><th>Ders</th><th>Not</th></tr><tr><th>Vize</th><td>70</td></tr></table>")
    assert row.data["cells"] == {"Ders": "Vize", "Not": "70"} and row.title == "Vize"


def test_grade_change_in_second_column_is_update_not_new():
    before = ("<table><tr><th>Ders</th><th>Vize</th><th>Final</th></tr>"
              "<tr><td>Tarih</td><td>-</td><td>-</td></tr><tr><td>Fizik</td><td>-</td><td>-</td></tr></table>")
    after = before.replace("<td>Tarih</td><td>-</td>", "<td>Tarih</td><td>85</td>")
    db = Database(":memory:")
    t0 = datetime(2026, 11, 9, tzinfo=UTC)

    def snap(html: str) -> Snapshot:
        s = Snapshot(platform="u", items=_rows(html))
        s.ok("page:n")
        return s

    apply_snapshot(db, snap(before), t0)
    changes = apply_snapshot(db, snap(after), t0 + timedelta(hours=1))
    assert [(c.change_type, c.item.title) for c in changes] == [("updated", "Tarih")]
    assert changes[0].summary == "Vize: - → 85"


def test_row_number_column_is_not_used_as_identity():
    html = ("<table><tr><th>No</th><th>Ders</th><th>Devamsızlık</th></tr>"
            "<tr><td>1</td><td>Tarih</td><td>2</td></tr><tr><td>2</td><td>Fizik</td><td>0</td></tr></table>")
    reordered = ("<table><tr><th>No</th><th>Ders</th><th>Devamsızlık</th></tr>"
                 "<tr><td>1</td><td>Fizik</td><td>0</td></tr><tr><td>2</td><td>Tarih</td><td>2</td></tr></table>")
    by_title = {r.title: r.external_id for r in _rows(html, "attendance")}
    by_title2 = {r.title: r.external_id for r in _rows(reordered, "attendance")}
    assert by_title == by_title2 and set(by_title) == {"Tarih", "Fizik"}


def test_nested_tables_do_not_duplicate_rows():
    html = ("<table id='dis'><tr><th>A</th></tr><tr><td><table id='ic'><tr><th>Ders</th><th>Not</th></tr>"
            "<tr><td>Kimya</td><td>60</td></tr></table></td></tr></table>")
    rows = _rows(html)
    assert sum(1 for r in rows if "Kimya" in r.text) == 1


# --- 8) önem derecesi ---------------------------------------------------------
def test_lecture_notes_are_not_high_priority():
    h = HeuristicAnalyzer()
    a = h.analyze(AnalysisInput("S", Kind.FILE, "new", "Ders Notu 1 - Hafta 3", "Fizik", None, "", None))
    assert a.importance == "orta"
    b = h.analyze(AnalysisInput("S", Kind.ANNOUNCEMENT, "new", "Vize notlar açıklandı", "Fizik", None, "", None))
    assert b.importance == "yüksek"


# --- 9) not sayfası metni hassas -------------------------------------------------
def test_grade_page_text_is_sensitive():
    page = PageConfig(id="n", url=f"{WEB}/", kind="grade")
    [item] = extract_items("u", page, "<p>Genel ortalama: 2,85</p>", WEB, [])
    assert item.kind == Kind.GRADE


# --- not: yerel saat ve tekrar eden tarih satırı ---------------------------------
def test_diff_summary_uses_local_time_without_duplicate_due_line():
    db = Database(":memory:")
    t0 = datetime(2026, 11, 9, tzinfo=UTC)
    due1, due2 = datetime(2026, 11, 20, 20, 59, tzinfo=UTC), datetime(2026, 11, 21, 20, 59, tzinfo=UTC)

    def snap(due: datetime) -> Snapshot:
        it = Item(platform="p", external_id="a", kind=Kind.ASSIGNMENT, title="Ödev", scope="s", due_at=due,
                  data={"duedate": int(due.timestamp())})
        s = Snapshot(platform="p", items=[it])
        s.ok("s")
        return s

    apply_snapshot(db, snap(due1), t0)
    [ch] = apply_snapshot(db, snap(due2), t0 + timedelta(hours=1))
    assert ch.summary == "Teslim tarihi: 20.11.2026 23:59 → 21.11.2026 23:59"  # İstanbul saati, tek satır


def test_download_existing_files_option(app, moodle):
    app.cfg.platform("sanal").download_existing_files = True
    Runner(app).run_platform("sanal")
    assert moodle.downloads == ["hafta1.pdf"]  # baseline dosyası bildirimsiz arşivlendi
    assert emails(app) == []

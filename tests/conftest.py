"""Ortak test düzeneği: sahte Moodle sunucusu, sahte web sitesi, geçici uygulama bağlamı."""

from __future__ import annotations

import json
import urllib.parse
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from unitakip.adapters.moodle import READ_ONLY_FUNCTIONS, MoodleAdapter
from unitakip.adapters.webpages import WebPagesAdapter
from unitakip.config import AIConfig, AppConfig, HttpConfig, NotifyConfig, PageConfig, PlatformConfig
from unitakip.crypto import SecretBox
from unitakip.http import HttpClient
from unitakip.models import utcnow
from unitakip.notify.base import ConsoleNotifier

ROOT = "https://sanal.test"
WEB = "https://web.test"
TOKEN = "local-test-fixture"


def _now_ts(days: int = 0) -> int:
    return int((utcnow() + timedelta(days=days)).timestamp())


class FakeMoodle:
    """core_* / mod_* WS yanıtlarını Moodle belgelerindeki yapıyla üretir."""

    def __init__(self) -> None:
        self.valid = True
        self.calls: list[str] = []
        self.downloads: list[str] = []
        self.functions = sorted(READ_ONLY_FUNCTIONS)
        self.fail_functions: set[str] = set()
        self.courses = [{"id": 10, "fullname": "Matematik I", "shortname": "MAT101", "enddate": 0, "visible": 1}]
        self.files = {"hafta1.pdf": b"%PDF-1.4 sahte icerik"}
        self.sections = {10: [{
            "id": 100, "name": "1. Hafta", "section": 1, "summary": "<p>Giriş konuları</p>", "visible": 1,
            "uservisible": True,
            "modules": [
                {"id": 1000, "name": "Ders Notu 1", "modname": "resource", "visible": 1, "uservisible": True,
                 "url": f"{ROOT}/mod/resource/view.php?id=1000",
                 "contents": [self.file_entry("hafta1.pdf", 1700000000)]},
                {"id": 1001, "name": "Ödev 1", "modname": "assign", "visible": 1, "uservisible": True,
                 "url": f"{ROOT}/mod/assign/view.php?id=1001", "contents": []},
            ],
        }]}
        self.forums = [{"id": 50, "course": 10, "type": "news", "name": "Duyurular", "cmid": 1002}]
        self.discussions = {50: [{"id": 500, "discussion": 500, "subject": "Hoş geldiniz",
                                  "message": "<p>Derse hoş geldiniz.</p>", "userfullname": "Dr. Hoca",
                                  "attachments": []}]}
        self.assignments = [{"id": 70, "cmid": 1001, "course": 10, "name": "Ödev 1", "duedate": _now_ts(10),
                             "cutoffdate": 0, "allowsubmissionsfromdate": 0, "intro": "<p>Problem seti 1</p>",
                             "introattachments": []}]
        self.quizzes: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []
        self.grades = {10: [{"id": 900, "itemname": "Vize", "itemtype": "mod", "gradeformatted": "-",
                             "percentageformatted": "-", "rangeformatted": "0–100", "feedback": ""},
                            {"id": 901, "itemname": None, "itemtype": "course", "gradeformatted": "-"}]}

    def file_entry(self, name: str, tm: int) -> dict[str, Any]:
        return {"type": "file", "filename": name, "filepath": "/", "filesize": len(self.files.get(name, b"x")),
                "fileurl": f"{ROOT}/webservice/pluginfile.php/5/mod_resource/content/1/{name}",
                "timemodified": tm, "mimetype": "application/pdf"}

    # ---------------------------------------------------------------- dağıtıcı
    def dispatch(self, fn: str, form: dict[str, str]) -> Any:
        if fn == "core_webservice_get_site_info":
            return {"sitename": "Sanal Öğrenme", "userid": 42, "fullname": "Test Öğrenci", "release": "5.3",
                    "functions": [{"name": f, "version": "1"} for f in self.functions]}
        if fn == "core_course_get_enrolled_courses_by_timeline_classification":
            return {"courses": self.courses, "nextoffset": 0}
        if fn == "core_enrol_get_users_courses":
            return self.courses
        if fn == "core_course_get_contents":
            return self.sections.get(int(form["courseid"]), [])
        if fn == "mod_forum_get_forums_by_courses":
            return self.forums
        if fn == "mod_forum_get_forum_discussions":
            return {"discussions": self.discussions.get(int(form["forumid"]), []), "warnings": []}
        if fn == "mod_assign_get_assignments":
            return {"courses": [{"id": c["id"], "fullname": c["fullname"],
                                 "assignments": [a for a in self.assignments if a["course"] == c["id"]]}
                                for c in self.courses], "warnings": []}
        if fn == "mod_quiz_get_quizzes_by_courses":
            return {"quizzes": self.quizzes, "warnings": []}
        if fn == "core_calendar_get_calendar_events":
            return {"events": self.events, "warnings": []}
        if fn == "gradereport_user_get_grade_items":
            cid = int(form["courseid"])
            return {"usergrades": [{"courseid": cid, "userid": 42, "gradeitems": self.grades.get(cid, [])}]}
        if fn == "message_popup_get_popup_notifications":
            return {"notifications": [], "unreadcount": 0}
        raise AssertionError(f"beklenmeyen fonksiyon {fn}")

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/login/token.php"):
            form = dict(urllib.parse.parse_qsl(request.content.decode()))
            if form.get("username") == "ogrenci" and form.get("password") == "dogru-parola":
                return httpx.Response(200, json={"token": TOKEN, "privatetoken": "p" * 64})
            return httpx.Response(200, json={"error": "Geçersiz giriş", "errorcode": "invalidlogin"})
        if path.endswith("/webservice/rest/server.php"):
            form = dict(urllib.parse.parse_qsl(request.content.decode()))
            if form.get("wstoken") != TOKEN or not self.valid:
                return httpx.Response(200, json={"exception": "moodle_exception", "errorcode": "invalidtoken",
                                                 "message": "Geçersiz dizgecik"})
            fn = form["wsfunction"]
            self.calls.append(fn)
            if fn in self.fail_functions:
                return httpx.Response(200, json={"exception": "x", "errorcode": "nopermissions", "message": "yok"})
            return httpx.Response(200, json=self.dispatch(fn, form))
        if "/webservice/pluginfile.php/" in path:
            if request.url.params.get("token") != TOKEN or not self.valid:
                return httpx.Response(200, headers={"Content-Type": "application/json"},
                                      content=b'{"error":"invalidtoken"}')
            name = path.rsplit("/", 1)[-1]
            self.downloads.append(name)
            return httpx.Response(200, headers={"Content-Type": "application/pdf"}, content=self.files[name])
        return httpx.Response(404)


class FakeWebSite:
    """Oturum çerezi isteyen basit PHP benzeri site."""

    LOGIN = ('<html><body><form method="post" class="login-form"><input name="kullaniciadi">'
             '<input type="password" name="sifre"></form></body></html>')

    def __init__(self) -> None:
        self.session_ok = True
        self.page = ("<html><body><nav>Menü Çıkış</nav><h1>Derslerim</h1>"
                     "<table id='notlar'><tr><th>Ders</th><th>Vize</th><th>Final</th></tr>"
                     "<tr><td>Tarih</td><td>70</td><td>-</td></tr></table>"
                     "<p>Yeni dönem başladı.</p><p>3 dakika önce güncellendi</p>"
                     "<a href='/dosya/Ders_Silabusu.pdf'>Silabus</a>"
                     "<a href='/index.php?do=sil&id=4'>Sil</a></body></html>")
        self.logins = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        cookie = request.headers.get("cookie", "")
        if request.method == "POST":
            form = dict(urllib.parse.parse_qsl(request.content.decode()))
            if form.get("kullaniciadi") == "a@b.c" and form.get("sifre") == "pw":
                self.logins += 1
                self.session_ok = True
                return httpx.Response(200, headers={"Set-Cookie": "PHPSESSID=yeni; Path=/"}, text="ok")
            return httpx.Response(200, text=self.LOGIN)
        if not self.session_ok or "PHPSESSID" not in cookie:
            return httpx.Response(200, text=self.LOGIN)
        if request.url.path.endswith(".pdf"):
            return httpx.Response(200, headers={"Content-Type": "application/pdf"}, content=b"%PDF silabus")
        return httpx.Response(200, text=self.page)


def http_for(handler) -> HttpClient:  # type: ignore[no-untyped-def]
    cfg = HttpConfig(min_request_interval_seconds=0, max_retries=1, timeout_seconds=5)
    return HttpClient(cfg, transport=httpx.MockTransport(handler), sleep=lambda s: None)


@pytest.fixture
def box() -> SecretBox:
    return SecretBox(SecretBox.generate_key())


@pytest.fixture
def cfg(tmp_path: Path) -> AppConfig:
    return AppConfig(
        data_dir=tmp_path / "data",
        jitter_minutes=0,
        http=HttpConfig(min_request_interval_seconds=0, max_retries=1, timeout_seconds=5),
        platforms={
            "sanal": PlatformConfig(type="moodle", display_name="Sanal Öğrenme", base_url=ROOT),
            "web": PlatformConfig(
                type="webpages", display_name="Web Sitesi", base_url=f"{WEB}/", login_url=f"{WEB}/index.php",
                logged_out_markers=['name="sifre"'], session_check_url=f"{WEB}/index.php",
                login_form={"kullaniciadi": "{username}", "sifre": "{password}", "remember": "on"},
                pages=[PageConfig(id="ana", url=f"{WEB}/index.php", kind="grade")],
                file_extensions=["pdf"],
            ),
        },
        notify=NotifyConfig(provider="console", to="ben@example.com", unreachable_after_failures=2,
                            status_report="off"),  # durum e-postası testlerde ayrıca, sabit saatle sınanıyor
        ai=AIConfig(),
    )


@pytest.fixture
def moodle() -> FakeMoodle:
    return FakeMoodle()


@pytest.fixture
def site() -> FakeWebSite:
    return FakeWebSite()


@pytest.fixture
def app(cfg: AppConfig, box: SecretBox, moodle: FakeMoodle, site: FakeWebSite):  # type: ignore[no-untyped-def]
    from unitakip.scheduler import App

    def factory(a, name):  # type: ignore[no-untyped-def]
        pcfg = a.cfg.platform(name)
        if pcfg.type == "moodle":
            return MoodleAdapter(name, pcfg, a.cfg, a.store, http=http_for(moodle.handler))
        return WebPagesAdapter(name, pcfg, a.cfg, a.store, http=http_for(site.handler))

    application = App(cfg, notifier=ConsoleNotifier(cfg.outbox_dir, cfg.notify.to), adapter_factory=factory, box=box)
    application.store.save("sanal.token", {"token": TOKEN, "username": "ogrenci"})
    application.store.save("web.session", {"storage_state": {"cookies": [
        {"name": "PHPSESSID", "value": "eski", "domain": "web.test", "path": "/"}], "origins": []},
        "user_agent": "test"})
    yield application
    application.close()


def emails(app) -> list:  # type: ignore[no-untyped-def]
    return app.notifier.sent


def dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)

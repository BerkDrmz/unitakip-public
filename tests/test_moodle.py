"""Moodle adaptörü: sahte WS sunucusuna karşı."""

from __future__ import annotations

import pytest

from unitakip.adapters.base import AuthExpired, AuthMissing, LoginFailed
from unitakip.adapters.moodle import MoodleAdapter, obtain_token
from unitakip.models import Kind, RemoteFile

from .conftest import ROOT, TOKEN, http_for


def make(app, moodle) -> MoodleAdapter:  # type: ignore[no-untyped-def]
    return MoodleAdapter("sanal", app.cfg.platform("sanal"), app.cfg, app.store, http=http_for(moodle.handler))


def test_fetch_builds_expected_items(app, moodle):
    snap = make(app, moodle).fetch()
    by_kind: dict = {}
    for it in snap.items:
        by_kind.setdefault(it.kind, []).append(it)
    assert {i.external_id for i in by_kind[Kind.COURSE]} == {"moodle:course:10"}
    assert by_kind[Kind.SECTION][0].data["summary"] == "Giriş konuları"
    f = by_kind[Kind.FILE][0]
    assert f.external_id == "moodle:file:1000:/hafta1.pdf" and f.version == "1700000000:21"
    assert f.url.startswith(f"{ROOT}/pluginfile.php") and "token" not in f.url
    assert by_kind[Kind.ANNOUNCEMENT][0].text == "Derse hoş geldiniz."
    assert by_kind[Kind.ASSIGNMENT][0].due_at is not None
    # ödev modülü ayrıca 'module' olarak tekrarlanmaz (mod_assign ile işleniyor)
    assert "moodle:cm:1001" not in {i.external_id for i in snap.items}
    grades = {i.title for i in by_kind[Kind.GRADE]}
    assert grades == {"Vize", "Ders toplamı"}
    assert {"courses", "course:10:contents", "course:10:grades", "course:10:assign"} <= snap.complete_scopes
    assert "forum:50" in snap.partial_scopes and "calendar" in snap.partial_scopes


def test_only_listed_functions_are_called(app, moodle):
    moodle.functions = ["core_webservice_get_site_info", "core_enrol_get_users_courses", "core_course_get_contents"]
    snap = make(app, moodle).fetch()
    assert set(moodle.calls) <= set(moodle.functions)
    # mod_assign yoksa ödev, modül kaydı olarak (tür: ödev) yine izlenir
    assert any(i.kind == Kind.ASSIGNMENT and i.external_id == "moodle:cm:1001" for i in snap.items)


def test_scope_failure_does_not_abort(app, moodle):
    moodle.fail_functions = {"gradereport_user_get_grade_items"}
    snap = make(app, moodle).fetch()
    assert "course:10:grades" in snap.failed_scopes
    assert any(i.kind == Kind.FILE for i in snap.items)


def test_invalid_token_raises_auth_expired(app, moodle):
    moodle.valid = False
    with pytest.raises(AuthExpired):
        make(app, moodle).fetch()


def test_missing_token(app, moodle):
    app.store.delete("sanal.token")
    with pytest.raises(AuthMissing):
        make(app, moodle).fetch()


def test_auto_renew_with_stored_credentials(app, moodle):
    pcfg = app.cfg.platform("sanal")
    pcfg.auto_relogin = True
    app.store.save("sanal.token", {"token": "eski-gecersiz-token"})
    app.store.save("sanal.credentials", {"username": "ogrenci", "password": "dogru-parola"})
    snap = make(app, moodle).fetch()
    assert snap.items and app.store.load("sanal.token")["token"] == TOKEN


def test_obtain_token():
    from .conftest import FakeMoodle
    fake = FakeMoodle()
    tok = obtain_token(http_for(fake.handler), ROOT, "ogrenci", "dogru-parola", "moodle_mobile_app")
    assert tok["token"] == TOKEN
    with pytest.raises(LoginFailed):
        obtain_token(http_for(fake.handler), ROOT, "ogrenci", "yanlis", "moodle_mobile_app")


def test_download_appends_token_and_detects_rejection(app, moodle, tmp_path):
    adapter = make(app, moodle)
    rf = RemoteFile(url=f"{ROOT}/webservice/pluginfile.php/5/mod_resource/content/1/hafta1.pdf", filename="hafta1.pdf")
    res = adapter.download(rf, tmp_path / "a.part", 10_000)
    assert res.size == len(moodle.files["hafta1.pdf"]) and moodle.downloads == ["hafta1.pdf"]
    moodle.valid = False
    with pytest.raises(AuthExpired):
        adapter.download(rf, tmp_path / "b.part", 10_000)
    assert not (tmp_path / "b.part").exists()


def test_session_mode_ajax_transport(app, moodle):
    """Yedek mod: tarayıcı oturumu + sesskey ile lib/ajax/service.php."""
    import json as _json

    import httpx

    state = {"sesskey_calls": 0, "expired": False}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/my/":
            if state["expired"]:
                return httpx.Response(200, text="<form>giriş</form>", request=request,
                                      headers={"Content-Location": "/login/index.php"})
            state["sesskey_calls"] += 1
            return httpx.Response(200, text=f'M.cfg = {{"sesskey":"sk{state["sesskey_calls"]}","userId":42}};')
        if request.url.path == "/lib/ajax/service.php":
            body = _json.loads(request.content)[0]
            if request.url.params["sesskey"] == "sk1":  # ilk sesskey bayatlamış olsun
                return httpx.Response(200, json=[{"error": True, "exception": {"errorcode": "invalidsesskey"}}])
            if body["methodname"] == "core_course_get_enrolled_courses_by_timeline_classification":
                return httpx.Response(200, json=[{"error": False, "data": {"courses": moodle.courses}}])
            return httpx.Response(200, json=[{"error": True, "exception": {"errorcode": "servicenotavailable"}}])
        return httpx.Response(404)

    pcfg = app.cfg.platform("sanal").model_copy(update={"auth_mode": "session"})
    pcfg.features.grades = False
    app.store.save("sanal.session", {"storage_state": {"cookies": [
        {"name": "MoodleSession", "value": "abc", "domain": "sanal.test", "path": "/"}]}, "user_agent": "x"})
    adapter = MoodleAdapter("sanal", pcfg, app.cfg, app.store, http=http_for(handler))
    snap = adapter.fetch()
    assert [i.external_id for i in snap.items] == ["moodle:course:10"]
    assert state["sesskey_calls"] == 2  # bayat sesskey otomatik yenilendi
    assert "course:10:contents" in snap.failed_scopes  # ajax ile açılmayan fonksiyon kapsam hatası olur

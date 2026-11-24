"""Genel web sayfası adaptörü."""

from __future__ import annotations

import pytest

from unitakip.adapters.base import AuthExpired
from unitakip.adapters.webpages import WebPagesAdapter, extract_items
from unitakip.config import PageConfig
from unitakip.models import Kind

from .conftest import WEB, FakeWebSite, http_for


def test_extract_tables_files_text():
    page = PageConfig(id="ana", url=f"{WEB}/index.php", kind="grade", course_name=None)
    items = extract_items("web", page, FakeWebSite().page, f"{WEB}/index.php", ["pdf"])
    rows = [i for i in items if i.kind == Kind.GRADE and not i.external_id.endswith(":text")]
    assert len(rows) == 1 and rows[0].data["cells"] == {"Ders": "Tarih", "Vize": "70", "Final": "-"}
    files = [i for i in items if i.kind == Kind.FILE]
    assert [f.files[0].url for f in files] == [f"{WEB}/dosya/Ders_Silabusu.pdf"]
    text_item = next(i for i in items if i.external_id.endswith(":text"))
    assert text_item.kind == Kind.GRADE  # not sayfasının metni de hassas: harici AI'ya gitmez
    text = text_item.data["text"]
    assert "Yeni dönem başladı." in text
    assert "dakika önce" not in text  # değişken satır ayıklandı
    assert "Menü" not in text  # nav kaldırıldı


def test_row_identity_is_content_based():
    page = PageConfig(id="p", url=f"{WEB}/", kind="grade")
    html1 = "<table><tr><th>Ders</th><th>Not</th></tr><tr><td>A</td><td>-</td></tr><tr><td>B</td><td>-</td></tr></table>"
    html2 = "<table><tr><th>Ders</th><th>Not</th></tr><tr><td>B</td><td>-</td></tr><tr><td>A</td><td>-</td></tr></table>"
    ids1 = {i.external_id for i in extract_items("w", page, html1, WEB, [])}
    ids2 = {i.external_id for i in extract_items("w", page, html2, WEB, [])}
    assert ids1 == ids2  # sıralama değişince kimlik değişmez


def make(app, site) -> WebPagesAdapter:  # type: ignore[no-untyped-def]
    return WebPagesAdapter("web", app.cfg.platform("web"), app.cfg, app.store, http=http_for(site.handler))


def test_fetch_and_session_loss(app, site):
    snap = make(app, site).fetch()
    assert "page:ana" in snap.complete_scopes and snap.items
    site.session_ok = False
    with pytest.raises(AuthExpired):
        make(app, site).fetch()


def test_auto_relogin_only_when_allowed(app, site):
    site.session_ok = False
    app.store.save("web.credentials", {"username": "a@b.c", "password": "pw"})
    with pytest.raises(AuthExpired):  # auto_relogin kapalı
        make(app, site).fetch()
    app.cfg.platform("web").auto_relogin = True
    snap = make(app, site).fetch()
    assert site.logins == 1 and snap.items
    saved = app.store.load("web.session")["storage_state"]["cookies"]
    assert any(c["name"] == "PHPSESSID" and c["value"] == "yeni" for c in saved)


def test_keepalive(app, site):
    assert make(app, site).keepalive() is True
    site.session_ok = False
    assert make(app, site).keepalive() is False

"""GitHub'dan kurulum: değişken site sayısı, Git dışı yerel site dosyası ve bulut paketi."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from unitakip.config import PROJECT_ROOT, ConfigError, load_config

CLOUD = PROJECT_ROOT / "cloud" / "cloudflare"


def _module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, CLOUD / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = _module("unitakip_prepare", "prepare.py")
refresh = _module("unitakip_refresh", "refresh-session.py")


class FakeStore:
    def __init__(self, values: dict):
        self.values = values

    def load(self, name: str):
        return self.values.get(name)


def _config(tmp_path: Path, body: str, local: str | None = None):
    (tmp_path / "config").mkdir(exist_ok=True)
    (tmp_path / "config" / "config.yaml").write_text(body, encoding="utf-8")
    if local is not None:
        (tmp_path / "config" / "sites.local.yaml").write_text(local, encoding="utf-8")
    return load_config(tmp_path / "config" / "config.yaml")


BASE = (
    "notify:\n  to: ogrenci@example.com\n"
    "platforms:\n"
    "  ders:\n    type: moodle\n    display_name: Ders\n    base_url: https://lms.ornek-universite.edu.tr/\n"
    "  kapali:\n    enabled: false\n    type: webpages\n    display_name: Kapalı\n    base_url: https://obs.ornek-universite.edu.tr/\n"
)


def test_local_sites_extend_and_override(tmp_path, monkeypatch):
    monkeypatch.delenv("UNITAKIP_DATA_DIR", raising=False)
    cfg = _config(tmp_path, BASE, "platforms:\n  kapali:\n    enabled: true\n"
                  "  duyuru:\n    type: webpages\n    display_name: Duyuru\n    base_url: https://ornek-universite.edu.tr/duyurular\n")
    assert set(cfg.enabled_platforms()) == {"ders", "kapali", "duyuru"}
    assert cfg.platform("kapali").display_name == "Kapalı"  # yalnızca verilen alan ezildi


def test_local_sites_invalid(tmp_path, monkeypatch):
    monkeypatch.delenv("UNITAKIP_DATA_DIR", raising=False)
    with pytest.raises(ConfigError):
        _config(tmp_path, BASE, "platforms:\n  - yanlis\n")
    with pytest.raises(ConfigError):
        _config(tmp_path, BASE, "platforms:\n  x:\n    type: ftp\n")


def test_cloud_package_variable_sites_without_secrets_in_report(tmp_path, monkeypatch):
    monkeypatch.delenv("UNITAKIP_DATA_DIR", raising=False)
    body = BASE + (
        "  duyuru:\n    type: webpages\n    display_name: Duyuru\n    base_url: https://ornek-universite.edu.tr/\n"
        "  eski:\n    type: webpages\n    display_name: Eski\n    base_url: http://eski.ornek-universite.edu.tr/\n"
    )
    cfg = _config(tmp_path, body)
    store = FakeStore({
        "gmail.smtp": {"username": "gonderen@example.com", "password": "uygulama-sifresi"},
        "ders.token": {"token": "GIZLI-TOKEN"},
        "duyuru.session": {"storage_state": {"cookies": [
            {"name": "s", "value": "GIZLI-CEREZ", "domain": "ornek-universite.edu.tr"},
            {"name": "x", "value": "BASKA", "domain": "baska-site.example"},
        ]}, "user_agent": "UA"},
    })
    cloud, report = prepare.build_cloud_config(cfg, store)
    assert set(cloud["platforms"]) == {"ders", "duyuru"}  # kapalı ve https olmayan dışarıda
    assert cloud["platforms"]["ders"]["base_url"] == "https://lms.ornek-universite.edu.tr"
    assert cloud["platforms"]["ders"]["token"] == "GIZLI-TOKEN"
    assert [c["name"] for c in cloud["platforms"]["duyuru"]["cookies"]] == ["s"]  # ilgisiz alan adı çerezi yok
    assert "login_form" not in json.dumps(cloud)
    states = {entry["id"]: entry for entry in report}
    assert states["eski"]["skipped"] and states["ders"]["credentials"] == "token"
    assert "GIZLI" not in json.dumps(report)  # özet gizli değer taşımaz

    # Giriş bilgisi olmayan site atlanmaz; panelde "Giriş gerekli" görünür
    cloud, report = prepare.build_cloud_config(cfg, FakeStore({"gmail.smtp": store.values["gmail.smtp"]}))
    assert "token" not in cloud["platforms"]["ders"] and "cookies" not in cloud["platforms"]["duyuru"]


def test_cloud_package_zero_sites_and_secrets_file(tmp_path, monkeypatch):
    monkeypatch.delenv("UNITAKIP_DATA_DIR", raising=False)
    cfg = _config(tmp_path, "notify:\n  to: ogrenci@example.com\nplatforms: {}\n")
    cloud, report = prepare.build_cloud_config(cfg, FakeStore({"gmail.smtp": {"username": "a@example.com", "password": "p"}}))
    assert cloud["platforms"] == {} and report == []
    path = prepare.write_secrets(tmp_path / "out", cloud)
    first = json.loads(path.read_text())
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert json.loads("".join(first[f"CONFIG_{i}"] for i in range(int(first["CONFIG_PARTS"])))) == cloud
    again = json.loads(prepare.write_secrets(tmp_path / "out", cloud).read_text())
    assert again["STATE_KEY"] == first["STATE_KEY"] and again["ADMIN_TOKEN"] == first["ADMIN_TOKEN"]  # anahtarlar korunur
    with pytest.raises(ValueError):
        prepare.build_cloud_config(cfg, FakeStore({}))  # SMTP olmadan paket yok


def test_refresh_uses_project_venv_even_when_interpreters_share_binary(tmp_path, monkeypatch):
    python = tmp_path / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.symlink_to(refresh.sys.executable)
    monkeypatch.setattr(refresh, "ROOT", tmp_path)
    calls = []
    monkeypatch.setattr(refresh.os, "execv", lambda path, args: calls.append((path, args)))

    refresh._reexec_in_venv()
    assert calls == [(str(python), [str(python), refresh.__file__, *refresh.sys.argv[1:]])]

    monkeypatch.setattr(refresh.sys, "prefix", str(tmp_path / ".venv"))
    refresh._reexec_in_venv()
    assert len(calls) == 1


def test_refresh_session_plan(tmp_path, monkeypatch):
    monkeypatch.delenv("UNITAKIP_DATA_DIR", raising=False)
    cfg = _config(tmp_path, BASE)
    assert refresh.plan_local_change(cfg, "ders", None, None, None) is None
    assert refresh.plan_local_change(cfg, "kapali", None, None, None) == {"enabled": True}
    entry = refresh.plan_local_change(cfg, "bolum-duyurulari", "webpages", "https://muhendislik.ornek-universite.edu.tr/duyurular", None)
    assert entry["base_url"].endswith("/duyurular") and entry["enabled"] is True and "pages" not in entry
    for bad in ("http://ornek.edu.tr/", "https://ornek.edu.tr/?ogrenci=123", "https://kullanici:sifre@ornek.edu.tr/"):
        with pytest.raises(ValueError):
            refresh.plan_local_change(cfg, "yeni", "webpages", bad, None)
    with pytest.raises(ValueError):
        refresh.plan_local_change(cfg, "Büyük Harf", "webpages", "https://ornek.edu.tr/", None)
    with pytest.raises(ValueError):
        refresh.plan_local_change(cfg, "yok", None, None, None)  # yerelde yoksa tür ve adres gerekir
    with pytest.raises(ValueError):
        refresh.plan_local_change(cfg, "ders", None, "https://baska.ornek.edu.tr/", None)  # adres çakışması

    path = refresh.write_local_site(tmp_path / "config", "bolum-duyurulari", entry)
    refresh.write_local_site(tmp_path / "config", "kapali", {"enabled": True})
    cfg = load_config(tmp_path / "config" / "config.yaml")
    assert {"ders", "kapali", "bolum-duyurulari"} <= set(cfg.enabled_platforms())
    assert path.read_text(encoding="utf-8").startswith("# Panelde eklenen")


def test_refresh_adds_ubys_login_markers_to_new_and_existing_panel_sites(tmp_path):
    cfg = _config(tmp_path, BASE + (
        "  obs:\n    type: webpages\n    display_name: ÜBYS\n    base_url: https://ubys.bartin.edu.tr/\n"
    ))
    existing = refresh.plan_local_change(cfg, "obs", None, None, None)
    new = refresh.plan_local_change(cfg, "obs-yeni", "webpages", "https://ubys.bartin.edu.tr/", None)
    assert existing["login_url"] == existing["session_check_url"] == "https://ubys.bartin.edu.tr/"
    assert existing["logged_out_markers"] == new["logged_out_markers"] == ['id="loginForm"', 'data-ajax-url="/Account/Login"']


def test_example_files_have_no_personal_paths():
    for path in [PROJECT_ROOT / "config" / "config.example.yaml", PROJECT_ROOT / "README.md", CLOUD / "README.md"]:
        text = path.read_text(encoding="utf-8")
        assert "/Volumes/" not in text and "/Users/" not in text, path
        assert ".workers.dev" not in text.replace("<hesap-adın>.workers.dev", "").replace("<alt-alan-adın>.workers.dev", ""), path

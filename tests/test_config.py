"""Yapılandırma yükleme."""

from __future__ import annotations

from pathlib import Path
from shutil import copyfile

import pytest

from unitakip.cli import build_parser
from unitakip.config import PROJECT_ROOT, ConfigError, load_config


def test_example_config_is_valid(tmp_path, monkeypatch):
    monkeypatch.setenv("UNITAKIP_NOTIFY_TO", "ben@gmail.com")
    monkeypatch.setenv("UNITAKIP_DATA_DIR", str(tmp_path / "d"))
    clean_config = tmp_path / "config" / "config.yaml"
    clean_config.parent.mkdir()
    copyfile(PROJECT_ROOT / "config" / "config.example.yaml", clean_config)
    cfg = load_config(clean_config)
    assert set(cfg.platforms) == {"sanal", "ogreniyorum", "ubys"}
    # Bartın şablonları isteğe bağlıdır: yeni kurulumda hiçbiri kendiliğinden etkin değildir
    assert cfg.enabled_platforms() == {}
    assert cfg.platform("sanal").auth_mode == "token"
    assert cfg.platform("ubys").auto_relogin is False  # SMS doğrulaması: otomatik giriş yok
    assert cfg.ai.provider == "heuristic" and cfg.ai.allow_paid is False  # ücretli servis kapalı
    assert cfg.notify.to == "ben@gmail.com" and cfg.data_dir == tmp_path / "d"


def test_pages_include_merge(tmp_path, monkeypatch):
    monkeypatch.delenv("UNITAKIP_DATA_DIR", raising=False)
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "x.pages.yaml").write_text("- id: notlar\n  url: https://u.test/n\n  kind: grade\n",
                                                      encoding="utf-8")
    (tmp_path / "config" / "config.yaml").write_text(
        "platforms:\n  u:\n    type: webpages\n    display_name: U\n    base_url: https://u.test/\n"
        "    pages_include: config/x.pages.yaml\n", encoding="utf-8")
    cfg = load_config(tmp_path / "config" / "config.yaml")
    assert [p.id for p in cfg.platform("u").pages] == ["notlar"]
    assert cfg.data_dir == (tmp_path / "data").resolve()


def test_invalid_config(tmp_path):
    (tmp_path / "c.yaml").write_text("platforms:\n  x:\n    type: ftp\n", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(tmp_path / "c.yaml")
    with pytest.raises(ConfigError):
        load_config(Path(tmp_path / "yok.yaml"))


def test_cli_parser():
    args = build_parser().parse_args(["run-once", "--platform", "sanal", "--dry-run"])
    assert args.platform == "sanal" and args.dry_run

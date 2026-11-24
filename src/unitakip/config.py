"""Yapılandırma: YAML dosyası + ortam değişkenleri (.env)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, ValidationError

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class ConfigError(RuntimeError):
    """Yapılandırma eksik veya hatalı."""


class HttpConfig(BaseModel):
    min_request_interval_seconds: float = 1.5
    timeout_seconds: float = 30.0
    max_retries: int = 3
    max_response_mb: int = 60
    user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 UniTakip/0.1"
    )


class MoodleFeatures(BaseModel):
    contents: bool = True
    files: bool = True
    announcements: bool = True
    forums: bool = False
    assignments: bool = True
    quizzes: bool = True
    calendar: bool = True
    grades: bool = True
    notifications: bool = False


class PageConfig(BaseModel):
    id: str
    url: str
    kind: str = "page"
    course_name: str | None = None
    content_selector: str | None = None
    ignore_selectors: list[str] = Field(default_factory=list)
    track_text: bool = True
    track_tables: bool = True
    track_links: bool = True
    wait_selector: str | None = None  # browser renderer: bu seçici görünene kadar bekle
    ignore_patterns: list[str] = Field(default_factory=list)  # bu regex'lere uyan metin satırları yok sayılır
    key_columns: list[int] | None = None  # tablo satır kimliği sütunları (boş: otomatik seçim)
    # Bulut sürümüne aktarılan alanlar (cloud/cloudflare/src/core.js parsePage):
    ignore_columns: list[str] = Field(default_factory=list)  # bu başlıklı sütunlar kimliğe/değişikliğe girmez
    title: str | None = None  # metin izlemede öğe başlığı


DEFAULT_EXTENSIONS = [
    "pdf", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "odt", "odp", "ods",
    "txt", "rtf", "zip", "rar", "7z", "png", "jpg", "jpeg",
]


class PlatformConfig(BaseModel):
    enabled: bool = True
    type: Literal["moodle", "webpages"]
    display_name: str
    base_url: str
    login_url: str | None = None
    # --- moodle ---
    auth_mode: Literal["token", "session"] = "token"
    ws_service: str = "moodle_mobile_app"
    course_classification: Literal["inprogress", "all"] = "inprogress"
    include_course_ids: list[int] = Field(default_factory=list)
    exclude_course_ids: list[int] = Field(default_factory=list)
    features: MoodleFeatures = Field(default_factory=MoodleFeatures)
    calendar_days_ahead: int = 90
    discussions_per_forum: int = 15
    # --- webpages ---
    renderer: Literal["http", "browser"] = "http"
    logged_out_markers: list[str] = Field(default_factory=list)
    session_check_url: str | None = None
    auto_relogin: bool = False
    keepalive_minutes: int = 0
    keepalive_url: str | None = None
    # Otomatik yeniden giriş formu (yalnızca CAPTCHA/MFA olmayan sitelerde, kullanıcı izniyle).
    # Değerlerde {username} ve {password} yer tutucuları kullanılır.
    login_form: dict[str, str] = Field(default_factory=dict)
    pages: list[PageConfig] = Field(default_factory=list)
    pages_include: str | None = None  # `discover --apply` çıktısı (ör. config/ubys.pages.yaml)
    # --- ortak ---
    download_files: bool = True
    download_existing_files: bool = False  # true: ilk taramadaki mevcut dosyalar da (bildirimsiz) arşivlenir
    max_file_mb: int = 50
    file_extensions: list[str] = Field(default_factory=lambda: list(DEFAULT_EXTENSIONS))
    notify_removed: bool = False

    @property
    def root(self) -> str:
        return self.base_url.rstrip("/")


class NotifyConfig(BaseModel):
    provider: Literal["gmail_api", "gmail_smtp", "console"] = "console"
    to: str = ""
    subject_prefix: str = "[UniTakip]"
    attach_max_total_mb: float = 15.0
    drive_upload: bool = False
    drive_folder_name: str = "UniTakip"
    reauth_reminder_hours: int = 24
    unreachable_after_failures: int = 6
    notify_new_course: bool = True
    # Sessiz arıza koruması
    status_report: Literal["weekly", "daily", "off"] = "weekly"  # "sistem çalışıyor" özeti; gelmezse bir sorun var
    status_report_hour: int = 9          # yerel saat
    status_report_weekday: int = 0       # 0 = Pazartesi (weekly için)
    stale_after_hours: int = 24          # bu kadar süre başarılı kontrol yoksa uyar
    scope_failure_alert_runs: int = 24   # bir bölüm (ör. notlar) bu kadar ardışık çalıştırma alınamazsa uyar


class AIConfig(BaseModel):
    provider: Literal["heuristic", "ollama", "anthropic"] = "heuristic"
    allow_paid: bool = False
    max_input_chars: int = 12000
    redact_personal_data: bool = True
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3:8b"
    anthropic_model: str = "claude-opus-5-5"
    monthly_budget_usd: float = 2.0


class AppConfig(BaseModel):
    timezone: str = "Europe/Istanbul"
    data_dir: Path = Path("data")
    check_interval_minutes: int = 60
    jitter_minutes: float = 4.0
    tick_seconds: int = 30
    run_timeout_minutes: int = 25        # bir platform kontrolü takılırsa süreç kendini yeniden başlatır
    backup_keep_days: int = 7            # günlük SQLite yedeği (data/backups)
    http: HttpConfig = Field(default_factory=HttpConfig)
    platforms: dict[str, PlatformConfig] = Field(default_factory=dict)
    notify: NotifyConfig = Field(default_factory=NotifyConfig)
    ai: AIConfig = Field(default_factory=AIConfig)

    # --- türetilmiş yollar ---
    @property
    def secrets_dir(self) -> Path:
        return self.data_dir / "secrets"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "unitakip.sqlite3"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def discovery_dir(self) -> Path:
        return self.data_dir / "discovery"

    @property
    def outbox_dir(self) -> Path:
        return self.data_dir / "outbox"

    def enabled_platforms(self) -> dict[str, PlatformConfig]:
        return {k: v for k, v in self.platforms.items() if v.enabled}

    def platform(self, name: str) -> PlatformConfig:
        try:
            return self.platforms[name]
        except KeyError as exc:
            known = ", ".join(sorted(self.platforms)) or "(yok)"
            raise ConfigError(f"Bilinmeyen platform: {name}. Tanımlı olanlar: {known}") from exc


def load_dotenv(path: Path) -> None:
    """Basit .env okuyucu: mevcut ortam değişkenlerini EZMEZ."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def default_config_path() -> Path:
    env = os.environ.get("UNITAKIP_CONFIG")
    if env:
        return Path(env).expanduser().resolve()
    return PROJECT_ROOT / "config" / "config.yaml"


LOCAL_SITES_FILE = "sites.local.yaml"


def _merge_local_sites(raw: dict, local_path: Path) -> None:
    """`config/sites.local.yaml` (Git dışında) ana yapılandırmadaki siteleri genişletir veya tamamlar.

    `refresh-session.py` panelde eklenen siteleri buraya yazar; böylece kullanıcının kendi
    `config.yaml` dosyası (yorumlarıyla) hiç değiştirilmez. Aynı kimlikli bir site varsa alanlar
    üzerine yazılır (ör. `enabled: true`), yoksa yeni site olarak eklenir.
    """
    if not local_path.is_file():
        return
    local = yaml.safe_load(local_path.read_text(encoding="utf-8")) or {}
    sites = local.get("platforms") or {}
    if not isinstance(sites, dict):
        raise ConfigError(f"{local_path.name}: `platforms` bir sözlük olmalı.")
    platforms = raw.setdefault("platforms", {}) or {}
    raw["platforms"] = platforms
    for name, value in sites.items():
        if not isinstance(value, dict):
            raise ConfigError(f"{local_path.name}: `{name}` bir sözlük olmalı.")
        platforms[name] = {**(platforms.get(name) or {}), **value}


def load_config(path: Path | None = None) -> AppConfig:
    path = path or default_config_path()
    root = path.parent.parent if path.parent.name == "config" else path.parent
    load_dotenv(root / ".env")
    if not path.is_file():
        raise ConfigError(f"Yapılandırma bulunamadı: {path}. Önce `unitakip init` çalıştır.")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        _merge_local_sites(raw, path.parent / LOCAL_SITES_FILE)
        cfg = AppConfig.model_validate(raw)
    except (yaml.YAMLError, ValidationError, AttributeError, TypeError) as exc:
        raise ConfigError(f"Yapılandırma hatalı ({path}):\n{exc}") from exc

    for pcfg in cfg.platforms.values():
        if pcfg.pages_include:
            inc = Path(pcfg.pages_include)
            inc = inc if inc.is_absolute() else root / inc
            if inc.is_file():
                try:
                    extra = yaml.safe_load(inc.read_text(encoding="utf-8")) or []
                    known = {p.id for p in pcfg.pages}
                    pcfg.pages += [PageConfig.model_validate(p) for p in extra if p.get("id") not in known]
                except (yaml.YAMLError, ValidationError, AttributeError) as exc:
                    raise ConfigError(f"Sayfa listesi hatalı ({inc}): {exc}") from exc

    data_dir = Path(os.environ.get("UNITAKIP_DATA_DIR") or cfg.data_dir).expanduser()
    if not data_dir.is_absolute():
        data_dir = (root / data_dir).resolve()
    cfg.data_dir = data_dir
    if not cfg.notify.to:
        cfg.notify.to = os.environ.get("UNITAKIP_NOTIFY_TO", "").strip()
    return cfg

"""Komut satırı: unitakip <komut>."""

from __future__ import annotations

import argparse
import getpass
import logging
import os
import shutil
import signal
import sys
import threading
import warnings
from datetime import timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import PROJECT_ROOT, AppConfig, ConfigError, default_config_path, load_config, load_dotenv
from .crypto import ENV_KEY, SecretBox
from .logging_setup import setup_logging

log = logging.getLogger("unitakip")


def _load(args: argparse.Namespace) -> AppConfig:
    cfg = load_config(Path(args.config) if args.config else None)
    setup_logging(os.environ.get("UNITAKIP_LOG_LEVEL", "INFO"), cfg.logs_dir)
    return cfg


def _app(cfg: AppConfig, **kw):  # type: ignore[no-untyped-def]
    from .scheduler import App
    return App(cfg, **kw)


# ------------------------------------------------------------------ init
def cmd_init(args: argparse.Namespace) -> int:
    root = PROJECT_ROOT
    cfg_path = default_config_path()
    if not cfg_path.exists():
        shutil.copy(root / "config" / "config.example.yaml", cfg_path)
        print(f"Oluşturuldu: {cfg_path}")
    env_path = root / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else \
        (root / ".env.example").read_text(encoding="utf-8").splitlines()
    has_key = any(ln.startswith(f"{ENV_KEY}=") and ln.split("=", 1)[1].strip() for ln in lines)
    if not has_key:
        key = SecretBox.generate_key()
        replaced = False
        for i, ln in enumerate(lines):
            if ln.startswith(f"{ENV_KEY}="):
                lines[i] = f"{ENV_KEY}={key}"
                replaced = True
        if not replaced:
            lines.append(f"{ENV_KEY}={key}")
        fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        print(f"Şifreleme anahtarı üretildi ve {env_path} dosyasına yazıldı (chmod 600). Bu dosyayı yedekle; git'e ekleme.")
    else:
        print(".env içinde anahtar zaten var, değiştirilmedi.")
    cfg = load_config(cfg_path)
    for d in (cfg.data_dir, cfg.secrets_dir, cfg.files_dir, cfg.logs_dir):
        d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(cfg.secrets_dir, 0o700)
    except OSError:
        pass
    print(f"Veri klasörü: {cfg.data_dir}")
    print("Sonraki adımlar: config/config.yaml içinde kendi sitelerini ekle veya etkinleştir, "
          "her site için `unitakip login <site-id>`, ardından e-posta kurulumu (README: Gmail).")
    return 0


# ----------------------------------------------------------------- login
def cmd_login(args: argparse.Namespace) -> int:
    cfg = _load(args)
    from .scheduler import App

    app = App(cfg)
    pcfg = cfg.platform(args.platform)
    mode = args.mode or (pcfg.auth_mode if pcfg.type == "moodle" else "browser")
    if pcfg.type == "moodle" and mode == "token":
        from .adapters.base import LoginFailed
        from .adapters.moodle import MoodleAdapter, obtain_token
        from .http import HttpClient

        print(f"[{pcfg.display_name}] Resmi mobil uygulama yöntemiyle token alınacak (login/token.php).")
        print("Parolan yalnızca bu istekte kullanılır; diske ve loglara YAZILMAZ"
              + (" (--remember-credentials verildiği için ŞİFRELİ saklanacak)." if args.remember_credentials else "."))
        username = input("Kullanıcı adı: ").strip()
        password = getpass.getpass("Parola (görünmez): ")
        with HttpClient(cfg.http) as http:
            try:
                tok = obtain_token(http, pcfg.root, username, password, pcfg.ws_service)
            except LoginFailed as exc:
                print(f"Giriş reddedildi: {exc}")
                return 2
        app.store.save(f"{args.platform}.token", {**tok, "username": username, "base_url": pcfg.root})
        if args.remember_credentials:
            app.store.save(f"{args.platform}.credentials", {"username": username, "password": password})
            print("Kimlik bilgileri şifreli saklandı. Otomatik yenileme için config'te auto_relogin: true yap.")
        del password
        adapter = MoodleAdapter(args.platform, pcfg, cfg, app.store)
        try:
            adapter._load_site_info()
            info = adapter.site_info
            print(f"Giriş başarılı: {info.get('sitename')} — {info.get('fullname')} · {len(adapter.functions)} WS fonksiyonu")
        finally:
            adapter.close()
        app.db.update_state(args.platform, auth_status="ok", reauth_notified_at=None)
        return 0

    from .session.browser import interactive_login

    interactive_login(args.platform, pcfg, cfg, app.store, manual_confirm=args.manual)
    if args.remember_credentials:
        if not pcfg.login_form:
            print("Bu platformda otomatik giriş formu tanımlı değil (ör. SMS doğrulaması). Kimlik bilgisi saklanmadı.")
        else:
            username = input("Otomatik yeniden giriş için kullanıcı adı / e-posta: ").strip()
            password = getpass.getpass("Parola (görünmez): ")
            app.store.save(f"{args.platform}.credentials", {"username": username, "password": password})
            del password
            print("Şifreli saklandı. Etkinleştirmek için config'te auto_relogin: true yap.")
    app.db.update_state(args.platform, auth_status="ok", reauth_notified_at=None)
    print("Oturum kaydedildi. Doğrulamak için: unitakip run-once --platform", args.platform, "--dry-run")
    return 0


def cmd_logout(args: argparse.Namespace) -> int:
    cfg = _load(args)
    app = _app(cfg)
    removed = [n for n in (f"{args.platform}.session", f"{args.platform}.token", f"{args.platform}.credentials")
               if app.store.delete(n)]
    print("Silindi: " + (", ".join(removed) or "kayıt yoktu"))
    return 0


# -------------------------------------------------------------- discover
def cmd_discover(args: argparse.Namespace) -> int:
    cfg = _load(args)
    app = _app(cfg)
    pcfg = cfg.platform(args.platform)
    docs = PROJECT_ROOT / "docs" / "kesif"
    if pcfg.type == "moodle":
        from .adapters.moodle import MoodleAdapter
        from .discovery.moodle import discover_moodle

        adapter = MoodleAdapter(args.platform, pcfg, cfg, app.store)
        try:
            out = discover_moodle(adapter, cfg.discovery_dir, docs)
        finally:
            adapter.close()
    else:
        from .discovery.web import discover_web

        out = discover_web(args.platform, pcfg, cfg, app.store, docs_dir=docs, max_pages=args.max_pages,
                           apply=args.apply, project_root=PROJECT_ROOT)
    print(f"Keşif özeti: {out}")
    return 0


def cmd_probe_session(args: argparse.Namespace) -> int:
    """Oturumun boşta kalma süresini ölç: artan aralıklarla tek istek atar."""
    import time

    cfg = _load(args)
    app = _app(cfg)
    gaps = [int(x) for x in args.gaps.split(",")]
    print(f"Ölçüm başladı. Aralıklar (dk): {gaps}. Toplam ~{sum(gaps)} dk sürer.")
    for gap in gaps:
        time.sleep(gap * 60)
        adapter = app.make_adapter(args.platform)
        try:
            ok = adapter.keepalive()
        finally:
            adapter.close()
        print(f"{gap} dk boşta kaldıktan sonra oturum: {'GEÇERLİ' if ok else 'DÜŞMÜŞ'}")
        if not ok:
            print(f"Sonuç: boşta kalma süresi {gap} dk'dan kısa. keepalive_minutes değerini daha küçük seç.")
            return 0
    print(f"Oturum {max(gaps)} dk boşta kalmaya dayandı.")
    return 0


# ---------------------------------------------------------------- gmail
def cmd_gmail_auth(args: argparse.Namespace) -> int:
    cfg = _load(args)
    app = _app(cfg)
    from .notify.gmail import run_oauth_flow

    run_oauth_flow(Path(args.client_secret).expanduser(), app.store, drive=args.drive)
    print("Gmail yetkisi şifreli olarak kaydedildi (data/secrets/gmail.oauth.enc).")
    print("İstemci sırrı dosyasını artık silebilir veya güvenli bir yere taşıyabilirsin.")
    return 0


def cmd_smtp_auth(args: argparse.Namespace) -> int:
    cfg = _load(args)
    from .notify.smtp import configure_smtp
    from .session.store import SessionStore

    print("Google Cloud gerektirmeyen Gmail uygulama şifresi kurulumu.")
    print("Normal Gmail şifreni kullanma. Uygulama şifresi yalnızca gönderim izniyle sınırlı değildir.")
    username = input(f"Gönderen Gmail adresi [{cfg.notify.to}]: ").strip() or cfg.notify.to
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("16 karakterli uygulama şifresi (görünmez): ")
    except (getpass.GetPassWarning, EOFError):
        raise ConfigError("Gizli giriş için bu komutu etkileşimli bir terminalde çalıştır.") from None
    store = SessionStore(cfg.secrets_dir, SecretBox.from_env())
    try:
        configure_smtp(store, username, password)
    finally:
        del password
    print("SMTP girişi doğrulandı; uygulama şifresi data/secrets/gmail.smtp.enc içinde şifreli saklandı.")
    print("E-posta gönderilmedi.")
    if cfg.notify.provider != "gmail_smtp":
        print("Kullanmak için config dosyasında notify.provider: gmail_smtp ayarla.")
    print("Gönderimi denemek için: unitakip test-email")
    return 0


def cmd_test_email(args: argparse.Namespace) -> int:
    cfg = _load(args)
    app = _app(cfg)
    from .notify.render import render_notice

    email = render_notice(cfg.notify.subject_prefix, "Test bildirimi", [
        "UniTakip bildirim kanalı çalışıyor.",
        f"Platformlar: {', '.join(p.display_name for p in cfg.enabled_platforms().values())}",
    ])
    msg_id = app.notifier.send(email)
    print(f"Gönderildi ({app.notifier.name}): {msg_id}")
    return 0


# ------------------------------------------------------------------ çalıştır
def cmd_run_once(args: argparse.Namespace) -> int:
    cfg = _load(args)
    from .notify.base import ConsoleNotifier
    from .scheduler import InstanceLock, Runner, cleanup_dry_run, prepare_dry_run

    names = [args.platform] if args.platform else list(cfg.enabled_platforms())
    code = 0

    def _run(app) -> int:  # type: ignore[no-untyped-def]
        rc = 0
        runner = Runner(app)
        app.archive.cleanup_tmp()
        for name in names:
            res = runner.run_platform(name)
            print(f"{name}: {res.status} · {res.items} öğe · {res.changes} değişiklik · {res.notified} bildirildi"
                  + (f" · {res.error}" if res.error else ""))
            rc = rc or (0 if res.status == "ok" else 1)
        return rc

    if args.dry_run:
        # Gerçek veritabanının geçici kopyası: bildirim durumu, baseline ve zamanlama DEĞİŞMEZ
        tmp, db_copy = prepare_dry_run(cfg)
        app = _app(cfg, notifier=ConsoleNotifier(cfg.outbox_dir, cfg.notify.to), db_path=db_copy,
                   files_dir=tmp / "files")
        try:
            code = _run(app)
        finally:
            app.close()
            cleanup_dry_run(tmp)
        print(f"Kuru çalıştırma: gerçek veritabanı değiştirilmedi, e-posta gönderilmedi. "
              f"Gönderilecek e-postalar: {cfg.outbox_dir}/*.eml")
        return code

    app = _app(cfg)
    with InstanceLock(cfg.data_dir / "unitakip.lock"):
        code = _run(app)
    return code


def cmd_daemon(args: argparse.Namespace) -> int:
    cfg = _load(args)
    from .scheduler import InstanceLock, run_daemon

    app = _app(cfg)
    stop = threading.Event()

    def _stop(signum, _frame):  # type: ignore[no-untyped-def]
        log.info("Sinyal %s alındı, mevcut iş bitince durulacak.", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    with InstanceLock(cfg.data_dir / "unitakip.lock"):
        run_daemon(app, stop)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    cfg = _load(args)
    app = _app(cfg)
    tz = ZoneInfo(cfg.timezone)

    def f(dt):  # type: ignore[no-untyped-def]
        return dt.astimezone(tz).strftime("%d.%m %H:%M") if dt else "—"

    print(f"{'Platform':<14}{'Oturum':<10}{'Son başarı':<13}{'Sonraki':<13}{'Hata':<6}{'Öğe':<7}Giriş yaşı")
    for name, pcfg in cfg.platforms.items():
        st = app.db.get_state(name)
        key = f"{name}.token" if pcfg.type == "moodle" and pcfg.auth_mode == "token" else f"{name}.session"
        age = app.store.age(key)
        age_txt = f"{age.days} gün" if age and age >= timedelta(days=1) else (f"{int(age.total_seconds() // 3600)} sa" if age else "yok")
        flag = "" if pcfg.enabled else " (kapalı)"
        print(f"{name + flag:<14}{st.auth_status:<10}{f(st.last_success_at):<13}{f(st.next_run_at):<13}"
              f"{st.consecutive_failures:<6}{app.db.count_items(name):<7}{age_txt}")
        if st.last_error:
            print(f"   son hata: {st.last_error[:160]}")
    print(f"\nBekleyen bildirim: {app.db.pending_count()} · Bildirim: {cfg.notify.provider} → {cfg.notify.to or '(alıcı yok!)'}"
          f" · AI: {cfg.ai.provider}" + (f" (HATA: {app.ai.llm_error})" if app.ai.llm_error else ""))
    from .scheduler import heartbeat_age
    hb = heartbeat_age(cfg.data_dir)
    print(f"Daemon heartbeat: {int(hb.total_seconds())} sn önce" if hb else "Daemon heartbeat: yok (daemon çalışmıyor olabilir)")
    return 0


def cmd_health(args: argparse.Namespace) -> int:
    cfg = load_config(Path(args.config) if args.config else None)
    from .scheduler import heartbeat_age

    age = heartbeat_age(cfg.data_dir)
    if age is None or age > timedelta(minutes=args.max_age_minutes):
        print(f"SAĞLIKSIZ: heartbeat {'yok' if age is None else f'{int(age.total_seconds())} sn eski'}")
        return 1
    print("SAĞLIKLI")
    return 0


# ------------------------------------------------------------------ main
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="unitakip", description="Üniversite platformları için saatlik takip sistemi")
    p.add_argument("--config", help="config.yaml yolu (varsayılan: config/config.yaml veya UNITAKIP_CONFIG)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="config, .env anahtarı ve veri klasörlerini hazırla").set_defaults(func=cmd_init)

    s = sub.add_parser("login", help="platforma bir kez giriş yap ve oturumu şifreli sakla")
    s.add_argument("platform")
    s.add_argument("--mode", choices=["token", "session", "browser"], help="moodle: token (önerilen) | session")
    s.add_argument("--remember-credentials", action="store_true",
                   help="kimlik bilgilerini ŞİFRELİ sakla (otomatik yenileme için; varsayılan kapalı)")
    s.add_argument("--manual", action="store_true", help="girişi otomatik algılama yerine Enter ile onayla")
    s.set_defaults(func=cmd_login)

    s = sub.add_parser("logout", help="platformun kayıtlı oturum/token/kimlik bilgisini sil")
    s.add_argument("platform")
    s.set_defaults(func=cmd_logout)

    s = sub.add_parser("discover", help="oturumlu, salt-okunur keşif (rapor üretir)")
    s.add_argument("platform")
    s.add_argument("--apply", action="store_true", help="önerilen izleme sayfalarını config/<platform>.pages.yaml'a yaz")
    s.add_argument("--max-pages", type=int, default=25)
    s.set_defaults(func=cmd_discover)

    s = sub.add_parser("probe-session", help="oturumun boşta kalma süresini ölç (uzun sürer)")
    s.add_argument("platform")
    s.add_argument("--gaps", default="5,10,20,40,80", help="dakika cinsinden artan aralıklar")
    s.set_defaults(func=cmd_probe_session)

    s = sub.add_parser("gmail-auth", help="Gmail API için OAuth 2.0 onayı (Mac'te bir kez)")
    s.add_argument("--client-secret", required=True, help="Google Cloud'dan indirilen OAuth istemci JSON dosyası")
    s.add_argument("--drive", action="store_true", help="büyük dosyalar için drive.file kapsamını da iste")
    s.set_defaults(func=cmd_gmail_auth)

    sub.add_parser("smtp-auth", help="Gmail uygulama şifresini gizli al, doğrula ve şifreli sakla").set_defaults(func=cmd_smtp_auth)

    sub.add_parser("test-email", help="bildirim kanalını dene").set_defaults(func=cmd_test_email)

    s = sub.add_parser("run-once", help="tüm (veya bir) platformu bir kez kontrol et")
    s.add_argument("--platform")
    s.add_argument("--dry-run", action="store_true", help="e-posta gönderme, data/outbox'a .eml yaz")
    s.set_defaults(func=cmd_run_once)

    sub.add_parser("daemon", help="7/24 zamanlayıcı döngüsü").set_defaults(func=cmd_daemon)
    sub.add_parser("status", help="platform durumları ve bekleyen bildirimler").set_defaults(func=cmd_status)

    s = sub.add_parser("health", help="Docker sağlık kontrolü (heartbeat yaşı)")
    s.add_argument("--max-age-minutes", type=int, default=20)
    s.set_defaults(func=cmd_health)
    return p


def main(argv: list[str] | None = None) -> int:
    load_dotenv(PROJECT_ROOT / ".env")
    home = os.environ.get("HOME")
    if home and not os.path.isdir(home):  # Docker: HOME=/app/data/home (Chromium yazılabilir HOME ister)
        try:
            os.makedirs(home, exist_ok=True)
        except OSError:
            pass
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except ConfigError as exc:
        print(f"Yapılandırma hatası: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nİptal edildi.", file=sys.stderr)
        return 130
    except RuntimeError as exc:
        print(f"Hata: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        if type(exc).__module__.startswith("playwright") and "Executable doesn't exist" in str(exc):
            print("Chromium kurulu değil. Şunu çalıştır: .venv/bin/playwright install chromium", file=sys.stderr)
            return 1
        raise


if __name__ == "__main__":
    raise SystemExit(main())

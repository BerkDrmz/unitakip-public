"""Bir sitenin oturumunu bilgisayarında yenile ve onayınla kendi Cloudflare hesabına aktar.

Proje kökünden çalıştır:

    python3 cloud/cloudflare/refresh-session.py <site-id>
    python3 cloud/cloudflare/refresh-session.py <site-id> --type webpages --url https://obs.ornek-universite.edu.tr/

Adımlar:
1. Site yerel yapılandırmada yoksa (panelden eklendiyse) Git dışındaki config/sites.local.yaml
   dosyasına yazılır. Kendi config/config.yaml dosyan değiştirilmez.
2. `unitakip login <site-id>` çalışır: web siteleri için tarayıcı açılır ve girişi SEN yaparsın
   (CAPTCHA, SMS, e-Devlet adımları dahil; bu betik onları atlamaya çalışmaz). Moodle için resmi
   mobil uygulama token yöntemi kullanılır; şifren yalnızca o istekte kullanılır, saklanmaz.
3. prepare.py yerel bulut paketini (data/cloudflare/secrets.json, Git dışında) yeniler.
4. Paketi `npx wrangler secret bulk` ile yüklemeden önce açıkça onay ister.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
CLOUD = ROOT / "cloud" / "cloudflare"
SITE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")  # src/sites.js validId ile aynı
UBYS_HOME = "https://ubys.bartin.edu.tr/"
UBYS_HOST = urlparse(UBYS_HOME).hostname
UBYS_LOGIN = {
    "login_url": UBYS_HOME,
    "session_check_url": UBYS_HOME,
    "logged_out_markers": ['id="loginForm"', 'data-ajax-url="/Account/Login"'],
}
HEADER = (
    "# Panelde eklenen sitelerin yerel tanımları (refresh-session.py yazar). Git dışındadır.\n"
    "# Burada gizli bilgi yoktur; token ve oturumlar data/secrets/ altında şifreli tutulur.\n"
)


def _reexec_in_venv() -> None:
    """Kurulumun paketlerini ve yerel yapılandırmasını aynı sanal ortamdan kullan."""
    environment = ROOT / ".venv"
    python = environment / "bin" / "python"
    if python.is_file() and Path(sys.prefix).resolve() != environment.resolve():
        os.execv(str(python), [str(python), __file__, *sys.argv[1:]])
    try:
        import unitakip  # noqa: F401
    except ImportError:
        raise SystemExit("unitakip Python paketi bulunamadı. Önce README'deki yerel kurulumu tamamla.") from None


def public_https(url: str) -> str:
    parsed = urlparse(url or "")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port:
        raise ValueError("Adres https:// ile başlamalı; kullanıcı adı, şifre veya port içermemeli.")
    if parsed.query or parsed.fragment:
        raise ValueError("Adreste sorgu parametresi (?...) veya # bölümü olmamalı; sitenin herkese açık ana adresini ver.")
    return url


def local_site_entry(site_id: str, site_type: str, url: str, name: str | None) -> dict:
    """sites.local.yaml için en küçük tanım. Sayfa listesi panelde kalır (burada boş bırakılır)."""
    entry = {"enabled": True, "type": site_type, "display_name": (name or site_id)[:60], "base_url": url}
    if site_type == "moodle":
        entry["auth_mode"] = "token"
    elif urlparse(url).hostname == UBYS_HOST:
        entry.update(UBYS_LOGIN)
    else:
        entry["session_check_url"] = url
    return entry


def plan_local_change(cfg, site_id: str, site_type: str | None, url: str | None, name: str | None) -> dict | None:
    """Gerekiyorsa sites.local.yaml'a yazılacak değişikliği döndürür; gerekmiyorsa None."""
    if not SITE_ID.match(site_id):
        raise ValueError("Site kimliği yalnızca küçük harf, rakam ve tire içerebilir (paneldeki kimliği kullan).")
    existing = cfg.platforms.get(site_id)
    if existing is None:
        if not site_type or not url:
            raise ValueError(f"'{site_id}' yerel yapılandırmada yok. Paneldeki komutu (--type ve --url ile) kullan.")
        if site_type not in ("moodle", "webpages"):
            raise ValueError("--type moodle veya webpages olmalı.")
        return local_site_entry(site_id, site_type, public_https(url), name)
    if url and existing.base_url.rstrip("/") != public_https(url).rstrip("/"):
        raise ValueError(f"'{site_id}' yerelde başka bir adresle tanımlı ({existing.base_url}). Adresi panelde veya yapılandırmada eşitle.")
    if site_type and existing.type != site_type:
        raise ValueError(f"'{site_id}' yerelde '{existing.type}' türünde tanımlı.")
    change = {} if existing.enabled else {"enabled": True}
    if existing.type == "webpages" and urlparse(existing.base_url).hostname == UBYS_HOST:
        change.update({key: value for key, value in UBYS_LOGIN.items() if not getattr(existing, key)})
    return change or None


def write_local_site(config_dir: Path, site_id: str, change: dict) -> Path:
    import yaml

    path = config_dir / "sites.local.yaml"
    data = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.is_file() else {}
    platforms = data.setdefault("platforms", {})
    platforms[site_id] = {**(platforms.get(site_id) or {}), **change}
    body = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    path.write_text(HEADER + body, encoding="utf-8")
    return path


def run(command: list[str], cwd: Path) -> None:
    # Çıktı terminale doğrudan akar (tarayıcı/giriş adımları etkileşimlidir); gizli değer yazdırılmaz.
    if subprocess.run(command, cwd=cwd, check=False).returncode:
        raise SystemExit(f"Adım tamamlanamadı: {' '.join(command[:4])} …")


def confirm(question: str) -> bool:
    try:
        return input(f"{question} [e/H]: ").strip().lower() in ("e", "evet", "y", "yes")
    except EOFError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Bir sitenin oturumunu yenile ve bulut paketini güncelle.")
    parser.add_argument("site_id", help="paneldeki site kimliği (ör. sanal, ubys, bolum-duyurulari)")
    parser.add_argument("--type", choices=["moodle", "webpages"], help="site yerelde yoksa: bağlantı türü")
    parser.add_argument("--url", help="site yerelde yoksa: herkese açık ana adres (https://...)")
    parser.add_argument("--name", help="site yerelde yoksa: görünen ad")
    parser.add_argument("--no-upload", action="store_true", help="paketi hazırla ama Cloudflare'a yükleme sorusu sorma")
    args = parser.parse_args()

    _reexec_in_venv()
    from unitakip.config import ConfigError, load_config

    config_path = ROOT / "config" / "config.yaml"
    if not config_path.is_file():
        raise SystemExit("config/config.yaml yok. Önce `unitakip init` çalıştır (README: Yerel kurulum).")
    try:
        cfg = load_config(config_path)
        change = plan_local_change(cfg, args.site_id, args.type, args.url, args.name)
    except (ConfigError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
    if change:
        path = write_local_site(config_path.parent, args.site_id, change)
        print(f"Site tanımı {path.relative_to(ROOT)} dosyasına yazıldı (Git dışında).")

    print(f"\n1/3 · Giriş: {args.site_id}. Açılan pencerede girişi kendin tamamla.")
    run([sys.executable, "-m", "unitakip", "login", args.site_id], ROOT)
    print("\n2/3 · Yerel bulut paketi hazırlanıyor (yükleme yapılmaz).")
    run([sys.executable, str(CLOUD / "prepare.py")], ROOT)

    if args.no_upload or not confirm("\n3/3 · Paketi kendi Cloudflare hesabına yükleyeyim mi? (npx wrangler secret bulk)"):
        print("Yükleme yapılmadı. Hazır olduğunda: cd cloud/cloudflare && npx wrangler secret bulk ../../data/cloudflare/secrets.json")
        return
    run(["npx", "wrangler", "secret", "bulk", str(ROOT / "data" / "cloudflare" / "secrets.json")], CLOUD)
    print("Oturum aktarıldı. Panelde Siteler > ilgili site > “Bağlantıyı test et” ile doğrula.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit("\nİptal edildi.") from None

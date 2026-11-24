"""Prepare local, ignored Cloudflare secrets. Does not upload or send email.

Yerel yapılandırmadaki (config/config.yaml + Git dışı config/sites.local.yaml) etkin siteleri,
Worker'ın beklediği paket biçimine çevirir ve data/cloudflare/secrets.json dosyasına (600 izinli)
yazar. Site sayısı sabit değildir: hiç site olmadan da paket hazırlanabilir; siteler daha sonra
panelden eklenebilir. Giriş bilgisi olmayan bir site atlanmaz, panelde "Giriş gerekli" görünür.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlparse

# Worker yalnızca bu alanları okur. Giriş formları, okul şifreleri, localStorage veya e-Devlet
# çerezleri asla dışa aktarılmaz.
EXPORT_KEYS = ("base_url", "type", "display_name", "features", "course_classification", "include_course_ids",
               "exclude_course_ids", "calendar_days_ahead", "discussions_per_forum", "pages", "logged_out_markers",
               "session_check_url", "download_files", "download_existing_files", "notify_removed")
MAX_SITES = 12  # src/sites.js ile aynı


def build_cloud_config(cfg, store) -> tuple[dict, list[dict]]:
    """Paketi ve gizli değer içermeyen bir özet döndürür: [{id, type, credentials, skipped}]."""
    smtp = store.load("gmail.smtp") or {}
    if not smtp.get("password"):
        raise ValueError("Önce yerel Gmail SMTP kurulumu tamamlanmalı.")
    cloud = {"to": cfg.notify.to, "smtp": {k: smtp[k] for k in ("username", "password")}, "platforms": {}}
    report: list[dict] = []
    for name, platform in cfg.enabled_platforms().items():
        entry = {"id": name, "type": platform.type, "credentials": "none", "skipped": None}
        report.append(entry)
        url = urlparse(platform.base_url)
        if url.scheme != "https" or not url.hostname:
            entry["skipped"] = "adres https değil"
            continue
        if len(cloud["platforms"]) >= MAX_SITES:
            entry["skipped"] = f"en fazla {MAX_SITES} site"
            continue
        value = platform.model_dump(mode="json")
        value = {k: value[k] for k in EXPORT_KEYS}
        if platform.type == "moodle":
            value["base_url"] = platform.base_url.rstrip("/")
            token = store.load(f"{name}.token") or {}
            if token.get("token"):
                value["token"] = token["token"]
                entry["credentials"] = "token"
        else:
            session = store.load(f"{name}.session") or {}
            host = url.hostname
            cookies = [c for c in session.get("storage_state", {}).get("cookies", [])
                       if c.get("domain", "").lstrip(".") == host]
            if cookies:
                value["cookies"] = cookies
                value["user_agent"] = session.get("user_agent", cfg.http.user_agent)
                entry["credentials"] = "session"
        cloud["platforms"][name] = value
    return cloud, report


def write_secrets(folder: Path, cloud: dict) -> Path:
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    path = folder / "secrets.json"
    previous = json.loads(path.read_text()) if path.exists() else {}
    # Each Cloudflare secret binding is limited to 5 KiB; ASCII chunks cannot split UTF-8.
    serialized = json.dumps(cloud, ensure_ascii=True, separators=(",", ":"))
    parts = [serialized[i:i + 4000] for i in range(0, len(serialized), 4000)]
    payload = {"CONFIG_PARTS": str(len(parts)), **{f"CONFIG_{i}": part for i, part in enumerate(parts)},
               "STATE_KEY": previous.get("STATE_KEY") or base64.b64encode(os.urandom(32)).decode(),
               "ADMIN_TOKEN": previous.get("ADMIN_TOKEN") or secrets.token_urlsafe(48)}
    # Önceki paket daha fazla parçadan oluşuyorsa eski CONFIG_n değerleri zararsızdır: Worker yalnızca CONFIG_PARTS kadar okur.
    tmp = folder / f".secrets-{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, path)
    return path


LABEL = {"token": "Moodle tokenı var", "session": "oturum var", "none": "giriş bilgisi yok"}


def main() -> None:
    from unitakip.config import load_config
    from unitakip.crypto import SecretBox
    from unitakip.session.store import SessionStore

    root = Path(__file__).resolve().parents[2]
    cfg = load_config(root / "config/config.yaml")
    store = SessionStore(cfg.secrets_dir, SecretBox.from_env())
    cloud, report = build_cloud_config(cfg, store)
    write_secrets(root / "data/cloudflare", cloud)
    print("Yerel bulut paketi hazır (600 izinli, Git dışında). Yükleme veya e-posta gönderimi yapılmadı.")
    if not report:
        print("- Yerel yapılandırmada etkin site yok; siteleri panelden de ekleyebilirsin.")
    for entry in report:
        state = f"atlandı ({entry['skipped']})" if entry["skipped"] else LABEL[entry["credentials"]]
        print(f"- {entry['id']} ({entry['type']}): {state}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Exceptions from cryptography/config parsers may embed sensitive source values.
        raise SystemExit("Bulut paketi hazırlanamadı. Yerel yapılandırmayı, .env anahtarını ve Gmail kurulumunu kontrol et.") from None

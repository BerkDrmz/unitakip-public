"""Öğreniyorum.net / ÜBYS oturumlu keşfi (salt-okunur gezinti + ağ istekleri kaydı).

Yalnızca GET gezintisi yapılır. Form gönderilmez, düğmeye tıklanmaz. Engel listesindeki bağlantılar
(kayıt, sil, onay, çıkış...) takip edilmez. Çerez DEĞERLERİ ve tablo hücreleri özete yazılmaz.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import yaml
from bs4 import BeautifulSoup

from ..adapters.webpages import is_safe_link
from ..config import AppConfig, PlatformConfig
from ..models import normalize_text, utcnow
from ..session.browser import BLOCKED_RESOURCES, is_logged_out
from ..session.store import SessionStore

log = logging.getLogger(__name__)

RELEVANT = re.compile(
    r"(?i)(not|harf|vize|final|bütünleme|sınav|devams|yoklama|ders|program|takvim|duyuru|ödev|materyal|içerik|"
    r"döküman|doküman|transkript|belge|kurs|modül|video|sertifika|ilerleme)"
)
_TIMEOUT_HINT = re.compile(r"(?i)(session[_ ]?timeout|sessiontimeout|timeout|oturum süresi)\D{0,40}(\d{2,6})")


def _guess_kind(headers: list[str], title: str) -> str:
    blob = " ".join(headers + [title]).lower()
    if re.search(r"devams|yoklama", blob):
        return "attendance"
    if re.search(r"\bnot\b|harf|vize|final|bütünleme|ortalama|ağırlık", blob):
        return "grade"
    if re.search(r"duyuru", blob):
        return "announcement"
    if re.search(r"ödev", blob):
        return "assignment"
    if re.search(r"takvim|sınav programı|tarih|saat", blob):
        return "event"
    return "page"


def _slug(text: str, used: set[str]) -> str:
    tr = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")
    base = re.sub(r"[^a-z0-9]+", "-", text.translate(tr).lower()).strip("-")[:40] or "sayfa"
    slug, i = base, 2
    while slug in used:
        slug, i = f"{base}-{i}", i + 1
    used.add(slug)
    return slug


def _page_summary(html: str, url: str, pcfg: PlatformConfig) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    title = normalize_text(soup.title.get_text()) if soup.title else ""
    tables = []
    for t in soup.find_all("table"):
        headers = [normalize_text(th.get_text(" ", strip=True)) for th in t.find_all("th")][:15]
        tables.append({"id": t.get("id"), "class": " ".join(t.get("class", [])), "headers": headers,
                       "rows": len(t.find_all("tr"))})
    forms = [{"action": f.get("action"), "method": (f.get("method") or "get").lower(),
              "fields": sorted({i.get("name") for i in f.find_all(["input", "select", "textarea"]) if i.get("name")})}
             for f in soup.find_all("form")]
    links = []
    for a in soup.find_all("a", href=True):
        href = urljoin(url, a["href"])
        links.append({"url": href, "text": normalize_text(a.get_text(" ", strip=True))[:80]})
    file_links = [lk for lk in links if re.search(r"\.(pdf|docx?|pptx?|xlsx?|zip|rar)(\?|$)", lk["url"], re.I)]
    hints = sorted({f"{m.group(1)}={m.group(2)}" for m in _TIMEOUT_HINT.finditer(html)})[:10]
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return {"url": url, "title": title, "logged_out": is_logged_out(html, url, pcfg), "tables": tables,
            "forms": forms, "links": links, "file_links": len(file_links), "timeout_hints": hints,
            "text_len": len(normalize_text(soup.get_text(" ")))}


def _post_field_names(req: Any) -> list[str]:
    """POST gövdesinden yalnızca alan adları (değerler asla). JSON/form dışı gövdede boş liste."""
    try:
        data = req.post_data_json
    except Exception:  # noqa: BLE001 - multipart, düz metin vb.
        return []
    return sorted(str(k) for k in data.keys()) if isinstance(data, dict) else []


def _strip_query_values(url: str) -> str:
    parts = urlsplit(url)
    keys = [kv.split("=", 1)[0] for kv in parts.query.split("&") if kv]
    return urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[-1], parts.path,
                       "&".join(f"{k}=…" for k in keys), ""))


def discover_web(name: str, pcfg: PlatformConfig, app: AppConfig, store: SessionStore, *, docs_dir: Path,
                 max_pages: int = 25, apply: bool = False, project_root: Path | None = None) -> Path:
    from playwright.sync_api import sync_playwright

    session = store.load(f"{name}.session")
    if not session:
        raise RuntimeError(f"Oturum yok: önce `unitakip login {name}` çalıştır.")
    host = urlsplit(pcfg.base_url).hostname
    network: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(storage_state=session["storage_state"], user_agent=session.get("user_agent"),
                                  locale="tr-TR", timezone_id=app.timezone)
        ctx.route("**/*", lambda r: r.abort() if r.request.resource_type in BLOCKED_RESOURCES else r.continue_())

        def on_response(resp) -> None:  # type: ignore[no-untyped-def]
            # Olay işleyicisinde hata keşfi bozmamalı. Playwright'ın post_data_json'ı JSON olmayan gövdede
            # hata fırlatır ve mesajına GÖVDENİN KENDİSİNİ koyar (token sızabilir): yalnızca alan ADLARI tutulur.
            try:
                req = resp.request
                ctype = resp.headers.get("content-type") or ""
                if req.resource_type not in ("xhr", "fetch") and "json" not in ctype:
                    return
                network.append({"method": req.method, "url": _strip_query_values(req.url), "status": resp.status,
                                "type": req.resource_type, "content_type": ctype[:60],
                                "post_fields": _post_field_names(req) if req.method == "POST" else []})
            except Exception:  # noqa: BLE001
                log.debug("ağ isteği kaydedilemedi", exc_info=False)

        ctx.on("response", on_response)
        queue = [u for u in dict.fromkeys([pcfg.session_check_url or pcfg.base_url, *[pg.url for pg in pcfg.pages]]) if u]
        seen: set[str] = set()
        while queue and len(pages) < max_pages:
            url = queue.pop(0)
            if url in seen:
                continue
            seen.add(url)
            page = ctx.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                try:
                    page.wait_for_load_state("networkidle", timeout=12000)
                except Exception:  # noqa: BLE001
                    pass
                summary = _page_summary(page.content(), page.url, pcfg)
            except Exception as exc:  # noqa: BLE001 - keşif mümkün olduğunca devam etmeli
                pages.append({"url": _strip_query_values(url), "error": type(exc).__name__})
                continue
            finally:
                page.close()
            pages.append(summary)
            if summary["logged_out"]:
                log.warning("%s: oturum kapalı görünüyor (%s). Keşif durduruldu.", name, _strip_query_values(url))
                break
            for lk in summary["links"]:
                u = lk["url"].split("#")[0]
                if urlsplit(u).hostname == host and u not in seen and is_safe_link(u, lk["text"]):
                    if RELEVANT.search(lk["text"] + " " + u) and len(queue) < max_pages * 3:
                        queue.append(u)
            time.sleep(max(app.http.min_request_interval_seconds, 2.0))
        cookies = [{"name": c["name"], "domain": c["domain"], "expires": c.get("expires"),
                    "httpOnly": c.get("httpOnly"), "secure": c.get("secure")} for c in ctx.cookies()]
        local_keys = {}
        try:
            for origin in ctx.storage_state().get("origins", []):
                local_keys[origin["origin"]] = [i["name"] for i in origin.get("localStorage", [])]
        except Exception:  # noqa: BLE001
            pass
        new_state = ctx.storage_state()
        browser.close()
    if store.save_if_unchanged(f"{name}.session", {**session, "storage_state": new_state}, session.get("saved_at")) is None:
        log.info("%s: oturum keşif sırasında yeniden kaydedilmiş; eski çerezler yazılmadı.", name)

    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    raw = {"pages": pages, "network": network, "cookies": cookies, "local_storage_keys": local_keys}
    app.discovery_dir.mkdir(parents=True, exist_ok=True)
    raw_path = app.discovery_dir / f"{name}-{stamp}.json"
    raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    # Önerilen izleme sayfaları: tablo veya dosya bağlantısı içeren, konuyla ilgili sayfalar
    used: set[str] = set()
    suggestions = []
    for pg in pages:
        if pg.get("error") or pg.get("logged_out"):
            continue
        has_content = any(t["rows"] > 1 for t in pg["tables"]) or pg["file_links"] > 0
        if has_content and RELEVANT.search(pg["title"] + " " + pg["url"]):
            headers = [h for t in pg["tables"] for h in t["headers"]]
            suggestions.append({"id": _slug(pg["title"] or urlsplit(pg["url"]).path, used), "url": pg["url"],
                                "kind": _guess_kind(headers, pg["title"])})

    endpoints = sorted({(n["method"], n["url"], n["content_type"]) for n in network})
    lines = [
        f"# {pcfg.display_name} — oturumlu keşif özeti (otomatik)",
        "",
        f"Oluşturma: {stamp} · gezilen sayfa: {len(pages)} · ham veri (kişisel, git dışı): `{raw_path}`",
        "",
        "## Çerezler (değerler yazılmadı)",
        "| Ad | Alan | Bitiş | HttpOnly | Secure |",
        "|---|---|---|---|---|",
    ]
    for c in cookies:
        exp = c["expires"]
        exp_txt = "oturum çerezi" if not exp or exp < 0 else time.strftime("%Y-%m-%d %H:%M", time.gmtime(exp))
        lines.append(f"| `{c['name']}` | {c['domain']} | {exp_txt} | {c['httpOnly']} | {c['secure']} |")
    lines += ["", "## Sayfalar", "| Başlık | Yol | Tablo (başlıklar) | Dosya bağl. | Form | Oturum |", "|---|---|---|---|---|---|"]
    for pg in pages:
        if pg.get("error"):
            lines.append(f"| (hata) | `{_strip_query_values(pg['url'])}` | {pg['error'][:60]} | | | |")
            continue
        tables = "; ".join(", ".join(t["headers"][:6]) or f"{t['rows']} satır" for t in pg["tables"])[:160]
        forms = "; ".join(f"{f['method']} {', '.join(f['fields'][:6])}" for f in pg["forms"])[:120]
        lines.append(f"| {pg['title'][:50]} | `{_strip_query_values(pg['url'])}` | {tables or '—'} | {pg['file_links']} "
                     f"| {forms or '—'} | {'KAPALI' if pg['logged_out'] else 'açık'} |")
    lines += ["", "## XHR / JSON uç noktaları (sorgu değerleri gizlendi)"]
    lines += [f"- `{m} {u}` ({ct})" for m, u, ct in endpoints[:80]] or ["- yok"]
    hints = sorted({h for pg in pages if not pg.get("error") for h in pg.get("timeout_hints", [])})
    lines += ["", "## Oturum süresi ipuçları", *([f"- `{h}`" for h in hints] or ["- bulunamadı"]),
              "", "## Önerilen izleme sayfaları", *([f"- `{s['id']}` ({s['kind']}): `{_strip_query_values(s['url'])}`"
                                                    for s in suggestions] or ["- yok"])]
    docs_dir.mkdir(parents=True, exist_ok=True)
    out = docs_dir / f"{name}-oturumlu-kesif.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    if apply and suggestions:
        root = project_root or Path.cwd()
        target = Path(pcfg.pages_include or f"config/{name}.pages.yaml")
        target = target if target.is_absolute() else root / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# `unitakip discover --apply` tarafından üretildi. Gözden geçir, gereksizleri sil.\n"
                          + yaml.safe_dump(suggestions, allow_unicode=True, sort_keys=False), encoding="utf-8")
        log.info("%s: %d sayfa önerisi yazıldı: %s", name, len(suggestions), target)
    return out

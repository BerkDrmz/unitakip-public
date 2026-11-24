"""Genel web sayfası adaptörü (Öğreniyorum.net, ÜBYS).

Siteye özel seçici TAHMİN ETMEZ. Yapılandırılan her sayfa için:
  - tablolar → satır başına kayıt (kimlik: içerik tabanlı satır anahtarı)
  - dosya bağlantıları → dosya kayıtları (indirilebilir)
  - kalan metin → tek "sayfa metni" kaydı (değişiklikte eklenen/çıkarılan satırlar raporlanır)
İzlenecek sayfalar `unitakip discover <platform> --apply` ile keşiften gelir.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, Tag

from ..config import AppConfig, PageConfig, PlatformConfig
from ..http import DownloadResult, HttpClient, TransientError
from ..logging_setup import register_secret
from ..models import SENSITIVE_KINDS, Item, Kind, RemoteFile, Snapshot, normalize_text, sha256_text
from ..session.browser import is_logged_out
from ..session.store import SessionStore, cookies_from_storage_state, merge_cookies_into_state
from .base import Adapter, AuthExpired, AuthMissing, LoginFailed, NotAFile

log = logging.getLogger(__name__)

# Gezinti sırasında ASLA takip edilmeyecek bağlantılar (yan etki riski). Alt dize eşleşmesi:
# bilinçli olarak geniş tutuldu, yanlış pozitif yalnızca keşif kapsamını daraltır.
UNSAFE_LINK = re.compile(
    r"(?i)(logout|log-out|signout|cikis|çıkış|oturumu ?kapat|exit|sil|delete|remove|kaldir|kaldır|"
    r"kaydet|save|onay|approve|confirm|submit|gonder|gönder|kayit|kayıt|kaydol|enrol|enroll|register|"
    r"basvur|başvur|iptal|cancel|ekle|add|update|guncelle|güncelle|degistir|değiştir|sifre|şifre|password|"
    r"odeme|ödeme|payment|seç|vote|oyla|attempt|teslim)"
)
# Dosya indirmede daha dar kontrol: "Ders_Silabusu.pdf" gibi adlar engellenmesin
UNSAFE_FILE_LINK = re.compile(
    r"(?i)(?<![a-zçğıöşü])(logout|signout|cikis|çıkış|delete|sil|remove|kaldir|kaldır|action|do=sil)(?![a-zçğıöşü])"
)

# Her yüklemede değişen ve gerçek içerik olmayan satırlar (sahte "sayfa değişti" bildirimini önler).
# "Online sınav", "çevrimiçi ders" gibi gerçek duyurular ELENMEZ: yalnızca sayaç/zaman damgası kalıpları.
_VOLATILE_LINE = re.compile(
    r"(?i)("
    r"\b\d+\s*(saniye|sn|dakika|dk|saat|gün|hafta)\s*önce\b"
    r"|son\s+(görülme|giriş|erişim|oturum|ziyaret|güncelleme)\b|last\s+(login|seen|access|updated)\b"
    r"|\b\d+\s*(kişi|kullanıcı|ziyaretçi|user)s?\s*(çevrimiçi|online)\b|çevrimiçi\s+kullanıcılar|online\s+users"
    r"|oturum(unuz)?\s*\d+|kalan\s+süre|sunucu\s+saati|ziyaretçi\s+sayısı|visitor|copyright|©"
    r"|^\d{1,2}:\d{2}(:\d{2})?$"
    r"|^\d{1,2}[./]\d{1,2}[./]\d{2,4}(\s+\d{1,2}:\d{2}(:\d{2})?)?$"
    r")"
)
_ROW_NUMBER = re.compile(r"^\d{1,3}\.?$")
_ID_HEADER = re.compile(r"(?i)(kod|ders|ad[ıi]\b|başlık|konu|isim|etkinlik|sınav türü|tür)")

_ROW_KINDS = {"grade": Kind.GRADE, "attendance": Kind.ATTENDANCE, "event": Kind.EVENT,
              "announcement": Kind.ANNOUNCEMENT, "assignment": Kind.ASSIGNMENT}


def is_safe_link(url: str, text: str = "") -> bool:
    """Gezinti (keşif) için: URL ve bağlantı metninde yan etki çağrıştıran ifade yoksa True."""
    if not url or url.startswith(("javascript:", "mailto:", "tel:", "#")):
        return False
    return not (UNSAFE_LINK.search(url) or UNSAFE_LINK.search(text or ""))


def is_safe_file_link(url: str) -> bool:
    if not url or url.startswith(("javascript:", "mailto:", "tel:")):
        return False
    return not UNSAFE_FILE_LINK.search(url)


def _clean_soup(html: str, page: PageConfig) -> Tag:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "template", "iframe", "meta", "link", "head"]):
        tag.decompose()
    for tag in soup.select('input[type="hidden"]'):
        tag.decompose()
    for tag in soup.select('nav, header, footer, aside, [role="navigation"], .sidebar, .main-sidebar, .navbar'):
        tag.decompose()
    for sel in page.ignore_selectors:
        for tag in soup.select(sel):
            tag.decompose()
    if page.content_selector:
        root = soup.select_one(page.content_selector)
        if root is None:
            log.warning("content_selector bulunamadı (%s): %s", page.id, page.content_selector)
        else:
            return root
    return soup.body or soup


def _cell_text(cell: Tag) -> str:
    return normalize_text(cell.get_text(" ", strip=True))


def _own_rows(table: Tag) -> list[Tag]:
    """Yalnızca bu tablonun satırları (iç içe tabloların satırları hariç)."""
    return [tr for tr in table.find_all("tr") if tr.find_parent("table") is table]


def _table_records(table: Tag) -> tuple[list[str], list[list[str]]]:
    headers: list[str] = []
    data: list[list[str]] = []
    for tr in _own_rows(table):
        cells_tags = tr.find_all(["th", "td"], recursive=False)
        is_header_row = all(c.name == "th" for c in cells_tags) or tr.find_parent("thead") is not None
        if cells_tags and is_header_row and not headers:
            headers = [_cell_text(c) for c in cells_tags]
            continue
        cells = [_cell_text(c) for c in cells_tags]  # satır başlığı <th> da veriye dahil
        if any(cells):
            data.append(cells)
    return headers, data


def _key_columns(headers: list[str], rows: list[list[str]], override: list[int] | None) -> list[int]:
    """Satır kimliği için sütun seçimi: değer sütunları (ör. not) kimliğe girmesin ki değer değişince
    satır 'yeni' değil 'güncellendi' olarak algılansın."""
    if override:
        return override
    ncol = max((len(r) for r in rows), default=0)
    if ncol == 0:
        return []

    def unique(cols: list[int]) -> bool:
        keys = [tuple(r[i] if i < len(r) else "" for i in cols) for r in rows]
        return len(set(keys)) == len(keys) and all(any(k) for k in keys)

    start = 1 if ncol > 1 and all(_ROW_NUMBER.match(r[0] or "") for r in rows if r) else 0  # sıra no sütunu
    for i, h in enumerate(headers):
        if i >= start and _ID_HEADER.search(h or "") and unique([i]):
            return [i]
    for width in (1, 2, 3):
        cols = list(range(start, min(start + width, ncol)))
        if cols and unique(cols):
            return cols
    return list(range(ncol))


def extract_items(platform: str, page: PageConfig, html: str, page_url: str,
                  extensions: list[str], file_patterns: list[str] | None = None) -> list[Item]:
    root = _clean_soup(html, page)
    scope = f"page:{page.id}"
    items: list[Item] = []
    row_kind = _ROW_KINDS.get(page.kind, Kind.TABLE_ROW)
    ext_re = re.compile(r"\.(" + "|".join(re.escape(e) for e in extensions) + r")(?:$|[?#])", re.I) if extensions else None
    extra = [re.compile(p) for p in (file_patterns or [])]
    ignore = [re.compile(p) for p in page.ignore_patterns]

    # --- tablolar
    if page.track_tables:
        # İçten dışa: iç tablo işlenip silinince dış (yerleşim) tablosunun hücresi onu tekrar içermez
        for ti, table in reversed(list(enumerate(root.find_all("table")))):
            headers, rows = _table_records(table)
            tkey = table.get("id") or (sha256_text("|".join(headers))[:8] if headers else f"t{ti}")
            table.decompose()
            if not rows:
                continue
            key_cols = _key_columns(headers, rows, page.key_columns)
            seen_keys: dict[str, int] = {}
            for cells in rows:
                record = dict(zip(headers, cells)) if headers and len(headers) == len(cells) else {
                    f"s{i + 1}": c for i, c in enumerate(cells)}
                key = "|".join(cells[i] if i < len(cells) else "" for i in key_cols)
                n = seen_keys.get(key, 0)
                seen_keys[key] = n + 1
                rkey = sha256_text(f"{key}#{n}" if n else key)[:16]
                label_cells = [cells[i] for i in key_cols if i < len(cells) and cells[i]]
                title = " — ".join(label_cells)[:150] or " — ".join(c for c in cells[:2] if c)[:150] or "satır"
                items.append(Item(
                    platform=platform, external_id=f"web:{page.id}:{tkey}:{rkey}", kind=row_kind,
                    title=title, scope=scope,
                    course_name=page.course_name or (label_cells[0] if row_kind == Kind.GRADE and label_cells else None),
                    url=page_url, data={"cells": record}, text=" | ".join(f"{k}: {v}" for k, v in record.items()),
                ))

    # --- dosya bağlantıları
    if page.track_links:
        seen: set[str] = set()
        for a in root.find_all("a", href=True):
            href = urljoin(page_url, a["href"])
            text = normalize_text(a.get_text(" ", strip=True))
            is_file = bool(ext_re and ext_re.search(urlsplit(href).path)) or any(p.search(href) for p in extra)
            if not is_file or href in seen or not is_safe_file_link(href):
                continue
            seen.add(href)
            filename = Path(urlsplit(href).path).name or text or "dosya"
            items.append(Item(
                platform=platform, external_id=f"web:{page.id}:file:{sha256_text(href)[:16]}", kind=Kind.FILE,
                title=text or filename, scope=scope, course_name=page.course_name, url=href,
                data={"filename": filename, "link_text": text},
                files=[RemoteFile(url=href, filename=filename)],
            ))

    # --- sayfa metni
    if page.track_text:
        lines = []
        for ln in normalize_text(root.get_text("\n")).splitlines():
            ln = ln.strip()
            if len(ln) < 2 or _VOLATILE_LINE.search(ln) or any(p.search(ln) for p in ignore):
                continue
            lines.append(ln)
        text = "\n".join(lines)
        if text:
            # Not/devamsızlık sayfalarının metni de hassastır: harici AI'ya gönderilmez
            text_kind = row_kind if row_kind in SENSITIVE_KINDS else Kind.PAGE
            items.append(Item(
                platform=platform, external_id=f"web:{page.id}:text", kind=text_kind,
                title=page.course_name or page.id, scope=scope, course_name=page.course_name,
                url=page_url, data={"text": text}, text=text,
            ))
    return items


class WebPagesAdapter(Adapter):
    def __init__(self, name: str, pcfg: PlatformConfig, app: AppConfig, store: SessionStore,
                 http: HttpClient | None = None, renderer: Any | None = None):
        super().__init__(name, pcfg, app, store)
        self._http = http
        self._renderer = renderer
        self._session: dict[str, Any] | None = None
        self._cookies_loaded = False

    def _load_session(self) -> dict[str, Any]:
        if self._session is None:
            session = self.store.load(self.session_key)
            if not session:
                raise AuthMissing(f"{self.pcfg.display_name}: oturum yok. `unitakip login {self.name}` çalıştır.")
            self._session = session
        return self._session

    def _client(self) -> HttpClient:
        session = self._load_session()
        if self._http is None:
            self._http = HttpClient(self.app.http, cookies=cookies_from_storage_state(session["storage_state"]),
                                    user_agent=session.get("user_agent"))
            self._cookies_loaded = True
        elif not self._cookies_loaded:  # dışarıdan verilen istemciye oturum çerezlerini yükle
            self._http.cookies.update(cookies_from_storage_state(session["storage_state"]))
            self._cookies_loaded = True
        return self._http

    def _get_renderer(self) -> Any:
        if self._renderer is None and self.pcfg.renderer == "browser":
            from ..session.browser import BrowserRenderer
            self._renderer = BrowserRenderer(self._load_session(), self.app, self.app.http.min_request_interval_seconds)
        return self._renderer

    def _get(self, url: str, page: PageConfig | None = None) -> tuple[str, str]:
        renderer = self._get_renderer()
        if renderer is not None:
            return renderer.get(url, wait_selector=page.wait_selector if page else None)
        resp = self._client().get(url)
        if resp.status_code in (401, 403):
            raise AuthExpired(f"{self.pcfg.display_name}: HTTP {resp.status_code}")
        if resp.status_code >= 400:
            raise TransientError(f"HTTP {resp.status_code}: {url}")
        return resp.text, str(resp.url)

    def _relogin(self) -> bool:
        """Yalnızca kullanıcı --remember-credentials ile açıkça izin verdiyse ve site CAPTCHA/MFA içermiyorsa."""
        if not self.pcfg.auto_relogin or self.pcfg.renderer == "browser":
            return False
        creds = self.store.load(self.credentials_key)
        if not creds or not self.pcfg.login_form:
            return False
        register_secret(creds.get("password"))
        form = {k: v.replace("{username}", creds["username"]).replace("{password}", creds["password"])
                for k, v in self.pcfg.login_form.items()}
        log.info("%s: oturum düşmüş, kayıtlı bilgilerle yeniden giriş deneniyor.", self.name)
        resp = self._client().post(self.pcfg.login_url or self.pcfg.base_url, data=form)
        html, url = self._get(self.pcfg.session_check_url or self.pcfg.base_url)
        if is_logged_out(html, url, self.pcfg):
            raise LoginFailed(f"{self.pcfg.display_name}: otomatik yeniden giriş başarısız (HTTP {resp.status_code}).")
        self._save_session()
        return True

    def _check_page(self, html: str, url: str, retried: bool) -> bool:
        """True: sayfa geçerli. False: yeniden giriş yapıldı, sayfa tekrar çekilmeli."""
        if not is_logged_out(html, url, self.pcfg):
            return True
        if not retried and self._relogin():
            return False
        raise AuthExpired(f"{self.pcfg.display_name}: oturum sona ermiş.")

    def fetch(self) -> Snapshot:
        snap = Snapshot(platform=self.name)
        self._load_session()
        pages = list(self.pcfg.pages)
        if not pages:
            check = self.pcfg.session_check_url or self.pcfg.base_url
            html, url = self._get(check)
            self._check_page(html, url, retried=True)
            snap.meta["warning"] = "İzlenecek sayfa tanımlı değil: `unitakip discover %s --apply`" % self.name
            log.warning("%s: izlenecek sayfa yok, yalnızca oturum doğrulandı.", self.name)
        for page in pages:
            scope = f"page:{page.id}"
            try:
                html, url = self._get(page.url, page)
                if not self._check_page(html, url, retried=False):
                    html, url = self._get(page.url, page)
                    self._check_page(html, url, retried=True)
            except (AuthExpired, AuthMissing, LoginFailed):
                raise
            except TransientError as exc:
                snap.fail(scope, str(exc))
                continue
            except Exception as exc:  # noqa: BLE001 - ör. tarayıcı zaman aşımı: yalnızca bu sayfa düşer
                log.warning("%s: %s sayfası alınamadı: %s", self.name, page.id, exc)
                snap.fail(scope, f"{type(exc).__name__}: {str(exc)[:200]}")
                continue
            try:
                items = extract_items(self.name, page, html, url, self.pcfg.file_extensions)
            except Exception as exc:  # noqa: BLE001 - beklenmeyen HTML: yalnızca bu sayfa düşer
                log.exception("%s: %s sayfası ayrıştırılamadı", self.name, page.id)
                snap.fail(scope, f"ayrıştırma hatası: {type(exc).__name__}")
                continue
            for item in items:
                snap.add(item)
            snap.ok(scope)
        self._save_session()
        return snap

    def download(self, rf: RemoteFile, dest: Path, max_bytes: int) -> DownloadResult:
        if not is_safe_file_link(rf.url):
            raise NotAFile(f"Güvensiz bağlantı indirilmedi: {rf.url}")
        result = self._client().download(rf.url, dest, max_bytes)
        if "text/html" in result.content_type.lower() and not rf.filename.lower().endswith((".html", ".htm")):
            head = dest.read_bytes()[:200_000].decode("utf-8", "replace")
            dest.unlink(missing_ok=True)
            if is_logged_out(head, result.final_url, self.pcfg):
                raise AuthExpired(f"{self.pcfg.display_name}: dosya indirilirken oturum düştü.")
            raise NotAFile(f"Dosya yerine HTML döndü: {rf.filename}")
        return result

    def keepalive(self) -> bool:
        url = self.pcfg.keepalive_url or self.pcfg.session_check_url or self.pcfg.base_url
        try:
            resp = self._client().get(url)
        except TransientError:
            return True  # ağ sorunu oturumun düştüğü anlamına gelmez
        ok = not is_logged_out(resp.text, str(resp.url), self.pcfg)
        if ok:
            self._save_session()
        return ok

    def _save_session(self) -> None:
        if self._session is None:
            return
        state = self._session["storage_state"]
        if self._renderer is not None and hasattr(self._renderer, "storage_state"):
            state = self._renderer.storage_state()
        if self._http is not None:
            state = merge_cookies_into_state(state, self._http.cookies)
        saved = self.store.save_if_unchanged(self.session_key, {**self._session, "storage_state": state},
                                             self._session.get("saved_at"))
        if saved is None:
            log.info("%s: oturum bu sırada yeniden kaydedilmiş (yeni giriş?); eski çerezler yazılmadı.", self.name)
        else:
            self._session = saved

    def close(self) -> None:
        if self._renderer is not None and hasattr(self._renderer, "close"):
            self._renderer.close()
            self._renderer = None
        if self._http is not None:
            self._http.close()
            self._http = None

"""Playwright: görünür tarayıcıda MANUEL giriş + headless sayfa oluşturma.

İlke: CAPTCHA, SMS kodu, e-Devlet adımları kullanıcı tarafından tamamlanır. Bu modül yalnızca
oturumun açıldığını algılar ve çerezleri (storage_state) şifreli depoya kaydeder.
"""

from __future__ import annotations

import logging
import select
import sys
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin, urlsplit

from ..config import AppConfig, PlatformConfig
from .store import SessionStore

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, Page

log = logging.getLogger(__name__)

BLOCKED_RESOURCES = {"image", "media", "font"}


def is_logged_out(html: str, url: str, pcfg: PlatformConfig) -> bool:
    """Doğrulanmış 'oturum kapalı' işaretlerinden biri sayfada var mı?"""
    if any(marker in html for marker in pcfg.logged_out_markers):
        return True
    path = urlsplit(url).path.lower()
    return path.endswith("/login/index.php")


def _same_site(url: str, pcfg: PlatformConfig) -> bool:
    site, target = urlsplit(pcfg.base_url), urlsplit(url)
    default_port = 443 if site.scheme == "https" else 80
    return (site.scheme, site.hostname, site.port or default_port) == (
        target.scheme, target.hostname, target.port or default_port,
    )


class LoginDetector:
    """Girişin tamamlandığını algılar: önce 'oturum kapalı' sayfası görülmeli, ardından aynı sitede
    art arda 2 kez işaretsiz sayfa gelmeli (e-Devlet gibi başka alan adlarındaki adımlar sayılmaz)."""

    def __init__(self, pcfg: PlatformConfig, required_positives: int = 2):
        self.pcfg = pcfg
        self.required = required_positives
        self.seen_logged_out = False
        self.positives = 0

    def feed(self, html: str | None, url: str) -> bool:
        if not html or not _same_site(url, self.pcfg):
            self.positives = 0
            return False
        if is_logged_out(html, url, self.pcfg):
            self.seen_logged_out = True
            self.positives = 0
            return False
        if self.seen_logged_out:
            self.positives += 1
        return self.positives >= self.required


def _drain_stdin() -> None:
    try:
        if sys.stdin and sys.stdin.isatty():
            import termios
            termios.tcflush(sys.stdin, termios.TCIFLUSH)
    except (OSError, ValueError, ImportError):
        pass


def enter_pressed() -> bool:
    """Bloklamadan: terminalde Enter'a basıldı mı? (Arka planda stdin okuyan iş parçacığı bırakmaz.)"""
    try:
        if not sys.stdin or not sys.stdin.isatty():
            return False
        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if ready:
            sys.stdin.readline()
            return True
    except (OSError, ValueError):
        pass
    return False


def _check_session(context: BrowserContext, pcfg: PlatformConfig) -> bool:
    """Check a fresh response from the school without following an external login redirect."""
    from playwright.sync_api import Error as PlaywrightError

    url = pcfg.session_check_url or pcfg.base_url
    try:
        for _ in range(4):
            if not _same_site(url, pcfg):
                return False
            response = context.request.get(url, max_redirects=0, timeout=10000)
            try:
                location = response.headers.get("location")
                if response.status in (301, 302, 303, 307, 308) and location:
                    url = urljoin(url, location)
                    continue
                return response.ok and not is_logged_out(response.text(), url, pcfg)
            finally:
                response.dispose()
    except (PlaywrightError, ValueError):
        return False
    return False


def _site_storage_state(context: BrowserContext, pcfg: PlatformConfig) -> dict[str, Any]:
    state = context.storage_state()
    host = urlsplit(pcfg.base_url).hostname or ""
    return {
        "cookies": [cookie for cookie in state["cookies"]
                    if cookie["domain"].lstrip(".") == host
                    or (cookie["domain"].startswith(".") and host.endswith(cookie["domain"]))],
        "origins": [entry for entry in state["origins"] if _same_site(entry["origin"], pcfg)],
    }


def _login_document(page: Page | None, pcfg: PlatformConfig) -> tuple[str | None, str]:
    from playwright.sync_api import Error as PlaywrightError

    url = page.url if page is not None else ""
    if page is None or not _same_site(url, pcfg):
        return None, url
    site = urlsplit(url)
    try:
        # page.url can change while evaluate is sent. Check the origin again inside the browser.
        html = page.evaluate("""(origin) => location.origin === origin && document.readyState !== 'loading'
            ? document.documentElement.outerHTML : null""", f"{site.scheme}://{site.netloc}")
        return html, url
    except PlaywrightError:  # sayfa yönlendiriliyor olabilir
        return None, url


def interactive_login(
    name: str,
    pcfg: PlatformConfig,
    app: AppConfig,
    store: SessionStore,
    *,
    timeout_minutes: int = 15,
    manual_confirm: bool = False,
) -> dict[str, Any]:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright

    auto = bool(pcfg.logged_out_markers) and not manual_confirm
    print(f"\n[{pcfg.display_name}] Tarayıcı açılıyor. Giriş işlemini sitenin kendi sayfasında tamamla. "
          "e-Devlet kullanıyorsan okul sitesine dönene kadar pencereyi açık tut.")
    if auto:
        print("Giriş tamamlanınca otomatik algılanacak. Algılanmazsa bu terminalde Enter'a bas.")
    else:
        print("Giriş tamamlanınca bu terminalde Enter'a bas.")
    _drain_stdin()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(locale="tr-TR", timezone_id=app.timezone, viewport={"width": 1280, "height": 860})
        detector = LoginDetector(pcfg)
        deadline = time.monotonic() + timeout_minutes * 60
        try:
            context.new_page().goto(pcfg.login_url or pcfg.base_url, wait_until="domcontentloaded")
            while True:
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        f"{timeout_minutes} dakika içinde giriş algılanmadı. Girişi tamamladıysan "
                        f"`unitakip login {name} --manual` ile tekrar dene ve Enter'a bas.")
                pages = context.pages
                if not pages:
                    raise RuntimeError("Tarayıcı penceresi giriş tamamlanmadan kapatıldı.")
                confirmed = enter_pressed()
                try:
                    pages[-1].wait_for_timeout(1000)
                except PlaywrightError:  # sekme kapanmış olabilir
                    pass
                if not auto and not confirmed:
                    continue

                # Son sekme aynı sitedeyse onu kullan: bazı giriş sağlayıcıları yeni bir sekme açar.
                pages = context.pages
                page = pages[-1] if pages else None
                html, url = _login_document(page, pcfg)
                detected = auto and detector.feed(html, url)
                if not (confirmed or detected):
                    continue
                if page is not None and html and not is_logged_out(html, url, pcfg) and _check_session(context, pcfg):
                    user_agent = page.evaluate("navigator.userAgent")
                    state = _site_storage_state(context, pcfg)
                    break
                if confirmed:
                    print("Okul oturumu henüz doğrulanamadı. Okul sayfasına dönüp giriş tamamlandıktan sonra Enter'a bas.")
                detector.positives = 0
        finally:
            browser.close()

    record = {"storage_state": state, "user_agent": user_agent, "base_url": pcfg.base_url, "platform": name}
    store.save(f"{name}.session", record)
    log.info("%s: okul oturumu doğrulandı ve şifreli olarak kaydedildi.", name)
    return record


class BrowserRenderer:
    """Kayıtlı oturumla headless Chromium'da sayfa oluşturur (JS ile yüklenen içerik için)."""

    def __init__(self, session: dict[str, Any], app: AppConfig, min_interval: float):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        self.context = self._browser.new_context(
            storage_state=session["storage_state"], user_agent=session.get("user_agent"),
            locale="tr-TR", timezone_id=app.timezone,
        )
        self.context.route("**/*", self._route)
        self._min_interval = min_interval
        self._last = 0.0

    @staticmethod
    def _route(route) -> None:  # type: ignore[no-untyped-def]
        if route.request.resource_type in BLOCKED_RESOURCES:
            route.abort()
        else:
            route.continue_()

    def get(self, url: str, wait_selector: str | None = None, timeout_ms: int = 45000) -> tuple[str, str]:
        wait = self._min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        page = self.context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:  # noqa: BLE001 - uzun süren arka plan istekleri olabilir
                pass
            if wait_selector:
                try:
                    page.wait_for_selector(wait_selector, timeout=15000)
                except Exception:  # noqa: BLE001
                    log.warning("Beklenen seçici görünmedi: %s", wait_selector)
            return page.content(), page.url
        finally:
            self._last = time.monotonic()
            page.close()

    def storage_state(self) -> dict[str, Any]:
        return self.context.storage_state()

    def close(self) -> None:
        try:
            self._browser.close()
        finally:
            self._pw.stop()

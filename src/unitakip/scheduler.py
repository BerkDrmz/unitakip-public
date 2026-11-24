"""Uygulama bağlamı, platform çalıştırıcı ve 7/24 zamanlayıcı döngüsü."""

from __future__ import annotations

import fcntl
import json
import logging
import os
import random
import shutil
import sqlite3
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

import httpx

from .adapters.base import Adapter, AdapterError, AuthExpired, AuthMissing, LoginFailed
from .ai import AnalysisService
from .ai.base import Analysis, AnalysisInput
from .ai.textextract import extract_text
from .archive import Archive, ArchivedFile, DiskFull
from .config import AppConfig
from .crypto import SecretBox
from .diff import DetectedChange, apply_snapshot, row_to_item
from .http import TransientError
from .models import Item, Kind, RemoteFile, iso, parse_iso, utcnow
from .notify.base import Attachment, ConsoleNotifier, Email, Notifier, NotifierError
from .notify.render import ChangeView, FileNote, render_digest, render_notice
from .session.store import SessionStore
from .storage.db import Database

log = logging.getLogger(__name__)

AdapterFactory = Callable[["App", str], Adapter]
MAX_CHANGES_PER_EMAIL = 40
ISOLATE_AFTER_ATTEMPTS = 2  # bir grup bu kadar başarısız olduysa değişiklikler tek tek gönderilir


def default_adapter_factory(app: "App", name: str) -> Adapter:
    pcfg = app.cfg.platform(name)
    if pcfg.type == "moodle":
        from .adapters.moodle import MoodleAdapter
        return MoodleAdapter(name, pcfg, app.cfg, app.store)
    from .adapters.webpages import WebPagesAdapter
    return WebPagesAdapter(name, pcfg, app.cfg, app.store)


def make_notifier(cfg: AppConfig, store: SessionStore) -> Notifier:
    if cfg.notify.provider == "gmail_api":
        from .notify.gmail import GmailNotifier
        return GmailNotifier(store, cfg.notify.to)
    if cfg.notify.provider == "gmail_smtp":
        from .notify.smtp import GmailSMTPNotifier
        return GmailSMTPNotifier(store, cfg.notify.to)
    return ConsoleNotifier(cfg.outbox_dir, cfg.notify.to)


class App:
    def __init__(self, cfg: AppConfig, *, notifier: Notifier | None = None,
                 adapter_factory: AdapterFactory | None = None, box: SecretBox | None = None,
                 clock: Callable[[], datetime] = utcnow, db_path: Path | None = None,
                 files_dir: Path | None = None):
        self.cfg = cfg
        files_dir = files_dir or cfg.files_dir
        for d in (cfg.data_dir, files_dir, cfg.logs_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.box = box or SecretBox.from_env()
        self.store = SessionStore(cfg.secrets_dir, self.box)
        self.db = Database(db_path or cfg.db_path)
        self.archive = Archive(self.db, files_dir)
        self.ai = AnalysisService(cfg.ai, self.db, cfg.timezone)
        self.tz = ZoneInfo(cfg.timezone)
        self.clock = clock
        self._notifier = notifier
        self.adapter_factory = adapter_factory or default_adapter_factory

    @property
    def notifier(self) -> Notifier:
        if self._notifier is None:
            self._notifier = make_notifier(self.cfg, self.store)
        return self._notifier

    def make_adapter(self, name: str) -> Adapter:
        return self.adapter_factory(self, name)

    def close(self) -> None:
        self.db.close()


@dataclass(slots=True)
class RunResult:
    platform: str
    status: str  # ok | auth | transient | error
    items: int = 0
    changes: int = 0
    notified: int = 0
    error: str | None = None


def prepare_dry_run(cfg: AppConfig) -> tuple[Path, Path]:
    """Kuru çalıştırma için gerçek veritabanının geçici bir kopyası (gerçek durum hiç değişmez)."""
    tmp = Path(tempfile.mkdtemp(prefix="unitakip-dry-"))
    db_copy = tmp / "dry.sqlite3"
    if cfg.db_path.is_file():
        src = sqlite3.connect(cfg.db_path)
        dst = sqlite3.connect(db_copy)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
    return tmp, db_copy


def cleanup_dry_run(tmp: Path) -> None:
    shutil.rmtree(tmp, ignore_errors=True)


class Runner:
    def __init__(self, app: App):
        self.app = app
        self.cfg = app.cfg
        self.db = app.db
        self._flush_backoff_until: datetime | None = None
        self._flush_failures = 0
        self._downloads_blocked = False
        self.current_run: tuple[str, datetime] | None = None

    # ---------------------------------------------------------------- zamanlama
    def _next_run(self, now: datetime) -> datetime:
        jitter = random.uniform(-self.cfg.jitter_minutes, self.cfg.jitter_minutes)
        return now + timedelta(minutes=self.cfg.check_interval_minutes + jitter)

    def _retry_after(self, failures: int) -> timedelta:
        minutes = min(10 * (2 ** max(failures - 1, 0)), self.cfg.check_interval_minutes)
        return timedelta(minutes=minutes)

    def due_platforms(self, now: datetime) -> list[str]:
        due = []
        horizon = timedelta(minutes=2 * self.cfg.check_interval_minutes + self.cfg.jitter_minutes)
        for name in self.cfg.enabled_platforms():
            st = self.db.get_state(name)
            if st.next_run_at is not None and st.next_run_at - now > horizon:
                # Sistem saati geri alınmış olabilir: sonraki kontrol makul aralığın çok ötesinde → şimdi çalıştır
                log.warning("%s: sonraki kontrol zamanı (%s) makul değil, hemen çalıştırılıyor.", name, iso(st.next_run_at))
                due.append(name)
            elif st.next_run_at is None or st.next_run_at <= now:
                due.append(name)
        return due

    # ------------------------------------------------------------- çalıştırma
    def run_platform(self, name: str, *, notify: bool = True) -> RunResult:
        pcfg = self.cfg.platform(name)
        now = self.app.clock()
        run_id = self.db.start_run(name, now)
        self.db.update_state(name, last_run_at=now)
        result = RunResult(platform=name, status="ok")
        adapter: Adapter | None = None
        self._downloads_blocked = False
        self.current_run = (name, now)
        try:
            adapter = self.app.make_adapter(name)
            snap = adapter.fetch()
            changes = apply_snapshot(self.db, snap, self.app.clock(), notify_removed=pcfg.notify_removed,
                                     notify_new_course=self.cfg.notify.notify_new_course, tz=self.app.tz)
            result.items, result.changes = len(snap.items), len(changes)
            self._scope_health(name, snap, notify)
            loud = [c for c in changes if not c.silent]
            self._process(adapter, loud)
            if pcfg.download_files and pcfg.download_existing_files:
                self._archive_only(adapter, [c for c in changes if c.silent and c.change_type != "removed"])
            if pcfg.download_files:
                self._retry_files(adapter)
            if snap.failed_scopes:
                log.warning("%s: %d kapsam alınamadı: %s", name, len(snap.failed_scopes),
                            ", ".join(sorted(snap.failed_scopes))[:300])
            self.db.update_state(name, auth_status="ok", last_success_at=self.app.clock(), consecutive_failures=0,
                                 last_error=None, reauth_notified_at=None, unreachable_notified_at=None,
                                 next_run_at=self._next_run(self.app.clock()))
            log.info("%s: %d öğe, %d değişiklik (%d bildirilecek).", name, result.items, result.changes, len(loud))
        except (AuthMissing, AuthExpired, LoginFailed) as exc:
            result.status, result.error = "auth", str(exc)
            status = "missing" if isinstance(exc, AuthMissing) else "expired"
            self.db.update_state(name, auth_status=status, last_error=str(exc)[:500],
                                 next_run_at=self._next_run(self.app.clock()))
            log.warning("%s: yeniden giriş gerekli: %s", name, exc)
            if notify:
                self._notify_reauth(name, str(exc))
        except (TransientError, httpx.HTTPError, OSError) as exc:
            self._fail(name, result, exc, "transient", notify)
        except Exception as exc:  # noqa: BLE001 - bir platformun hatası diğerlerini durdurmamalı
            log.exception("%s: beklenmeyen hata", name)
            self._fail(name, result, exc, "error", notify)
        finally:
            if adapter is not None:
                try:
                    adapter.close()
                except Exception:  # noqa: BLE001
                    log.debug("adapter.close hatası", exc_info=True)
            self.db.finish_run(run_id, status=result.status, items_seen=result.items, changes=result.changes,
                               error=result.error)
            self.current_run = None
        if notify:
            try:
                result.notified = self.flush(name)
            except Exception:  # noqa: BLE001 - flush kendi hatalarını yakalar; bu son savunma hattı
                log.exception("%s: bildirim aşamasında beklenmeyen hata", name)
        return result

    def _fail(self, name: str, result: RunResult, exc: Exception, status: str, notify: bool) -> None:
        st = self.db.get_state(name)
        failures = st.consecutive_failures + 1
        result.status, result.error = status, f"{type(exc).__name__}: {exc}"
        self.db.update_state(name, consecutive_failures=failures, last_error=result.error[:500],
                             next_run_at=self.app.clock() + self._retry_after(failures))
        log.warning("%s: çalıştırma başarısız (%d. ardışık): %s", name, failures, result.error)
        if notify and failures >= self.cfg.notify.unreachable_after_failures and st.unreachable_notified_at is None:
            pcfg = self.cfg.platform(name)
            if status == "transient":
                title = f"{pcfg.display_name} erişilemiyor"
                hint = ("Sorun sürerse sunucunun ağ bağlantısını veya sitenin yurt dışı IP engeli olup olmadığını "
                        "kontrol et (scripts/check-reachability.sh).")
            else:
                title = f"{pcfg.display_name} kontrolünde hata"
                hint = ("Bu bir yazılım hatası ya da sitenin yapısındaki bir değişiklik olabilir. Ayrıntı: "
                        "data/logs/unitakip.log. Diğer platformlar etkilenmiyor.")
            email = render_notice(self.cfg.notify.subject_prefix, title, [
                f"{pcfg.display_name} için son {failures} kontrol başarısız oldu.",
                f"Son hata: {result.error[:300]}",
                "Sistem kontrollü aralıklarla denemeye devam ediyor.",
                hint,
            ])
            if self._send_notice(email):
                self.db.update_state(name, unreachable_notified_at=self.app.clock())

    def _scope_health(self, name: str, snap, notify: bool) -> None:  # type: ignore[no-untyped-def]
        """Sürekli alınamayan bölümler ve kalıcı yapısal düşüşler için uyarı (sessiz arıza koruması)."""
        ok = snap.successful_scopes - set(snap.failed_scopes)
        self.db.record_scope_health(name, snap.failed_scopes, ok, self.app.clock())
        if not notify:
            return
        pcfg = self.cfg.platform(name)
        stuck = self.db.persistent_scope_failures(name, self.cfg.notify.scope_failure_alert_runs)
        if stuck:
            self._notice_once(f"scope_fail:{name}", 24, f"{pcfg.display_name}: bazı bölümler alınamıyor", [
                f"Aşağıdaki bölümler en az {self.cfg.notify.scope_failure_alert_runs} kontroldür alınamıyor. "
                "Bu bölümlerdeki değişiklikler şu an takip edilmiyor:",
                *[f"• {r['scope']} — {r['consecutive']} kez — {r['last_error']}" for r in stuck[:15]],
                "Olası neden: sitenin güncellenmesi, yetki değişikliği veya kapatılan bir özellik.",
            ])
        accepted = snap.meta.get("guard_accepted")
        if accepted:
            self._notice_once(f"structure:{name}", 6, f"{pcfg.display_name}: içerik beklenmedik şekilde azaldı", [
                "Aşağıdaki bölümlerde içerik sayısı birkaç kontroldür çok düşük; bu durum kalıcı kabul edildi:",
                *[f"• {a}" for a in accepted],
                "İçerik gerçekten kaldırıldıysa bir şey yapmana gerek yok. Sayfa yapısı değiştiyse izleme "
                "ayarlarının güncellenmesi gerekebilir (`unitakip discover " + name + " --apply`).",
            ])

    # --------------------------------------------------------------- bakım / izleme
    def housekeeping(self) -> None:
        """Her döngü adımında: uzun süre başarısızlık uyarısı, periyodik durum e-postası, günlük yedek."""
        now = self.app.clock()
        for name, pcfg in self.cfg.enabled_platforms().items():
            st = self.db.get_state(name)
            if st.auth_status in ("missing", "expired"):
                continue  # bunun için zaten "yeniden giriş gerekli" e-postası gidiyor
            ref = st.last_success_at
            if ref is None:
                continue
            if now - ref > timedelta(hours=self.cfg.notify.stale_after_hours):
                hours = int((now - ref).total_seconds() // 3600)
                self._notice_once(f"stale:{name}", 24, f"{pcfg.display_name}: {hours} saattir kontrol edilemiyor", [
                    f"Son başarılı kontrol: {ref.astimezone(self.app.tz).strftime('%d.%m.%Y %H:%M')}.",
                    f"Son hata: {(st.last_error or 'bilinmiyor')[:300]}",
                    "Bu süre içindeki değişiklikler, sorun çözülünce ilk başarılı kontrolde bildirilecek.",
                ])
        self._maybe_status_report(now)
        self._daily_maintenance(now)

    def _maybe_status_report(self, now: datetime) -> None:
        mode = self.cfg.notify.status_report
        if mode == "off":
            return
        local = now.astimezone(self.app.tz)
        if local.hour < self.cfg.notify.status_report_hour:
            return
        if mode == "weekly":
            if local.weekday() != self.cfg.notify.status_report_weekday:
                return
            key = f"status:{local.strftime('%G-W%V')}"
        else:
            key = f"status:{local.date().isoformat()}"
        if self.db.notice_sent_at(key) is not None:
            return
        tz = self.app.tz

        def fmt(dt: datetime | None) -> str:
            return dt.astimezone(tz).strftime("%d.%m %H:%M") if dt else "—"

        stats = self.db.stats()
        lines = ["UniTakip çalışıyor. Bu özet düzenli gelmezse sistemde bir sorun var demektir.", ""]
        for name, pcfg in self.cfg.enabled_platforms().items():
            st = self.db.get_state(name)
            lines.append(f"• {pcfg.display_name}: oturum {st.auth_status}, son başarılı kontrol {fmt(st.last_success_at)},"
                         f" sonraki {fmt(st.next_run_at)}, ardışık hata {st.consecutive_failures}"
                         + (f" — son hata: {st.last_error[:120]}" if st.last_error else ""))
        try:
            free_gb = self.app.archive.free_bytes() / 1024 ** 3
        except OSError:
            free_gb = float("nan")
        lines += ["", f"Takip edilen öğe: {stats['items']} · son 7 günde bildirilen değişiklik: {stats['notified_7d']}"
                      f" · bekleyen bildirim: {stats['pending']}",
                  f"Arşiv: {stats['files']} dosya, {stats['files_bytes'] / 1024 ** 2:.0f} MB · boş disk: {free_gb:.1f} GB"]
        if self.cfg.ai.provider == "anthropic":
            lines.append(f"AI maliyeti (bu ay): ${self.db.ai_month_cost('anthropic'):.3f} / ${self.cfg.ai.monthly_budget_usd:.2f}")
        title = "Haftalık durum özeti" if mode == "weekly" else "Günlük durum özeti"
        if self._send_notice(render_notice(self.cfg.notify.subject_prefix, title, lines)):
            self.db.mark_notice(key, now)

    def _daily_maintenance(self, now: datetime) -> None:
        key = f"maintenance:{now.astimezone(self.app.tz).date().isoformat()}"
        if self.db.notice_sent_at(key) is not None:
            return
        try:
            day = now.astimezone(self.app.tz).strftime("%Y%m%d")
            self.db.backup_to(self.cfg.backups_dir / f"unitakip-{day}.sqlite3")
            backups = sorted(self.cfg.backups_dir.glob("unitakip-*.sqlite3"))
            for old in backups[: max(len(backups) - self.cfg.backup_keep_days, 0)]:
                old.unlink(missing_ok=True)
            self.db.prune(now)
            log.info("Günlük bakım tamam: veritabanı yedeklendi (%d yedek tutuluyor).", min(len(backups), self.cfg.backup_keep_days))
        except Exception:  # noqa: BLE001 - bakım hatası çalışmayı durdurmamalı
            log.exception("Günlük bakım başarısız")
            return
        self.db.mark_notice(key, now)

    def _fetch_file(self, adapter: Adapter, item: Item, rf: RemoteFile) -> ArchivedFile | None:
        """Tek dosya; hiçbir dosya hatası çalıştırmayı durdurmaz (oturum düşmesi hariç)."""
        if self._downloads_blocked:
            return None
        try:
            return self.app.archive.fetch(adapter, item, rf)
        except AuthExpired:
            raise
        except DiskFull as exc:
            self._downloads_blocked = True
            log.error("%s", exc)
            self._notice_once("disk_full", 24, "Disk dolu: dosya indirme durduruldu", [
                str(exc), "Bildirimler gönderilmeye devam ediyor; yalnızca dosyalar arşivlenmiyor.",
                "Yer açınca indirmeler kendiliğinden devam eder (ör. eski data/files ve data/backups).",
            ])
        except Exception:  # noqa: BLE001
            log.exception("Dosya işlenemedi: %s", rf.filename)
        return None

    def _archive_only(self, adapter: Adapter, changes: list[DetectedChange]) -> None:
        """Bildirim üretmeyen (baseline) öğelerin dosyalarını arşivle: download_existing_files: true."""
        for ch in changes:
            for rf in ch.item.files:
                self._fetch_file(adapter, ch.item, rf)

    def _retry_files(self, adapter: Adapter) -> None:
        """Geçici hatayla inmemiş dosyaları yeniden dene; bildirimi çoktan gittiyse kısa bir takip e-postası."""
        if self._downloads_blocked:
            return
        try:
            results = self.app.archive.retry_pending(adapter)
        except AuthExpired:
            raise
        except DiskFull as exc:
            self._downloads_blocked = True
            log.error("%s", exc)
            return
        for row, res in results:
            if res.status != "ok":
                continue
            linked = self.db.changes_for_file(row["source_key"])
            if any(c["notified_at"] is None and not c["silent"] for c in linked):
                continue  # bildirim henüz gitmedi: dosya o e-postaya eklenecek
            if not any(not c["silent"] for c in linked):
                continue  # bildirimsiz arşivleme
            item = self.db.get_item(adapter.name, row["item_external_id"])
            change_id = self.db.add_change(
                item_id=int(item["id"]), platform=adapter.name, change_type="file_ready",
                dedupe_key=f"{adapter.name}|{row['item_external_id']}|file_ready|{row['source_key']}",
                summary=f"Daha önce indirilemeyen dosya şimdi indirildi: {row['filename']}", silent=False,
                now=self.app.clock())
            if change_id is not None:
                self.db.link_change_file(change_id, row["source_key"], True)

    def _process(self, adapter: Adapter, changes: list[DetectedChange]) -> None:
        """Bildirilecek değişiklikler için dosyaları indir ve AI analizi yap."""
        for ch in changes:
            file_text = None
            if adapter.pcfg.download_files and ch.change_type != "removed":
                for rf in ch.item.files:
                    archived = self._fetch_file(adapter, ch.item, rf)
                    if archived is None:
                        continue
                    self.db.link_change_file(ch.change_id, rf.source_key(adapter.name), not archived.reused)
                    if archived.status == "ok" and archived.path and file_text is None:
                        file_text = extract_text(archived.path, self.cfg.ai.max_input_chars)
            try:
                analysis = self.app.ai.analyze(AnalysisInput(
                    platform=adapter.pcfg.display_name, kind=ch.item.kind, change_type=ch.change_type,
                    title=ch.item.title, course=ch.item.course_name, due_at=ch.item.due_at,
                    text=ch.item.text or "", diff_summary=ch.summary, file_text=file_text,
                ))
            except Exception:  # noqa: BLE001 - analiz yoksa bildirim gönderilirken yeniden denenir
                log.exception("AI analizi başarısız: %s", ch.item.title)
                continue
            self.db.set_change_ai(ch.change_id, analysis.to_dict())

    # ---------------------------------------------------------------- bildirim
    def flush(self, platform: str | None = None) -> int:
        """Bekleyen bildirimleri gönder. Hiçbir değişiklik kalıcı olarak düşürülmez; başarısızlıkta
        10 → 20 → 40 → 60 dk geri çekilir. Tekrar tekrar başarısız olan grup tek tek gönderilir ki
        bozuk tek bir kayıt (ör. okunamayan ek) tüm kuyruğu kilitlemesin."""
        now = self.app.clock()
        if self._flush_backoff_until and now < self._flush_backoff_until:
            return 0
        sent = 0
        failed = False
        names = [platform] if platform else list(self.cfg.platforms)
        for name in names:
            rows = self.db.pending_changes(name)
            while rows:
                batch, rows = rows[:MAX_CHANGES_PER_EMAIL], rows[MAX_CHANGES_PER_EMAIL:]
                isolate = len(batch) > 1 and max(int(r["notify_attempts"]) for r in batch) >= ISOLATE_AFTER_ATTEMPTS
                for group in ([[r] for r in batch] if isolate else [batch]):
                    status = self._send_group(name, group)
                    if status == "ok":
                        sent += len(group)
                    elif status == "channel":  # bildirim kanalı çalışmıyor: hepsini ertele
                        self._schedule_flush_retry(now)
                        return sent
                    else:
                        failed = True
        if failed:
            self._schedule_flush_retry(now)
        else:
            self._flush_failures = 0
            self._flush_backoff_until = None
        return sent

    def _schedule_flush_retry(self, now: datetime) -> None:
        self._flush_failures += 1
        minutes = min(10 * 2 ** (self._flush_failures - 1), 60)
        self._flush_backoff_until = now + timedelta(minutes=minutes)
        log.error("Bekleyen bildirimler %d dk sonra yeniden denenecek.", minutes)

    def _send_group(self, name: str, group: list) -> str:
        ids = [int(r["id"]) for r in group]
        try:
            email = self._build_digest(name, group)
            try:
                self.app.notifier.send(email)
            except NotifierError as exc:
                if not (getattr(exc, "permanent", False) and email.attachments):
                    raise
                # İleti reddedildi (çoğunlukla ek boyutu): ekleri çıkarıp bir kez daha dene
                log.warning("%s: ileti reddedildi (%s); ekler çıkarılıp yeniden deneniyor.", name, exc)
                self.app.notifier.send(self._build_digest(name, group, attach=False))
        except NotifierError as exc:
            self.db.mark_notify_failed(ids, str(exc))
            log.error("Bildirim gönderilemedi: %s", exc)
            return "item" if getattr(exc, "permanent", False) else "channel"
        except Exception as exc:  # noqa: BLE001 - bozuk içerik daemon'u düşürmemeli
            self.db.mark_notify_failed(ids, f"{type(exc).__name__}: {exc}")
            log.exception("%s: %d değişiklik için bildirim hazırlanamadı", name, len(ids))
            return "item"
        self.db.mark_notified(ids, self.app.clock())
        return "ok"

    def _build_digest(self, name: str, rows: list, *, attach: bool = True) -> Email:
        pcfg = self.cfg.platform(name)
        limit = int(self.cfg.notify.attach_max_total_mb * 1024 * 1024) if attach else -1
        total = 0
        attachments: list[Attachment] = []
        drive = self._drive_uploader()
        views: list[ChangeView] = []
        for row in rows:
            item = row_to_item(row)
            analysis = Analysis.from_dict(json.loads(row["ai_json"])) if row["ai_json"] else self.app.ai.analyze(
                AnalysisInput(platform=pcfg.display_name, kind=item.kind, change_type=row["change_type"],
                              title=item.title, course=item.course_name, due_at=item.due_at, text=item.text or "",
                              diff_summary=row["summary"]))
            notes: list[FileNote] = []
            for f in self.db.change_files(int(row["id"])):
                if f["status"] != "ok" or not f["path"]:
                    notes.append(FileNote(f["filename"], f["status"], f["error"] or ""))
                    continue
                path = Path(f["path"])
                if not path.is_file():
                    notes.append(FileNote(f["filename"], "error", "arşiv dosyası bulunamadı"))
                    continue
                if row["change_type"] == "updated" and not f["newly_downloaded"]:
                    notes.append(FileNote(f["filename"], "archived", "dosya değişmedi"))
                    continue
                size = path.stat().st_size
                if total + size <= limit:
                    attachments.append(Attachment(f["filename"], path))
                    total += size
                    notes.append(FileNote(f["filename"], "attached"))
                elif drive is not None:
                    try:
                        notes.append(FileNote(f["filename"], "drive", link=drive.upload(path, f["filename"])))
                    except Exception as exc:  # noqa: BLE001
                        log.warning("Drive yüklemesi başarısız: %s", exc)
                        notes.append(FileNote(f["filename"], "archived", f"{size / 1048576:.1f} MB"))
                else:
                    notes.append(FileNote(f["filename"], "archived", f"{size / 1048576:.1f} MB"))
            views.append(ChangeView(
                change_id=int(row["id"]), platform=name, platform_name=pcfg.display_name, kind=item.kind,
                change_type=row["change_type"], title=item.title, course=item.course_name, url=item.url,
                detected_at=parse_iso(row["detected_at"]) or self.app.clock(), due_at=item.due_at,
                summary=row["summary"], analysis=analysis, files=notes,
            ))
        return render_digest(views, pcfg.display_name, self.cfg.notify.subject_prefix, self.app.tz, attachments)

    def _drive_uploader(self):  # type: ignore[no-untyped-def]
        if not self.cfg.notify.drive_upload or self.cfg.notify.provider != "gmail_api":
            return None
        from .notify.gmail import DriveUploader, GmailNotifier
        notifier = self.app.notifier
        if isinstance(notifier, GmailNotifier) and notifier.has_drive_scope():
            return DriveUploader(notifier, self.cfg.notify.drive_folder_name)
        return None

    def _notice_once(self, key: str, every_hours: float, title: str, lines: list[str]) -> bool:
        """Aynı sistem bildirimini en fazla every_hours saatte bir gönder."""
        last = self.db.notice_sent_at(key)
        now = self.app.clock()
        if last is not None and now - last < timedelta(hours=every_hours):
            return False
        if self._send_notice(render_notice(self.cfg.notify.subject_prefix, title, lines)):
            self.db.mark_notice(key, now)
            return True
        return False

    def _send_notice(self, email: Email) -> bool:
        try:
            self.app.notifier.send(email)
            return True
        except Exception as exc:  # noqa: BLE001 - sistem bildirimi hiçbir şeyi düşürmemeli
            log.error("Sistem bildirimi gönderilemedi: %s", exc)
            return False

    def _notify_reauth(self, name: str, reason: str) -> None:
        st = self.db.get_state(name)
        now = self.app.clock()
        if st.reauth_notified_at and now - st.reauth_notified_at < timedelta(hours=self.cfg.notify.reauth_reminder_hours):
            return
        pcfg = self.cfg.platform(name)
        email = render_notice(self.cfg.notify.subject_prefix, f"{pcfg.display_name}: yeniden giriş gerekli", [
            f"{pcfg.display_name} için oturum geçersiz ya da henüz giriş yapılmadı.",
            f"Ayrıntı: {reason[:300]}",
            "Diğer platformların takibi kesintisiz devam ediyor.",
            "Mac'inde proje klasöründe şunu çalıştır (giriş adımlarını sen tamamlarsın):",
            f"$ .venv/bin/unitakip login {name}",
            "Sistem bir sunucuda çalışıyorsa oturumu oraya aktar:",
            "$ scripts/push-session.sh kullanici@sunucu",
            f"Bu hatırlatma en fazla {self.cfg.notify.reauth_reminder_hours} saatte bir gönderilir.",
        ])
        if self._send_notice(email):
            self.db.update_state(name, reauth_notified_at=now)

    # ---------------------------------------------------------------- canlı tutma
    def keepalive_due(self, name: str, now: datetime) -> bool:
        pcfg = self.cfg.platform(name)
        if pcfg.keepalive_minutes <= 0:
            return False
        st = self.db.get_state(name)
        if st.auth_status != "ok":
            return False
        last = max(filter(None, [st.last_keepalive_at, st.last_success_at]), default=None)
        return last is None or now - last >= timedelta(minutes=pcfg.keepalive_minutes)

    def keepalive(self, name: str) -> bool:
        adapter: Adapter | None = None
        try:
            adapter = self.app.make_adapter(name)
            ok = adapter.keepalive()
        except (AdapterError, TransientError, httpx.HTTPError) as exc:
            log.warning("%s: canlı tutma isteği başarısız: %s", name, exc)
            ok = True
        finally:
            if adapter is not None:
                adapter.close()
        self.db.update_state(name, last_keepalive_at=self.app.clock())
        if not ok:
            self.db.update_state(name, auth_status="expired", last_error="canlı tutma: oturum düşmüş")
            self._notify_reauth(name, "Canlı tutma isteğinde oturumun düştüğü görüldü.")
        return ok


# ------------------------------------------------------------------- daemon
class InstanceLock:
    def __init__(self, path: Path):
        self.path = path
        self._fh = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("a+")
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(f"Başka bir UniTakip örneği çalışıyor (kilit: {self.path}).") from exc
        self._fh.seek(0)
        self._fh.truncate()
        self._fh.write(str(os.getpid()))
        self._fh.flush()

    def release(self) -> None:
        if self._fh:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            self._fh.close()
            self._fh = None

    def __enter__(self) -> "InstanceLock":
        self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


def write_heartbeat(app: App) -> None:
    states = {}
    for name in app.cfg.enabled_platforms():
        st = app.db.get_state(name)
        states[name] = {"auth": st.auth_status, "next_run_at": iso(st.next_run_at),
                        "last_success_at": iso(st.last_success_at), "failures": st.consecutive_failures}
    path = app.cfg.data_dir / "heartbeat.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"ts": iso(utcnow()), "platforms": states}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def heartbeat_age(data_dir: Path) -> timedelta | None:
    path = data_dir / "heartbeat.json"
    if not path.is_file():
        return None
    ts = parse_iso(json.loads(path.read_text(encoding="utf-8")).get("ts"))
    return utcnow() - ts if ts else None


def _tick(app: App, runner: Runner, stop: threading.Event) -> None:
    for name in runner.due_platforms(app.clock()):
        if stop.is_set():
            return
        write_heartbeat(app)
        runner.run_platform(name)
    for name in app.cfg.enabled_platforms():
        if not stop.is_set() and runner.keepalive_due(name, app.clock()):
            runner.keepalive(name)
    if app.db.pending_count():
        runner.flush()
    runner.housekeeping()
    write_heartbeat(app)


def _watchdog(runner: Runner, stop: threading.Event, limit: timedelta, exit_fn: Callable[[int], None],
              poll_seconds: float = 30.0) -> None:
    """Bir platform kontrolü takılırsa (ör. tarayıcı yanıt vermiyor) süreci sonlandır: Docker
    `restart: unless-stopped` konteyneri yeniden başlatır, zamanlama kaldığı yerden devam eder."""
    while not stop.wait(poll_seconds):
        current = runner.current_run
        if current and utcnow() - current[1] > limit:
            log.critical("%s kontrolü %d dakikadır sürüyor; süreç yeniden başlatılıyor.", current[0],
                         int(limit.total_seconds() // 60))
            logging.shutdown()
            exit_fn(70)
            return


def run_daemon(app: App, stop: threading.Event | None = None, max_ticks: int | None = None,
               exit_fn: Callable[[int], None] = os._exit) -> None:
    stop = stop or threading.Event()
    runner = Runner(app)
    app.archive.cleanup_tmp()
    log.info("UniTakip başladı: %s. Kontrol aralığı %d dk.", ", ".join(app.cfg.enabled_platforms()) or "(platform yok)",
             app.cfg.check_interval_minutes)
    watchdog = threading.Thread(
        target=_watchdog, args=(runner, stop, timedelta(minutes=app.cfg.run_timeout_minutes), exit_fn),
        daemon=True, name="watchdog")
    watchdog.start()
    ticks = 0
    while not stop.is_set():
        try:
            _tick(app, runner, stop)
        except Exception:  # noqa: BLE001 - tek bir adımın hatası 7/24 döngüyü durdurmamalı
            log.exception("Zamanlayıcı adımında beklenmeyen hata; döngü devam ediyor.")
        ticks += 1
        if max_ticks is not None and ticks >= max_ticks:
            break
        stop.wait(app.cfg.tick_seconds)
    stop.set()  # bekçi iş parçacığını da durdur
    log.info("UniTakip durduruldu.")


__all__ = ["App", "Runner", "RunResult", "InstanceLock", "run_daemon", "heartbeat_age", "Kind"]

"""Entegrasyon: uçtan uca çalıştırma, yeniden başlatma, oturum kaybı, hata yalıtımı, bildirim yeniden denemesi."""

from __future__ import annotations

import threading
from datetime import timedelta

import pytest

from unitakip.adapters.moodle import MoodleAdapter
from unitakip.http import TransientError
from unitakip.notify.base import ConsoleNotifier, NotifierError
from unitakip.scheduler import App, InstanceLock, Runner, heartbeat_age, run_daemon

from .conftest import emails, http_for


def test_end_to_end_baseline_then_changes(app, moodle):
    runner = Runner(app)
    first = runner.run_platform("sanal")
    assert first.status == "ok" and first.items > 5
    assert emails(app) == []  # ilk tarama = baseline, bildirim yok
    assert moodle.downloads == []  # baseline dosyaları indirilmez

    # Platformda değişiklikler olsun
    moodle.files["hafta2.pdf"] = b"%PDF hafta iki"
    moodle.sections[10][0]["modules"][0]["contents"].append(moodle.file_entry("hafta2.pdf", 1700100000))
    moodle.assignments[0]["duedate"] += 86400  # teslim tarihi bir gün uzadı
    moodle.discussions[50].insert(0, {"id": 501, "discussion": 501, "subject": "Vize sınavı ertelendi",
                                      "message": "<p>Vize 20.12.2026 tarihine ertelendi.</p>",
                                      "userfullname": "Dr. Hoca", "attachments": []})
    moodle.grades[10][0]["gradeformatted"] = "85,00"

    second = runner.run_platform("sanal")
    assert second.status == "ok" and second.notified == 4
    assert moodle.downloads == ["hafta2.pdf"]
    [mail] = emails(app)
    assert "4 değişiklik" in mail.subject and "[ÖNEMLİ]" in mail.subject
    for needle in ("hafta2.pdf", "Vize sınavı ertelendi", "Teslim tarihi", "85,00", "Matematik I"):
        assert needle in mail.text, needle
    assert [a.filename for a in mail.attachments] == ["hafta2.pdf"]
    assert list((app.cfg.files_dir / "sanal").rglob("*hafta2.pdf"))

    third = runner.run_platform("sanal")
    assert third.changes == 0 and len(emails(app)) == 1 and moodle.downloads == ["hafta2.pdf"]


def test_restart_resumes_without_duplicates(app, moodle, cfg, box):
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.discussions[50].insert(0, {"id": 502, "discussion": 502, "subject": "Yeni duyuru",
                                      "message": "x", "attachments": []})
    # Bildirim gönderilemeden "çöktü": notifier hata veriyor
    class Broken(ConsoleNotifier):
        def send(self, email):  # type: ignore[no-untyped-def]
            raise NotifierError("ağ yok")
    app._notifier = Broken(cfg.outbox_dir)
    runner.run_platform("sanal")
    assert app.db.pending_count() == 1
    next_run = app.db.get_state("sanal").next_run_at
    app.close()

    # Yeni süreç: aynı veri klasörü
    app2 = App(cfg, notifier=ConsoleNotifier(cfg.outbox_dir), box=box, adapter_factory=app.adapter_factory)
    try:
        assert app2.db.get_state("sanal").next_run_at == next_run  # zamanlama kalıcı
        r2 = Runner(app2)
        assert "sanal" not in r2.due_platforms(app2.clock())  # vakti gelmeden tekrar çalışmaz
        assert r2.flush() == 1 and app2.db.pending_count() == 0  # bekleyen bildirim gönderildi
        assert r2.run_platform("sanal").changes == 0  # aynı değişiklik yeniden algılanmaz
        assert len(app2.notifier.sent) == 1
    finally:
        app2.close()


def test_session_loss_notifies_once_and_recovers(app, moodle):
    runner = Runner(app)
    runner.run_platform("sanal")
    moodle.valid = False
    r = runner.run_platform("sanal")
    assert r.status == "auth" and app.db.get_state("sanal").auth_status == "expired"
    assert len(emails(app)) == 1 and "yeniden giriş gerekli" in emails(app)[0].subject
    assert "unitakip login sanal" in emails(app)[0].text
    runner.run_platform("sanal")
    assert len(emails(app)) == 1  # 24 saat içinde ikinci hatırlatma yok
    moodle.valid = True
    assert runner.run_platform("sanal").status == "ok"
    st = app.db.get_state("sanal")
    assert st.auth_status == "ok" and st.reauth_notified_at is None


def test_one_platform_failure_does_not_block_others(app, moodle, site):
    def factory(a, name):  # type: ignore[no-untyped-def]
        if name == "web":
            raise RuntimeError("beklenmeyen hata")
        return MoodleAdapter(name, a.cfg.platform(name), a.cfg, a.store, http=http_for(moodle.handler))

    app.adapter_factory = factory
    run_daemon(app, threading.Event(), max_ticks=1)
    assert app.db.get_state("sanal").last_success_at is not None
    web = app.db.get_state("web")
    assert web.consecutive_failures == 1 and "beklenmeyen" in web.last_error
    assert heartbeat_age(app.cfg.data_dir) < timedelta(minutes=1)


def test_transient_backoff_and_unreachable_notice(app):
    class Flaky:
        name = "web"
        pcfg = app.cfg.platform("web")

        def fetch(self):
            raise TransientError("bağlantı zaman aşımı")

        def close(self):
            pass

    app.adapter_factory = lambda a, n: Flaky()
    runner = Runner(app)
    t0 = app.clock()
    runner.run_platform("web")
    st = app.db.get_state("web")
    assert timedelta(minutes=9) < st.next_run_at - t0 < timedelta(minutes=11)
    runner.run_platform("web")
    st = app.db.get_state("web")
    assert st.consecutive_failures == 2 and timedelta(minutes=19) < st.next_run_at - t0 < timedelta(minutes=21)
    assert len(emails(app)) == 1 and "erişilemiyor" in emails(app)[0].subject
    runner.run_platform("web")
    assert len(emails(app)) == 1  # erişilemiyor bildirimi bir kez


def test_web_platform_end_to_end(app, site):
    runner = Runner(app)
    assert runner.run_platform("web").status == "ok"
    site.page = site.page.replace("<td>-</td>", "<td>55</td>").replace("Yeni dönem başladı.", "Final programı açıklandı.")
    r = runner.run_platform("web")
    assert r.notified == 2
    text = emails(app)[0].text
    assert "Final: - → 55" in text or "55" in text
    assert "Final programı açıklandı" in text


def test_instance_lock(tmp_path):
    with InstanceLock(tmp_path / "l.lock"):
        with pytest.raises(RuntimeError, match="Başka bir"):
            InstanceLock(tmp_path / "l.lock").acquire()
    InstanceLock(tmp_path / "l.lock").acquire()

"""Dosya arşivi, metin çıkarma ve AI katmanı."""

from __future__ import annotations

import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from unitakip.ai import AnalysisService
from unitakip.ai.base import Analysis, AnalysisInput, redact_personal
from unitakip.ai.heuristic import HeuristicAnalyzer, find_dates
from unitakip.ai.llm import validate
from unitakip.ai.textextract import extract_text
from unitakip.archive import Archive, safe_name
from unitakip.config import AIConfig, PlatformConfig
from unitakip.http import DownloadResult
from unitakip.models import Item, Kind, RemoteFile
from unitakip.storage.db import Database


class StubAdapter:
    def __init__(self, content: bytes, ctype: str = "application/pdf"):
        self.name = "p"
        self.pcfg = PlatformConfig(type="moodle", display_name="P", base_url="https://x", max_file_mb=1,
                                   file_extensions=["pdf", "docx"])
        self.content = content
        self.ctype = ctype
        self.calls = 0

    def download(self, rf, dest: Path, max_bytes: int) -> DownloadResult:  # type: ignore[no-untyped-def]
        import hashlib
        self.calls += 1
        dest.write_bytes(self.content)
        return DownloadResult(hashlib.sha256(self.content).hexdigest(), len(self.content), self.ctype, rf.url)


def _item(eid="f1") -> Item:
    return Item(platform="p", external_id=eid, kind=Kind.FILE, title="a.pdf", scope="s", course_name="Fizik/Lab")


def test_archive_dedupes_versions_and_content(tmp_path):
    db = Database(":memory:")
    arc = Archive(db, tmp_path / "files")
    ad = StubAdapter(b"%PDF icerik")
    rf = RemoteFile(url="https://x/a.pdf?token=gizli", filename="a.pdf", size=11, timemodified=1)
    first = arc.fetch(ad, _item(), rf)
    assert first.status == "ok" and first.path.is_file() and "Fizik_Lab" in str(first.path)
    again = arc.fetch(ad, _item(), RemoteFile(url="https://x/a.pdf?token=baska", filename="a.pdf", size=11, timemodified=1))
    assert again.reused and ad.calls == 1  # token farklı ama aynı sürüm → yeniden indirilmez
    other = arc.fetch(ad, _item("f2"), RemoteFile(url="https://x/kopya.pdf", filename="kopya.pdf", size=11, timemodified=1))
    assert other.reused and other.path == first.path and ad.calls == 2  # içerik SHA-256 ile tekil


def test_archive_limits(tmp_path):
    db = Database(":memory:")
    arc = Archive(db, tmp_path / "files")
    ad = StubAdapter(b"x")
    assert arc.fetch(ad, _item(), RemoteFile(url="https://x/v.mp4", filename="v.mp4")).status == "skipped"
    big = arc.fetch(ad, _item(), RemoteFile(url="https://x/b.pdf", filename="b.pdf", size=5 * 1024 * 1024))
    assert big.status == "skipped" and "boyut" in big.reason and ad.calls == 0


def test_safe_name():
    assert safe_name('../../etc/passwd') == "_.._etc_passwd"
    assert safe_name("Ödev: 1/2 *son*.pdf") == "Ödev_ 1_2 _son_.pdf"
    assert safe_name("a" * 300 + ".pdf").endswith(".pdf") and len(safe_name("a" * 300 + ".pdf")) <= 120


def test_turkish_date_parsing():
    tz = ZoneInfo("Europe/Istanbul")
    found = {raw: dt for dt, raw in find_dates("Son teslim 15 Kasım 2026 saat 17:00, vize 20.11.2026", tz)}
    assert found["15 Kasım 2026 saat 17:00"] == datetime(2026, 11, 15, 17, 0, tzinfo=tz)
    assert found["20.11.2026"].day == 20 and found["20.11.2026"].hour == 23


def _inp(**kw) -> AnalysisInput:
    base = {"platform": "Sanal", "kind": Kind.ANNOUNCEMENT, "change_type": "new", "title": "Duyuru",
            "course": "Fizik", "due_at": None, "text": "", "diff_summary": None}
    base.update(kw)
    return AnalysisInput(**base)


def test_heuristic_importance_and_deadline():
    h = HeuristicAnalyzer()
    future = (datetime.now(ZoneInfo("Europe/Istanbul")) + timedelta(days=20)).strftime("%d.%m.%Y")
    a = h.analyze(_inp(title="Vize sınavı ertelendi", text=f"Vize sınavı {future} tarihine ertelendi. Son tarih {future}."))
    assert a.importance == "kritik" and a.deadline and a.deadline.startswith(future[-4:])
    b = h.analyze(_inp(title="Office saatleri", text="Effect of something"))
    assert b.importance == "orta"  # "ff" / "office" yanlış eşleşmesi yok; duyuru en az orta
    due = datetime.now(UTC) + timedelta(days=1)
    c = h.analyze(_inp(kind=Kind.ASSIGNMENT, title="Ödev 2", due_at=due, text="Problem seti"))
    assert c.importance == "kritik" and c.priority == 1  # 2 günden az kaldı


def test_redact_personal():
    out = redact_personal("Mail: ali.veli@example.com tel 0532 123 45 67 TC 12345678901 öğrenci no: 20231234")
    assert "ali.veli" not in out and "0532" not in out and "12345678901" not in out and "20231234" not in out


def test_paid_provider_requires_explicit_opt_in():
    svc = AnalysisService(AIConfig(provider="anthropic", allow_paid=False), Database(":memory:"), "Europe/Istanbul")
    assert svc.llm is None and "allow_paid" in svc.llm_error
    assert svc.analyze(_inp(text="Duyuru metni")).source == "heuristic"


class FakeLLM:
    name = "fake"

    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def analyze(self, inp):  # type: ignore[no-untyped-def]
        self.calls.append(inp)
        if self.fail:
            raise RuntimeError("model yok")
        return Analysis(course="Fizik", topic=inp.title, summary="özet", importance="yüksek",
                        deadline="2030-01-01T00:00", actions=["oku"], priority=2, source="fake")


def test_llm_cache_sensitive_kinds_and_fallback():
    db = Database(":memory:")
    svc = AnalysisService(AIConfig(), db, "Europe/Istanbul")
    svc.llm = FakeLLM()
    svc.analyze(_inp(text="metin"))
    svc.analyze(_inp(text="metin"))
    assert len(svc.llm.calls) == 1  # önbellek
    svc.analyze(_inp(kind=Kind.GRADE, text="Vize: 85"))
    assert len(svc.llm.calls) == 1  # notlar harici modele gitmez
    due = datetime(2026, 12, 1, 12, 0, tzinfo=UTC)
    res = svc.analyze(_inp(text="başka", due_at=due))
    assert res.deadline.startswith("2026-12-01")  # platform tarihi model tarihini ezer
    svc.llm = FakeLLM(fail=True)
    fb = svc.analyze(_inp(text="yepyeni"))
    assert fb.source == "heuristic" and "kullanılamadı" in fb.notes[0]


def test_validate_clamps_model_output():
    a = validate({"importance": "ÇOK", "priority": 99, "actions": ["", "x"], "deadline": ""}, "t", False)
    assert a.importance == "orta" and a.priority == 5 and a.actions == ["x"] and a.deadline is None


def test_text_extraction(tmp_path):
    from docx import Document
    from pptx import Presentation

    d = Document()
    d.add_paragraph("Ödev teslimi 15 Kasım")
    d.save(tmp_path / "a.docx")
    assert "Ödev teslimi" in extract_text(tmp_path / "a.docx")
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "Hafta 3: Türev"
    prs.save(tmp_path / "s.pptx")
    assert "Türev" in extract_text(tmp_path / "s.pptx")
    with zipfile.ZipFile(tmp_path / "z.zip", "w") as zf:
        zf.writestr("odev/soru1.pdf", b"x")
    assert "odev/soru1.pdf" in extract_text(tmp_path / "z.zip")
    (tmp_path / "bozuk.pdf").write_bytes(b"%PDF bozuk")
    assert extract_text(tmp_path / "bozuk.pdf") is None

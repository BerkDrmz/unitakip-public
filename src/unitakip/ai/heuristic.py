"""Kural tabanlı analiz: ücretsiz, yerel, veri dışarı çıkmaz. Yalnızca içerikteki bilgileri kullanır."""

from __future__ import annotations

import re
from datetime import datetime
from zoneinfo import ZoneInfo

from ..models import Kind
from .base import Analysis, AnalysisInput

MONTHS = {
    "ocak": 1, "şubat": 2, "subat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "mayis": 5, "haziran": 6,
    "temmuz": 7, "ağustos": 8, "agustos": 8, "eylül": 9, "eylul": 9, "ekim": 10, "kasım": 11, "kasim": 11,
    "aralık": 12, "aralik": 12,
}
_TIME = r"(?:\s*(?:saat\s*)?(\d{1,2})[:.](\d{2}))?"
_NUMERIC = re.compile(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})" + _TIME)
_TEXTUAL = re.compile(r"(?i)(?<!\d)(\d{1,2})\s+(" + "|".join(MONTHS) + r")\s*(\d{4})?" + _TIME)
_ISO = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?")

_DEADLINE_HINT = re.compile(r"(?i)(son\s*(teslim|tarih|gün)|teslim|deadline|en\s*geç|kadar|bitiş|kapanış|sınav|vize|final|quiz)")

KEYWORDS = {
    "kritik": ["iptal", "ertelen", "erteleme", "tarih değişikliği", "saat değişikliği", "acil", "son gün", "bugün",
               "zorunlu", "devamsızlık sınırı", "devamsızlıktan kal", "ff", "sınav yeri", "salon değişikliği"],
    # "not" tek başına yok: "Ders Notu" materyalleri yanlışlıkla "yüksek" olmasın (notlar Kind.GRADE ile zaten yüksek)
    "yüksek": ["sınav", "vize", "final", "bütünleme", "quiz", "ödev", "proje", "teslim", "son teslim", "deadline",
               "notlar açıklandı", "not girişi", "notunuz", "harf notu", "sonuçlar", "sonuç açıklandı", "devamsızlık",
               "yoklama", "mazeret", "kısa sınav", "rapor teslim"],
    "orta": ["duyuru", "ders notu", "sunum", "materyal", "hafta", "kaynak", "okuma", "video", "canlı ders", "zoom",
             "teams", "slayt"],
}
# Sözcük başı sınırı: "effect" içindeki "ff" eşleşmesin; Türkçe ekler ("sınavı", "ödevin") eşleşsin
_KW_RE = {lvl: re.compile(r"(?<!\w)(" + "|".join(re.escape(k) for k in kws) + r")") for lvl, kws in KEYWORDS.items()}

ACTIONS = {
    Kind.ASSIGNMENT: "Ödev açıklamasını oku ve teslim tarihinden önce yükle",
    Kind.QUIZ: "Sınav/quiz zamanını takvime ekle ve konulara çalış",
    Kind.FILE: "Yeni materyali indir ve incele",
    Kind.ANNOUNCEMENT: "Duyuruyu oku, gerekiyorsa takvimini güncelle",
    Kind.EVENT: "Etkinlik tarihini takvime ekle",
    Kind.GRADE: "Notunu kontrol et, hata varsa dersin hocasıyla iletişime geç",
    Kind.ATTENDANCE: "Devamsızlık durumunu kontrol et, sınıra yaklaşıyorsan dikkat et",
    Kind.SECTION: "Yeni haftanın içeriğine göz at",
    Kind.MODULE: "Yeni etkinliği/kaynağı incele",
    Kind.LINK: "Bağlantıyı aç ve içeriği incele",
    Kind.PAGE: "Sayfadaki değişikliği kontrol et",
    Kind.TABLE_ROW: "Değişen kaydı kontrol et",
    Kind.COURSE: "Yeni dersin sayfasına göz at",
}


def find_dates(text: str, tz: ZoneInfo) -> list[tuple[datetime, str]]:
    found: list[tuple[datetime, str]] = []
    now = datetime.now(tz)

    def _add(y: int, mo: int, d: int, hh: str | None, mm: str | None, raw: str) -> None:
        try:
            dt = datetime(y, mo, d, int(hh) if hh else 23, int(mm) if mm else 59, tzinfo=tz)
        except ValueError:
            return
        found.append((dt, raw.strip()))

    for m in _ISO.finditer(text):
        _add(int(m[1]), int(m[2]), int(m[3]), m[4], m[5], m[0])
    for m in _NUMERIC.finditer(text):
        _add(int(m[3]), int(m[2]), int(m[1]), m[4], m[5], m[0])
    for m in _TEXTUAL.finditer(text):
        year = int(m[3]) if m[3] else now.year
        month = MONTHS[m[2].lower()]
        if not m[3] and month < now.month - 2:
            year += 1  # "15 Ocak" Kasım'da yazıldıysa gelecek yılı kastediyor
        _add(year, month, int(m[1]), m[4], m[5], m[0])
    return found


def _context(text: str, raw: str, width: int = 60) -> str:
    i = text.find(raw)
    return text[max(0, i - width): i + len(raw) + width] if i >= 0 else ""


def _summary(text: str, max_sentences: int = 3, max_chars: int = 400) -> str:
    clean = " ".join(text.split())
    sentences = re.split(r"(?<=[.!?])\s+", clean)
    out = " ".join(sentences[:max_sentences])
    return out[:max_chars].rstrip() + ("…" if len(out) > max_chars else "")


class HeuristicAnalyzer:
    name = "heuristic"

    def __init__(self, timezone: str = "Europe/Istanbul", max_input_chars: int = 12000):
        self.tz = ZoneInfo(timezone)
        self.max_input_chars = max_input_chars

    def analyze(self, inp: AnalysisInput) -> Analysis:
        text, truncated = inp.combined_text(self.max_input_chars)
        lower = f"{inp.title}\n{text}".lower()

        # Son tarih: önce yapılandırılmış alan, sonra metindeki tarih ifadeleri
        deadline: datetime | None = inp.due_at.astimezone(self.tz) if inp.due_at else None
        evidence = ""
        if deadline is None:
            candidates = []
            now = datetime.now(self.tz)
            for dt, raw in find_dates(f"{inp.title}\n{text}", self.tz):
                ctx = _context(f"{inp.title}\n{text}", raw)
                if dt >= now and _DEADLINE_HINT.search(ctx):
                    candidates.append((dt, ctx.strip()))
            if candidates:
                deadline, evidence = min(candidates, key=lambda c: c[0])

        importance = "düşük"
        for level in ("orta", "yüksek", "kritik"):
            if _KW_RE[level].search(lower):
                importance = level
        if inp.kind in (Kind.ASSIGNMENT, Kind.QUIZ, Kind.GRADE, Kind.ATTENDANCE) and importance in ("düşük", "orta"):
            importance = "yüksek"
        if inp.kind in (Kind.FILE, Kind.SECTION, Kind.MODULE, Kind.ANNOUNCEMENT) and importance == "düşük":
            importance = "orta"
        if inp.change_type == "updated" and inp.diff_summary and re.search(r"(?i)teslim|son tarih|kapanış|başlangıç", inp.diff_summary):
            importance = "kritik"
            evidence = evidence or inp.diff_summary[:200]

        days_left = (deadline - datetime.now(self.tz)).total_seconds() / 86400 if deadline else None
        if days_left is not None and 0 <= days_left <= 2 and importance != "kritik":
            importance = "kritik"
        priority = {"kritik": 1, "yüksek": 2, "orta": 3, "düşük": 4}[importance]
        if days_left is not None and days_left > 14:
            priority = min(priority + 1, 5)

        actions = [ACTIONS.get(inp.kind, "İçeriği kontrol et")]
        if deadline:
            actions.append(f"Son tarih: {deadline.strftime('%d.%m.%Y %H:%M')}")
        if inp.change_type == "updated" and inp.diff_summary:
            actions.append("Güncellenen kısmı kontrol et")

        summary_src = text or inp.title
        summary = _summary(summary_src) if summary_src else inp.title
        if inp.change_type == "updated" and inp.diff_summary:
            summary = f"Güncelleme: {inp.diff_summary[:250]}" + (f" — {summary}" if text else "")

        return Analysis(
            course=inp.course or "", topic=inp.title[:150], summary=summary, importance=importance,
            deadline=deadline.isoformat(timespec="minutes") if deadline else None,
            actions=actions, priority=priority, evidence=evidence[:200], source=self.name, truncated=truncated,
        )

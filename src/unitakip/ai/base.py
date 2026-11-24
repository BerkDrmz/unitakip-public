"""AI analiz arayüzü ve ortak yardımcılar."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Protocol

from ..models import KIND_LABELS, Item, Kind

IMPORTANCE_LEVELS = ("düşük", "orta", "yüksek", "kritik")

ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "course": {"type": "string", "description": "Ders adı; içerikte yoksa verilen ders bilgisi"},
        "topic": {"type": "string", "description": "Konu / başlık (kısa)"},
        "summary": {"type": "string", "description": "En fazla 3 cümlelik Türkçe özet, yalnızca içerikteki bilgiler"},
        "importance": {"type": "string", "enum": list(IMPORTANCE_LEVELS)},
        "deadline": {"type": "string", "description": "ISO 8601 tarih/saat veya içerikte yoksa boş dize"},
        "actions": {"type": "array", "items": {"type": "string"}, "description": "Öğrencinin yapması gerekenler"},
        "priority": {"type": "integer", "description": "1 (en acil) - 5 (en az acil)"},
        "evidence": {"type": "string", "description": "Tarih veya önem kararını destekleyen kısa alıntı; yoksa boş"},
    },
    "required": ["course", "topic", "summary", "importance", "deadline", "actions", "priority", "evidence"],
    "additionalProperties": False,
}


@dataclass(slots=True)
class Analysis:
    course: str
    topic: str
    summary: str
    importance: str
    deadline: str | None
    actions: list[str]
    priority: int
    evidence: str = ""
    source: str = "heuristic"
    truncated: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Analysis":
        fields = {k: data.get(k) for k in cls.__dataclass_fields__ if k in data}
        fields.setdefault("evidence", "")
        fields["actions"] = list(fields.get("actions") or [])
        fields["priority"] = int(fields.get("priority") or 3)
        fields["notes"] = list(fields.get("notes") or [])
        return cls(**fields)  # type: ignore[arg-type]


@dataclass(slots=True)
class AnalysisInput:
    platform: str
    kind: Kind
    change_type: str
    title: str
    course: str | None
    due_at: datetime | None
    text: str
    diff_summary: str | None
    file_text: str | None = None

    @property
    def kind_label(self) -> str:
        return KIND_LABELS.get(self.kind, str(self.kind))

    def combined_text(self, max_chars: int) -> tuple[str, bool]:
        parts = [self.text or ""]
        if self.diff_summary:
            parts.append(f"Değişiklik: {self.diff_summary}")
        if self.file_text:
            parts.append(f"Dosya içeriği:\n{self.file_text}")
        text = "\n\n".join(p for p in parts if p).strip()
        if len(text) > max_chars:
            return text[:max_chars], True
        return text, False


class Analyzer(Protocol):
    name: str

    def analyze(self, inp: AnalysisInput) -> Analysis: ...


# --- kişisel veri maskeleme (harici servislere göndermeden önce)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?<!\d)(?:\+?90[\s-]?)?0?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)")
_TCKN = re.compile(r"(?<!\d)[1-9]\d{10}(?!\d)")
_STUDENT_NO = re.compile(r"(?i)(öğrenci\s*(no|numarası)\s*[:#]?\s*)\d{6,12}")


def redact_personal(text: str) -> str:
    text = _EMAIL.sub("[e-posta]", text)
    text = _PHONE.sub("[telefon]", text)
    text = _TCKN.sub("[kimlik-no]", text)
    text = _STUDENT_NO.sub(lambda m: m.group(1) + "[numara]", text)
    return text

"""İndirilen dosyalardan metin çıkarma (AI analizi için). Arşivler AÇILMAZ (zip bomb riski)."""

from __future__ import annotations

import logging
import zipfile
from pathlib import Path

from ..htmltext import html_to_text
from ..models import normalize_text

log = logging.getLogger(__name__)

MAX_PDF_PAGES = 30


def extract_text(path: Path, max_chars: int = 12000) -> str | None:
    ext = path.suffix.lower().lstrip(".")
    try:
        if ext == "pdf":
            from pypdf import PdfReader

            reader = PdfReader(str(path))
            parts = []
            for page in reader.pages[:MAX_PDF_PAGES]:
                parts.append(page.extract_text() or "")
                if sum(map(len, parts)) > max_chars:
                    break
            text = "\n".join(parts)
        elif ext == "docx":
            from docx import Document

            doc = Document(str(path))
            text = "\n".join(p.text for p in doc.paragraphs)
        elif ext == "pptx":
            from pptx import Presentation

            prs = Presentation(str(path))
            lines = []
            for i, slide in enumerate(prs.slides, 1):
                lines.append(f"[Slayt {i}]")
                for shape in slide.shapes:
                    if getattr(shape, "has_text_frame", False) and shape.text_frame.text:
                        lines.append(shape.text_frame.text)
            text = "\n".join(lines)
        elif ext in ("txt", "md", "csv"):
            text = path.read_text(encoding="utf-8", errors="replace")
        elif ext in ("html", "htm"):
            text = html_to_text(path.read_text(encoding="utf-8", errors="replace"))
        elif ext == "zip":
            with zipfile.ZipFile(path) as zf:
                names = zf.namelist()[:100]
            text = "Arşiv içeriği (açılmadı):\n" + "\n".join(names)
        else:
            return None
    except Exception as exc:  # noqa: BLE001 - bozuk/şifreli dosyalar analiz dışı kalır
        log.warning("Metin çıkarılamadı (%s): %s", path.name, type(exc).__name__)
        return None
    text = normalize_text(text)
    return text[:max_chars] if text else None

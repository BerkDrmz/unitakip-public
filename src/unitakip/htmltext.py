"""HTML → düz metin dönüşümü (Moodle açıklamaları, duyurular, web sayfaları)."""

from __future__ import annotations

import warnings

from bs4 import BeautifulSoup, MarkupResemblesLocatorWarning

from .models import normalize_text

warnings.filterwarnings("ignore", category=MarkupResemblesLocatorWarning)

_BLOCK_TAGS = ["p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "section"]


def html_to_text(html: str | None, max_chars: int | None = None) -> str:
    if not html:
        return ""
    if "<" not in html:
        text = normalize_text(html)
    else:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "noscript", "svg", "template"]):
            tag.decompose()
        for br in soup.find_all("br"):
            br.replace_with("\n")
        for tag in soup.find_all(_BLOCK_TAGS):
            tag.insert_after("\n")
        text = normalize_text(soup.get_text())
    if max_chars and len(text) > max_chars:
        text = text[:max_chars].rstrip() + " …"
    return text

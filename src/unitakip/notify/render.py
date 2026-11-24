"""E-posta içeriği: bir çalıştırmadaki değişiklikler tek özet e-postada."""

from __future__ import annotations

import html
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

from ..ai.base import Analysis
from ..models import CHANGE_LABELS, KIND_LABELS, Kind, strip_secrets_from_url
from .base import Attachment, Email

IMPORTANCE_ORDER = {"kritik": 0, "yüksek": 1, "orta": 2, "düşük": 3}
_BADGE = {"kritik": "#b42318", "yüksek": "#c4320a", "orta": "#175cd3", "düşük": "#475467"}


@dataclass(slots=True)
class FileNote:
    filename: str
    status: str  # attached | drive | archived | skipped | error
    detail: str = ""
    link: str | None = None


@dataclass(slots=True)
class ChangeView:
    change_id: int
    platform: str
    platform_name: str
    kind: Kind
    change_type: str
    title: str
    course: str | None
    url: str | None
    detected_at: datetime
    due_at: datetime | None
    summary: str | None
    analysis: Analysis
    files: list[FileNote] = field(default_factory=list)

    @property
    def rank(self) -> tuple[int, int]:
        return IMPORTANCE_ORDER.get(self.analysis.importance, 9), self.analysis.priority


def _fmt(dt: datetime | None, tz: ZoneInfo) -> str:
    return dt.astimezone(tz).strftime("%d.%m.%Y %H:%M") if dt else "—"


def _deadline(view: ChangeView, tz: ZoneInfo) -> str:
    if view.due_at:
        return _fmt(view.due_at, tz)
    if view.analysis.deadline:
        try:
            return _fmt(datetime.fromisoformat(view.analysis.deadline), tz) + " (metinden çıkarıldı)"
        except ValueError:
            return view.analysis.deadline
    return "—"


def render_digest(views: list[ChangeView], platform_name: str, prefix: str, tz: ZoneInfo,
                  attachments: list[Attachment]) -> Email:
    views = sorted(views, key=lambda v: v.rank)
    top = views[0].analysis.importance if views else "orta"
    counts: dict[str, int] = {}
    for v in views:
        label = KIND_LABELS.get(v.kind, str(v.kind)).lower()
        counts[label] = counts.get(label, 0) + 1
    breakdown = ", ".join(f"{n} {k}" for k, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    flag = "[ÖNEMLİ] " if top in ("kritik", "yüksek") else ""
    subject = f"{prefix} {flag}{platform_name}: {len(views)} değişiklik ({breakdown})"
    if len(views) == 1:
        v = views[0]
        subject = (f"{prefix} {flag}{platform_name} · {v.course or ''} · "
                   f"{CHANGE_LABELS.get(v.change_type, v.change_type)} {KIND_LABELS.get(v.kind, '').lower()}: {v.title}")
    subject = " ".join(subject.split())[:200]

    text_parts = [f"{platform_name} platformunda {len(views)} değişiklik tespit edildi.\n"]
    html_parts = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;color:#101828">',
        f"<h2 style='margin:0 0 12px'>{html.escape(platform_name)}: {len(views)} değişiklik</h2>",
    ]
    for v in views:
        a = v.analysis
        url = strip_secrets_from_url(v.url) if v.url else None
        rows = [
            ("Platform", v.platform_name),
            ("Ders", v.course or a.course or "—"),
            ("Başlık", v.title),
            ("Değişiklik türü", f"{CHANGE_LABELS.get(v.change_type, v.change_type)} · {KIND_LABELS.get(v.kind, v.kind)}"),
            ("Tespit tarihi", _fmt(v.detected_at, tz)),
            ("Teslim / son tarih", _deadline(v, tz)),
        ]
        if v.summary:
            rows.append(("Ne değişti", v.summary))
        text_parts.append("─" * 60)
        text_parts += [f"{k}: {val}" for k, val in rows]
        text_parts.append(f"AI değerlendirmesi [{a.source}] — önem: {a.importance}, öncelik: {a.priority}/5")
        text_parts.append(f"  Özet: {a.summary}")
        for act in a.actions:
            text_parts.append(f"  • {act}")
        if a.evidence:
            text_parts.append(f"  Dayanak: “{a.evidence}”")
        if url:
            text_parts.append(f"Orijinal bağlantı: {url}")
        for f in v.files:
            text_parts.append(f"Dosya: {f.filename} — {_file_status(f)}" + (f" {f.link}" if f.link else ""))
        text_parts.append("")

        color = _BADGE.get(a.importance, "#475467")
        html_parts.append(
            f'<div style="border:1px solid #eaecf0;border-left:4px solid {color};border-radius:8px;padding:12px 16px;margin:12px 0">'
            f'<div style="font-size:12px;color:{color};font-weight:600;text-transform:uppercase">{html.escape(a.importance)} · öncelik {a.priority}/5</div>'
            f'<div style="font-size:16px;font-weight:600;margin:4px 0 8px">{html.escape(v.title)}</div>'
            '<table style="border-collapse:collapse;font-size:14px">'
        )
        for k, val in rows:
            html_parts.append(f'<tr><td style="color:#667085;padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap">{html.escape(k)}</td>'
                              f'<td style="padding:2px 0">{html.escape(str(val))}</td></tr>')
        html_parts.append("</table>")
        html_parts.append(f'<div style="margin-top:8px;font-size:14px"><b>AI değerlendirmesi</b> <span style="color:#667085">({html.escape(a.source)})</span><br>{html.escape(a.summary)}</div>')
        if a.actions:
            html_parts.append("<ul style='margin:6px 0 0 18px;padding:0;font-size:14px'>" + "".join(
                f"<li>{html.escape(x)}</li>" for x in a.actions) + "</ul>")
        if a.evidence:
            html_parts.append(f'<div style="font-size:12px;color:#667085;margin-top:4px">Dayanak: “{html.escape(a.evidence)}”</div>')
        if v.files:
            html_parts.append("<div style='margin-top:8px;font-size:13px'>" + "<br>".join(
                f"📎 {html.escape(f.filename)} — {html.escape(_file_status(f))}"
                + (f' <a href="{html.escape(f.link)}">Drive</a>' if f.link else "") for f in v.files) + "</div>")
        if url:
            html_parts.append(f'<div style="margin-top:10px"><a href="{html.escape(url)}" style="color:#175cd3">Platformda aç →</a></div>')
        html_parts.append("</div>")

    html_parts.append('<p style="font-size:12px;color:#98a2b3">UniTakip · otomatik bildirim. AI değerlendirmesi yalnızca içerikteki bilgilere dayanır; kesin bilgi için platformu kontrol et.</p></div>')
    text_parts.append("UniTakip · otomatik bildirim. AI değerlendirmesi yalnızca içerikteki bilgilere dayanır.")
    return Email(subject=subject, text="\n".join(text_parts), html="".join(html_parts), attachments=attachments)


def _file_status(f: FileNote) -> str:
    return {
        "attached": "e-postaya eklendi",
        "drive": "boyut nedeniyle Drive'a yüklendi (yalnızca sen erişebilirsin)",
        "archived": "Gmail ek sınırı nedeniyle eklenmedi; sunucuda arşivlendi",
        "skipped": "indirilmedi",
        "error": "indirilemedi",
    }.get(f.status, f.status) + (f" ({f.detail})" if f.detail else "")


def render_notice(prefix: str, title: str, lines: list[str]) -> Email:
    subject = f"{prefix} {title}"
    text = title + "\n\n" + "\n".join(lines)
    body = "".join(f"<p>{html.escape(ln)}</p>" if not ln.startswith("$ ") else
                   f"<pre style='background:#f2f4f7;padding:8px;border-radius:6px'>{html.escape(ln[2:])}</pre>"
                   for ln in lines)
    page = (f'<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px">'
            f"<h2>{html.escape(title)}</h2>{body}</div>")
    return Email(subject=subject, text=text, html=page)

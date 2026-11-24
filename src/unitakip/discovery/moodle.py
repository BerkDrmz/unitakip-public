"""Sanal Öğrenme oturumlu keşfi (salt-okunur).

Ham yanıtlar → data/discovery/ (git dışı, kişisel veri içerir)
Anonim özet  → docs/kesif/01b-sanal-ogrenme-oturumlu.md (ad, not, mesaj içeriği YOK)
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import timedelta
from pathlib import Path
from typing import Any

from ..adapters.moodle import READ_ONLY_FUNCTIONS, MoodleAdapter, MoodleError
from ..http import TransientError
from ..models import utcnow

log = logging.getLogger(__name__)

INTERESTING_PREFIXES = ("core_ai_", "aiplacement_", "tool_", "block_", "mod_attendance_", "local_", "report_",
                        "mod_", "core_calendar_", "message_", "gradereport_", "core_course_")


def _try(adapter: MoodleAdapter, fn: str, args: dict[str, Any], errors: dict[str, str]) -> Any:
    if not adapter.available(fn):
        errors[fn] = "servis fonksiyon listesinde yok"
        return None
    try:
        return adapter.call(fn, args)
    except (MoodleError, TransientError) as exc:
        errors[fn] = str(exc)[:200]
        return None


def discover_moodle(adapter: MoodleAdapter, discovery_dir: Path, docs_dir: Path) -> Path:
    adapter._load_site_info()
    info = adapter.site_info
    errors: dict[str, str] = {}
    raw: dict[str, Any] = {"site_info": info, "mode": adapter.pcfg.auth_mode}

    functions = sorted(adapter.functions)
    available_ro = sorted(f for f in READ_ONLY_FUNCTIONS if not functions or f in adapter.functions)
    missing_ro = sorted(READ_ONLY_FUNCTIONS - set(available_ro))
    prefix_counts = Counter(next((p for p in INTERESTING_PREFIXES if f.startswith(p)), "diğer") for f in functions)
    ai_funcs = [f for f in functions if f.startswith(("core_ai_", "aiplacement_")) or "_ai_" in f]
    planning_funcs = [f for f in functions if any(k in f for k in ("calendar", "timeline", "completion", "planner"))]

    tl = _try(adapter, "core_course_get_enrolled_courses_by_timeline_classification",
              {"classification": "inprogress", "limit": 0, "offset": 0}, errors)
    allc = _try(adapter, "core_enrol_get_users_courses", {"userid": adapter.userid}, errors)
    raw["courses_inprogress"], raw["courses_all"] = tl, allc
    courses = (tl or {}).get("courses") or allc or []
    ids = [int(c["id"]) for c in courses]

    modnames: Counter[str] = Counter()
    exts: Counter[str] = Counter()
    total_bytes = 0
    sections_total = 0
    hidden_modules = 0
    restricted_modules = 0
    per_course: list[dict[str, Any]] = []
    raw["contents"] = {}
    for idx, cid in enumerate(ids, 1):
        contents = _try(adapter, "core_course_get_contents", {"courseid": cid}, errors)
        raw["contents"][cid] = contents
        if not contents:
            per_course.append({"ders": f"Ders {idx}", "hata": errors.get("core_course_get_contents", "")})
            continue
        c_mods = Counter()
        c_files = 0
        for sec in contents:
            sections_total += 1
            for mod in sec.get("modules", []):
                modnames[mod.get("modname", "?")] += 1
                c_mods[mod.get("modname", "?")] += 1
                if not mod.get("uservisible", True):
                    hidden_modules += 1
                if mod.get("availability"):
                    restricted_modules += 1
                for cont in mod.get("contents") or []:
                    if cont.get("type") == "file":
                        name = (cont.get("filename") or "").lower()
                        exts[name.rsplit(".", 1)[-1] if "." in name else "(uzantısız)"] += 1
                        total_bytes += int(cont.get("filesize") or 0)
                        c_files += 1
        per_course.append({"ders": f"Ders {idx}", "bölüm": len(contents), "etkinlik": sum(c_mods.values()),
                           "dosya": c_files, "türler": dict(c_mods.most_common(6))})

    forums = _try(adapter, "mod_forum_get_forums_by_courses", {"courseids": ids}, errors) if ids else None
    raw["forums"] = forums
    forum_types = Counter(f.get("type") for f in forums or [])
    news = [f for f in forums or [] if f.get("type") == "news"]
    discussions = None
    if news:
        discussions = _try(adapter, "mod_forum_get_forum_discussions",
                           {"forumid": news[0]["id"], "page": 0, "perpage": 5}, errors)
    raw["discussions_sample"] = discussions

    assigns = _try(adapter, "mod_assign_get_assignments", {"courseids": ids}, errors) if ids else None
    raw["assignments"] = assigns
    n_assign = sum(len(c.get("assignments", [])) for c in (assigns or {}).get("courses", []))
    n_assign_due = sum(1 for c in (assigns or {}).get("courses", []) for a in c.get("assignments", []) if a.get("duedate"))

    quizzes = _try(adapter, "mod_quiz_get_quizzes_by_courses", {"courseids": ids}, errors) if ids else None
    raw["quizzes"] = quizzes
    now = utcnow()
    cal = _try(adapter, "core_calendar_get_calendar_events", {
        "events": {"courseids": ids},
        "options": {"userevents": 1, "siteevents": 1, "timestart": int((now - timedelta(days=30)).timestamp()),
                    "timeend": int((now + timedelta(days=120)).timestamp())}}, errors) if ids else None
    raw["calendar"] = cal
    event_types = Counter(e.get("eventtype") for e in (cal or {}).get("events", []))

    grade_counts = []
    raw["grades"] = {}
    for cid in ids:
        g = _try(adapter, "gradereport_user_get_grade_items", {"courseid": cid, "userid": adapter.userid}, errors)
        raw["grades"][cid] = g
        grade_counts.append(sum(len(u.get("gradeitems", [])) for u in (g or {}).get("usergrades", [])))
    notif = _try(adapter, "message_popup_get_popup_notifications",
                 {"useridto": adapter.userid, "newestfirst": 1, "limit": 20, "offset": 0}, errors)
    raw["notifications"] = notif
    notif_types = Counter(f"{n.get('component')}/{n.get('eventtype')}" for n in (notif or {}).get("notifications", []))

    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    discovery_dir.mkdir(parents=True, exist_ok=True)
    raw_path = discovery_dir / f"{adapter.name}-{stamp}.json"
    raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    lines = [
        "# Faz 1b — Sanal Öğrenme oturumlu keşif özeti (otomatik)",
        "",
        f"Oluşturma: {stamp} · mod: `{adapter.pcfg.auth_mode}` · Moodle sürümü: `{info.get('release', '?')}`",
        f"Ham veri (kişisel, git dışı): `{raw_path}`",
        "",
        "## Web servis fonksiyonları",
        f"- Token'ın erişebildiği fonksiyon sayısı: **{len(functions) or 'bilinmiyor (oturum modu)'}**",
        f"- Adaptörün kullandığı salt-okunur fonksiyonlardan erişilebilenler ({len(available_ro)}): "
        + ", ".join(f"`{f}`" for f in available_ro),
        f"- Erişilemeyenler: {', '.join(f'`{f}`' for f in missing_ro) or 'yok'}",
        f"- Önek dağılımı: {dict(prefix_counts.most_common())}",
        f"- Yapay zekâ ile ilgili fonksiyonlar: {', '.join(f'`{f}`' for f in ai_funcs) or 'yok'}",
        f"- Planlama/takvim/tamamlama fonksiyonları: {len(planning_funcs)}",
        "",
        "## Dersler ve içerik yapısı",
        f"- Devam eden ders sayısı (timeline `inprogress`): **{len((tl or {}).get('courses') or [])}**,"
        f" tüm kayıtlı dersler: **{len(allc or [])}**",
        f"- Toplam bölüm (hafta/konu): {sections_total}, gizli/erişilemeyen etkinlik: {hidden_modules},"
        f" erişim koşullu etkinlik: {restricted_modules}",
        f"- Etkinlik türleri: {dict(modnames.most_common())}",
        f"- Dosya uzantıları: {dict(exts.most_common())}",
        f"- Toplam dosya boyutu: {total_bytes / 1048576:.1f} MB",
        "",
        "| Ders | Bölüm | Etkinlik | Dosya | Başlıca türler |",
        "|---|---|---|---|---|",
    ]
    for pc in per_course:
        lines.append(f"| {pc['ders']} | {pc.get('bölüm', '—')} | {pc.get('etkinlik', '—')} | {pc.get('dosya', '—')} "
                     f"| {pc.get('türler', pc.get('hata', ''))} |")
    lines += [
        "",
        "## Duyurular, ödevler, sınavlar, takvim, notlar",
        f"- Forum türleri: {dict(forum_types)} (duyuru forumu: {len(news)})",
        f"- Örnek duyuru tartışması alınabildi mi: {'evet' if discussions else 'hayır'}",
        f"- Ödev: {n_assign} (teslim tarihli: {n_assign_due})",
        f"- Quiz: {len((quizzes or {}).get('quizzes', []))}",
        f"- Takvim etkinlik türleri (−30/+120 gün): {dict(event_types)}",
        f"- Not kalemleri (ders başına): {grade_counts}",
        f"- Moodle bildirim türleri (son 20): {dict(notif_types)}",
        "",
        "## Hatalar / erişim kısıtları",
    ]
    lines += [f"- `{k}`: {v}" for k, v in errors.items()] or ["- yok"]
    lines += ["", "> Bu dosya otomatik üretildi; ders adları, kişi adları, notlar ve mesaj içerikleri bilinçli olarak dahil edilmedi."]
    docs_dir.mkdir(parents=True, exist_ok=True)
    out = docs_dir / "01b-sanal-ogrenme-oturumlu.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out

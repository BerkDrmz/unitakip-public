"""Sanal Öğrenme (Moodle 5.3) adaptörü.

Keşif (docs/kesif/01-sanal-ogrenme.md): mobil web servisi açık, typeoflogin=1 → resmi yol
`login/token.php` ile alınan token + `webservice/rest/server.php`. Yedek: tarayıcı oturumu +
`lib/ajax/service.php?sesskey=...`.

GÜVENLİK: Yalnızca READ_ONLY_FUNCTIONS içindeki fonksiyonlar çağrılabilir. Ödev teslimi, sınav
denemesi, kayıt değişikliği vb. yapan hiçbir fonksiyon bu kümede yoktur ve çağrılamaz.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import timedelta
from pathlib import Path
from typing import Any

from ..config import AppConfig, PlatformConfig
from ..htmltext import html_to_text
from ..http import DownloadResult, HttpClient, TransientError
from ..logging_setup import register_secret
from ..models import Item, Kind, RemoteFile, Snapshot, from_epoch, utcnow
from ..session.store import SessionStore, cookies_from_storage_state, merge_cookies_into_state
from .base import Adapter, AdapterError, AuthExpired, AuthMissing, LoginFailed, NotAFile

log = logging.getLogger(__name__)

READ_ONLY_FUNCTIONS = frozenset({
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_course_get_enrolled_courses_by_timeline_classification",
    "core_course_get_contents",
    "mod_forum_get_forums_by_courses",
    "mod_forum_get_forum_discussions",
    "mod_assign_get_assignments",
    "mod_quiz_get_quizzes_by_courses",
    "core_calendar_get_calendar_events",
    "core_calendar_get_action_events_by_timesort",
    "gradereport_user_get_grade_items",
    "message_popup_get_popup_notifications",
})

AUTH_ERRORCODES = {"invalidtoken", "servicerequireslogin", "invalidsesskey"}
# Site bakımda / geçici sunucu sorunu: sonra yeniden denenir
TRANSIENT_ERRORCODES = {"sitemaintenance", "upgraderunning", "dbconnectionfailed", "badjson"}


def _json_or_transient(function: str, resp) -> Any:  # type: ignore[no-untyped-def]
    """Moodle bakım modundayken JSON yerine HTML döner: bunu kalıcı hata değil, geçici hata say."""
    try:
        return resp.json()
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise TransientError(f"{function}: JSON olmayan yanıt (bakım/geçici sorun olabilir)") from exc


class MoodleError(AdapterError):
    def __init__(self, function: str, errorcode: str, message: str):
        super().__init__(f"{function}: {errorcode}: {message}")
        self.function = function
        self.errorcode = errorcode
        self.message = message


class FunctionNotAllowed(AdapterError):
    pass


def flatten_params(value: Any, prefix: str = "", out: dict[str, str] | None = None) -> dict[str, str]:
    """{'courseids': [3, 5]} → {'courseids[0]': '3', 'courseids[1]': '5'} (Moodle REST biçimi)."""
    out = {} if out is None else out
    if isinstance(value, dict):
        for k, v in value.items():
            flatten_params(v, f"{prefix}[{k}]" if prefix else str(k), out)
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            flatten_params(v, f"{prefix}[{i}]", out)
    elif isinstance(value, bool):
        out[prefix] = "1" if value else "0"
    elif value is not None:
        out[prefix] = str(value)
    return out


def _guard(function: str) -> None:
    if function not in READ_ONLY_FUNCTIONS:
        raise FunctionNotAllowed(f"{function} salt-okunur izin listesinde değil; çağrı engellendi.")


# --------------------------------------------------------------------------- taşıyıcılar
class TokenTransport:
    """Resmi REST uç noktası (mobil uygulama token'ı)."""

    mode = "token"

    def __init__(self, http: HttpClient, root: str, token: str):
        self.http = http
        self.root = root
        self.token = token
        register_secret(token)

    def call(self, function: str, args: dict[str, Any] | None = None) -> Any:
        _guard(function)
        data = flatten_params(args or {})
        data.update({"wstoken": self.token, "wsfunction": function, "moodlewsrestformat": "json",
                     "moodlewssettingfilter": "true", "moodlewssettingfileurl": "true"})
        resp = self.http.post(f"{self.root}/webservice/rest/server.php", data=data)
        if resp.status_code >= 400:
            raise TransientError(f"{function}: HTTP {resp.status_code}")
        payload = _json_or_transient(function, resp)
        if isinstance(payload, dict) and "exception" in payload:
            code = payload.get("errorcode", "?")
            if code in TRANSIENT_ERRORCODES:
                raise TransientError(f"{function}: {code}")
            raise MoodleError(function, code, payload.get("message", ""))
        return payload

    def file_url(self, url: str) -> str:
        url = url.replace("/pluginfile.php", "/webservice/pluginfile.php") if "/webservice/" not in url else url
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}token={self.token}"


class AjaxTransport:
    """Tarayıcı oturumu (MoodleSession çerezi) + sesskey ile AJAX servis uç noktası."""

    mode = "session"

    def __init__(self, http: HttpClient, root: str):
        self.http = http
        self.root = root
        self.sesskey: str | None = None
        self.userid: int | None = None

    def refresh_sesskey(self) -> None:
        resp = self.http.get(f"{self.root}/my/")
        if "/login/index.php" in str(resp.url):
            raise AuthExpired("Moodle oturumu sona ermiş (giriş sayfasına yönlendirildi).")
        m = re.search(r'"sesskey":"([^"]+)"', resp.text)
        u = re.search(r'"userId":(\d+)', resp.text)
        if not m:
            raise AuthExpired("sesskey bulunamadı; oturum geçersiz olabilir.")
        self.sesskey = m.group(1)
        register_secret(self.sesskey)
        self.userid = int(u.group(1)) if u else None

    def call(self, function: str, args: dict[str, Any] | None = None) -> Any:
        _guard(function)
        if not self.sesskey:
            self.refresh_sesskey()
        for attempt in range(2):
            resp = self.http.post(
                f"{self.root}/lib/ajax/service.php",
                params={"sesskey": self.sesskey, "info": function},
                json=[{"index": 0, "methodname": function, "args": args or {}}],
            )
            if resp.status_code >= 400:
                raise TransientError(f"{function}: HTTP {resp.status_code}")
            payload = _json_or_transient(function, resp)
            entry = payload[0] if isinstance(payload, list) and payload else payload
            if isinstance(entry, dict) and entry.get("error"):
                exc = entry.get("exception") or {}
                code = exc.get("errorcode", "?")
                if code in TRANSIENT_ERRORCODES:
                    raise TransientError(f"{function}: {code}")
                if code in AUTH_ERRORCODES and attempt == 0:
                    self.refresh_sesskey()
                    continue
                raise MoodleError(function, code, exc.get("message", ""))
            return entry.get("data") if isinstance(entry, dict) else entry
        raise AuthExpired("Moodle AJAX oturumu yenilenemedi.")

    def file_url(self, url: str) -> str:
        return url.replace("/webservice/pluginfile.php", "/pluginfile.php")


# --------------------------------------------------------------------------- giriş
def obtain_token(http: HttpClient, root: str, username: str, password: str, service: str) -> dict[str, str]:
    """login/token.php → {token, privatetoken}. Parola yalnızca bu POST'ta kullanılır, saklanmaz."""
    register_secret(password)
    resp = http.post(f"{root}/login/token.php", data={"username": username, "password": password, "service": service})
    try:
        payload = resp.json()
    except json.JSONDecodeError as exc:
        raise LoginFailed(f"token.php beklenmeyen yanıt (HTTP {resp.status_code})") from exc
    if "token" not in payload:
        raise LoginFailed(f"{payload.get('errorcode', 'hata')}: {payload.get('error', '')}")
    register_secret(payload["token"])
    if payload.get("privatetoken"):
        register_secret(payload["privatetoken"])
    return {"token": payload["token"], "privatetoken": payload.get("privatetoken") or ""}


# --------------------------------------------------------------------------- adaptör
_MOD_KIND = {"url": Kind.LINK, "forum": Kind.MODULE, "assign": Kind.ASSIGNMENT, "quiz": Kind.QUIZ}


class MoodleAdapter(Adapter):
    def __init__(self, name: str, pcfg: PlatformConfig, app: AppConfig, store: SessionStore,
                 http: HttpClient | None = None):
        super().__init__(name, pcfg, app, store)
        self.root = pcfg.root
        self._http = http
        self._transport: TokenTransport | AjaxTransport | None = None
        self._session_state: dict[str, Any] | None = None
        self.functions: set[str] = set()
        self.site_info: dict[str, Any] = {}
        self.userid: int = 0

    @property
    def token_key(self) -> str:
        return f"{self.name}.token"

    # ------------------------------------------------------------ bağlantı
    def _client(self, cookies=None, user_agent: str | None = None) -> HttpClient:
        if self._http is None:
            self._http = HttpClient(self.app.http, cookies=cookies, user_agent=user_agent)
        elif cookies is not None:
            self._http.cookies.update(cookies)
        return self._http

    def transport(self) -> TokenTransport | AjaxTransport:
        if self._transport is not None:
            return self._transport
        if self.pcfg.auth_mode == "token":
            secret = self.store.load(self.token_key)
            if not secret or not secret.get("token"):
                raise AuthMissing(f"{self.pcfg.display_name}: token yok. `unitakip login {self.name}` çalıştır.")
            self._transport = TokenTransport(self._client(), self.root, secret["token"])
        else:
            state = self.store.load(self.session_key)
            if not state:
                raise AuthMissing(f"{self.pcfg.display_name}: oturum yok. `unitakip login {self.name} --mode session`.")
            self._session_state = state
            jar = cookies_from_storage_state(state["storage_state"])
            self._transport = AjaxTransport(self._client(jar, state.get("user_agent")), self.root)
        return self._transport

    def _renew_token(self) -> bool:
        """Kullanıcı açıkça izin verdiyse (--remember-credentials) token'ı yenile."""
        if not self.pcfg.auto_relogin:
            return False
        creds = self.store.load(self.credentials_key)
        if not creds:
            return False
        log.info("%s: token geçersiz, kayıtlı kimlik bilgileriyle yenileniyor.", self.name)
        try:
            tok = obtain_token(self._client(), self.root, creds["username"], creds["password"], self.pcfg.ws_service)
        except LoginFailed as exc:
            log.error("%s: otomatik token yenileme reddedildi: %s", self.name, exc)
            return False
        self.store.save(self.token_key, {**tok, "username": creds["username"], "base_url": self.root,
                                         "renewed": True})
        self._transport = None
        return True

    def call(self, function: str, args: dict[str, Any] | None = None) -> Any:
        try:
            return self.transport().call(function, args)
        except MoodleError as exc:
            if exc.errorcode in AUTH_ERRORCODES:
                raise AuthExpired(f"{self.pcfg.display_name}: {exc.errorcode}") from exc
            raise

    def available(self, function: str) -> bool:
        # Token modunda site_info'nun fonksiyon listesi kesin bilgi verir. Oturum modunda deneyerek öğrenilir.
        return function in READ_ONLY_FUNCTIONS and (not self.functions or function in self.functions)

    def _site_info_call(self) -> dict[str, Any]:
        try:
            return self.call("core_webservice_get_site_info")
        except MoodleError as exc:
            # Süresi dolmuş token (validuntil) Moodle'da 'accessexception' döner
            if exc.errorcode == "accessexception":
                raise AuthExpired(f"{self.pcfg.display_name}: token reddedildi ({exc.message})") from exc
            raise

    def _load_site_info(self) -> None:
        transport = self.transport()
        if isinstance(transport, TokenTransport):
            try:
                info = self._site_info_call()
            except AuthExpired:
                if not self._renew_token():
                    raise
                info = self._site_info_call()
            self.site_info = info
            self.functions = {f["name"] for f in info.get("functions", [])}
            self.userid = int(info["userid"])
        else:
            transport.refresh_sesskey()
            self.userid = transport.userid or 0
            self.site_info = {"userid": self.userid, "mode": "session"}

    # --------------------------------------------------------------- çekme
    def fetch(self) -> Snapshot:
        snap = Snapshot(platform=self.name)
        self._load_site_info()
        snap.meta["release"] = self.site_info.get("release")
        snap.meta["functions_available"] = len(self.functions)

        courses = self._courses(snap)
        if not courses:
            return snap
        ids = [c["id"] for c in courses]
        names = {c["id"]: c.get("fullname") or c.get("shortname") or str(c["id"]) for c in courses}
        f = self.pcfg.features

        handled_mods: set[str] = set()
        if f.assignments and self.available("mod_assign_get_assignments"):
            handled_mods.add("assign")
        if f.quizzes and self.available("mod_quiz_get_quizzes_by_courses"):
            handled_mods.add("quiz")

        if f.contents and self.available("core_course_get_contents"):
            for cid in ids:
                self._isolated(snap, f"course:{cid}:contents", self._course_contents, snap, cid, names[cid], handled_mods)
        if f.announcements or f.forums:
            self._isolated(snap, "forums", self._forums, snap, ids, names)
        if "assign" in handled_mods:
            self._isolated(snap, "assignments", self._assignments, snap, ids, names)
        if "quiz" in handled_mods:
            self._isolated(snap, "quizzes", self._quizzes, snap, ids, names)
        if f.calendar and self.available("core_calendar_get_calendar_events"):
            self._isolated(snap, "calendar", self._calendar, snap, ids, names, handled_mods)
        if f.grades and self.available("gradereport_user_get_grade_items"):
            for cid in ids:
                self._isolated(snap, f"course:{cid}:grades", self._grades, snap, cid, names[cid])
        if f.notifications and self.available("message_popup_get_popup_notifications"):
            self._isolated(snap, "notifications", self._notifications, snap)
        self._persist_session()
        return snap

    def _isolated(self, snap: Snapshot, scope: str, func, *args: Any) -> None:  # type: ignore[no-untyped-def]
        """Bir bölümdeki beklenmeyen yanıt yapısı (Moodle güncellemesi vb.) yalnızca o bölümü etkiler.
        O bölümün yarım eklenmiş öğeleri geri alınır ki eksik veri 'kaldırıldı' sanılmasın."""
        mark = len(snap.items)
        before = snap.complete_scopes | snap.partial_scopes
        try:
            func(*args)
        except AuthExpired:
            raise
        except Exception as exc:  # noqa: BLE001
            del snap.items[mark:]
            log.exception("%s: %s bölümü işlenemedi (beklenmeyen yanıt yapısı)", self.name, scope)
            reason = f"{type(exc).__name__}: {exc}"
            # Bu çağrı sırasında "başarılı" işaretlenen tüm kapsamlar geri alınır (ör. course:X:assign)
            for added in (snap.complete_scopes | snap.partial_scopes) - before:
                snap.fail(added, reason)
            snap.fail(scope, reason)

    def _scope_call(self, snap: Snapshot, scope: str, function: str, args: dict[str, Any],
                    *, removable: bool = True) -> Any | None:
        try:
            result = self.call(function, args)
        except (MoodleError, TransientError) as exc:
            log.warning("%s: %s kapsamı alınamadı: %s", self.name, scope, exc)
            snap.fail(scope, str(exc))
            return None
        snap.ok(scope, removable=removable)
        return result

    def _courses(self, snap: Snapshot) -> list[dict[str, Any]]:
        courses: list[dict[str, Any]] | None = None
        fn_tl = "core_course_get_enrolled_courses_by_timeline_classification"
        if self.pcfg.course_classification == "inprogress" and self.available(fn_tl):
            res = self._scope_call(snap, "courses", fn_tl, {"classification": "inprogress", "limit": 0, "offset": 0})
            courses = res.get("courses", []) if res else None
        if courses is None and self.available("core_enrol_get_users_courses") and self.userid:
            res = self._scope_call(snap, "courses", "core_enrol_get_users_courses", {"userid": self.userid})
            if res is not None:
                courses = list(res)
                if self.pcfg.course_classification == "inprogress":
                    now = int(utcnow().timestamp())
                    courses = [c for c in courses if not c.get("enddate") or int(c["enddate"]) > now]
        if courses is None:
            raise AdapterError(f"{self.pcfg.display_name}: ders listesi alınamadı.")

        inc, exc = set(self.pcfg.include_course_ids), set(self.pcfg.exclude_course_ids)
        result = []
        for c in courses:
            if not isinstance(c, dict) or "id" not in c:
                log.warning("%s: beklenmeyen ders kaydı atlandı: %r", self.name, str(c)[:100])
                continue
            cid = int(c["id"])
            if (inc and cid not in inc) or cid in exc:
                continue
            c["id"] = cid
            result.append(c)
            snap.add(Item(
                platform=self.name, external_id=f"moodle:course:{cid}", kind=Kind.COURSE,
                title=c.get("fullname") or c.get("shortname") or str(cid), scope="courses",
                course_id=str(cid), course_name=c.get("fullname"),
                url=f"{self.root}/course/view.php?id={cid}",
                data={"shortname": c.get("shortname"), "visible": c.get("visible", 1)},
            ))
        return result

    # ------------------------------------------------------------ içerikler
    def _course_contents(self, snap: Snapshot, cid: int, cname: str, handled_mods: set[str]) -> None:
        scope = f"course:{cid}:contents"
        sections = self._scope_call(snap, scope, "core_course_get_contents", {"courseid": cid})
        if sections is None:
            return
        for sec in sections:
            sec_name = sec.get("name") or f"Bölüm {sec.get('section', '')}".strip()
            summary = html_to_text(sec.get("summary"))
            snap.add(Item(
                platform=self.name, external_id=f"moodle:section:{sec['id']}", kind=Kind.SECTION,
                title=sec_name, scope=scope, course_id=str(cid), course_name=cname,
                url=f"{self.root}/course/view.php?id={cid}#section-{sec.get('section', '')}",
                data={"name": sec_name, "summary": summary, "visible": sec.get("visible"),
                      "uservisible": sec.get("uservisible")},
                text=summary or None,
            ))
            for mod in sec.get("modules", []):
                self._module(snap, scope, cid, cname, sec_name, mod, handled_mods)

    def _module(self, snap: Snapshot, scope: str, cid: int, cname: str, sec_name: str,
                mod: dict[str, Any], handled_mods: set[str]) -> None:
        modname = mod.get("modname", "")
        cmid = mod["id"]
        description = html_to_text(mod.get("description"))
        contents = mod.get("contents") or []
        if modname not in handled_mods:
            data: dict[str, Any] = {
                "name": mod.get("name"), "modname": modname, "section": sec_name,
                "visible": mod.get("visible"), "uservisible": mod.get("uservisible"),
                "availability": html_to_text(mod.get("availabilityinfo") or mod.get("availability") or ""),
                "description": description,
                "dates": [[d.get("label"), d.get("timestamp")] for d in mod.get("dates") or []],
            }
            if modname == "url" and contents:
                data["target"] = contents[0].get("fileurl")
            if modname == "page":
                data["contentmodified"] = max((int(c.get("timemodified") or 0) for c in contents), default=0)
            due = None
            for d in mod.get("dates") or []:
                if d.get("dataid") in ("duedate", "timeclose", "cutoffdate") or "due" in str(d.get("dataid", "")):
                    due = from_epoch(d.get("timestamp"))
            snap.add(Item(
                platform=self.name, external_id=f"moodle:cm:{cmid}", kind=_MOD_KIND.get(modname, Kind.MODULE),
                title=mod.get("name") or modname, scope=scope, course_id=str(cid), course_name=cname,
                url=mod.get("url") or f"{self.root}/course/view.php?id={cid}", due_at=due, data=data,
                text=description or None,
            ))

        if not self.pcfg.features.files or modname in ("page", "book"):
            return
        for c in contents:
            if c.get("type") != "file" or not c.get("fileurl"):
                continue
            path = f"{c.get('filepath') or '/'}{c.get('filename')}"
            fileurl = c["fileurl"]
            snap.add(Item(
                platform=self.name, external_id=f"moodle:file:{cmid}:{path}", kind=Kind.FILE,
                title=c.get("filename") or path, scope=scope, course_id=str(cid), course_name=cname,
                url=fileurl.replace("/webservice/pluginfile.php", "/pluginfile.php"),
                version=f"{c.get('timemodified')}:{c.get('filesize')}",
                data={"filename": c.get("filename"), "filepath": c.get("filepath"), "filesize": c.get("filesize"),
                      "timemodified": c.get("timemodified"), "mimetype": c.get("mimetype"),
                      "module": mod.get("name"), "section": sec_name},
                files=[] if c.get("isexternalfile") else [RemoteFile(
                    url=fileurl, filename=c.get("filename") or "dosya", size=c.get("filesize"),
                    timemodified=c.get("timemodified"), mimetype=c.get("mimetype"))],
            ))

    # ------------------------------------------------------------ duyurular
    def _forums(self, snap: Snapshot, ids: list[int], names: dict[int, str]) -> None:
        if not self.available("mod_forum_get_forums_by_courses"):
            return
        forums = self._scope_call(snap, "forums", "mod_forum_get_forums_by_courses", {"courseids": ids})
        if forums is None or not self.available("mod_forum_get_forum_discussions"):
            return
        for forum in forums:
            is_news = forum.get("type") == "news"
            if (is_news and not self.pcfg.features.announcements) or (not is_news and not self.pcfg.features.forums):
                continue
            cid = int(forum.get("course"))
            scope = f"forum:{forum['id']}"
            res = self._scope_call(
                snap, scope, "mod_forum_get_forum_discussions",
                {"forumid": forum["id"], "page": 0, "perpage": self.pcfg.discussions_per_forum},
                removable=False,
            )
            if res is None:
                continue
            for d in res.get("discussions", []):
                message = html_to_text(d.get("message"))
                attachments = d.get("attachments") or []
                did = d.get("discussion") or d.get("id")
                snap.add(Item(
                    platform=self.name, external_id=f"moodle:discussion:{did}",
                    kind=Kind.ANNOUNCEMENT if is_news else Kind.FORUM_POST,
                    title=d.get("subject") or d.get("name") or "(konusuz)", scope=scope,
                    course_id=str(cid), course_name=names.get(cid),
                    url=f"{self.root}/mod/forum/discuss.php?d={did}",
                    data={"subject": d.get("subject"), "message": message, "author": d.get("userfullname"),
                          "forum": forum.get("name"),
                          "attachments": [[a.get("filename"), a.get("filesize"), a.get("timemodified")]
                                          for a in attachments]},
                    text=message,
                    files=[RemoteFile(url=a["fileurl"], filename=a.get("filename") or "ek", size=a.get("filesize"),
                                      timemodified=a.get("timemodified"), mimetype=a.get("mimetype"))
                           for a in attachments if a.get("fileurl")],
                ))

    # --------------------------------------------------------- ödev / sınav
    def _assignments(self, snap: Snapshot, ids: list[int], names: dict[int, str]) -> None:
        res = self._scope_call(snap, "assignments", "mod_assign_get_assignments", {"courseids": ids})
        if res is None:
            return
        for course in res.get("courses", []):
            cid = int(course["id"])
            snap.ok(f"course:{cid}:assign")
            for a in course.get("assignments", []):
                intro = html_to_text(a.get("intro"))
                attachments = a.get("introattachments") or []
                snap.add(Item(
                    platform=self.name, external_id=f"moodle:assign:{a['id']}", kind=Kind.ASSIGNMENT,
                    title=a.get("name") or "Ödev", scope=f"course:{cid}:assign", course_id=str(cid),
                    course_name=names.get(cid) or course.get("fullname"),
                    url=f"{self.root}/mod/assign/view.php?id={a.get('cmid')}",
                    due_at=from_epoch(a.get("duedate")),
                    data={"name": a.get("name"), "duedate": a.get("duedate"), "cutoffdate": a.get("cutoffdate"),
                          "allowsubmissionsfromdate": a.get("allowsubmissionsfromdate"), "intro": intro,
                          "timelimit": a.get("timelimit"),
                          "attachments": [[f.get("filename"), f.get("filesize"), f.get("timemodified")]
                                          for f in attachments]},
                    text=intro or None,
                    files=[RemoteFile(url=f["fileurl"], filename=f.get("filename") or "ek", size=f.get("filesize"),
                                      timemodified=f.get("timemodified"), mimetype=f.get("mimetype"))
                           for f in attachments if f.get("fileurl")],
                ))

    def _quizzes(self, snap: Snapshot, ids: list[int], names: dict[int, str]) -> None:
        res = self._scope_call(snap, "quizzes", "mod_quiz_get_quizzes_by_courses", {"courseids": ids})
        if res is None:
            return
        for cid in ids:
            snap.ok(f"course:{cid}:quiz")
        for q in res.get("quizzes", []):
            cid = int(q["course"])
            intro = html_to_text(q.get("intro"))
            snap.add(Item(
                platform=self.name, external_id=f"moodle:quiz:{q['id']}", kind=Kind.QUIZ,
                title=q.get("name") or "Sınav", scope=f"course:{cid}:quiz", course_id=str(cid),
                course_name=names.get(cid), url=f"{self.root}/mod/quiz/view.php?id={q.get('coursemodule')}",
                due_at=from_epoch(q.get("timeclose")) or from_epoch(q.get("timeopen")),
                data={"name": q.get("name"), "intro": intro, "timeopen": q.get("timeopen"),
                      "timeclose": q.get("timeclose"), "timelimit": q.get("timelimit"), "attempts": q.get("attempts")},
                text=intro or None,
            ))

    # --------------------------------------------------------------- takvim
    def _calendar(self, snap: Snapshot, ids: list[int], names: dict[int, str], handled_mods: set[str]) -> None:
        now = utcnow()
        args = {
            "events": {"courseids": ids},
            "options": {"userevents": 1, "siteevents": 1, "ignorehidden": 1,
                        "timestart": int((now - timedelta(days=1)).timestamp()),
                        "timeend": int((now + timedelta(days=self.pcfg.calendar_days_ahead)).timestamp())},
        }
        res = self._scope_call(snap, "calendar", "core_calendar_get_calendar_events", args, removable=False)
        if res is None:
            return
        for ev in res.get("events", []):
            if ev.get("modulename") in handled_mods:
                continue  # ödev ve sınav tarihleri zaten kendi kayıtlarında
            cid = int(ev.get("courseid") or 0)
            desc = html_to_text(ev.get("description"))
            snap.add(Item(
                platform=self.name, external_id=f"moodle:event:{ev['id']}", kind=Kind.EVENT,
                title=ev.get("name") or "Etkinlik", scope="calendar", course_id=str(cid) if cid else None,
                course_name=names.get(cid), url=f"{self.root}/calendar/view.php?view=day&time={ev.get('timestart')}",
                due_at=from_epoch(ev.get("timestart")),
                data={"name": ev.get("name"), "description": desc, "timestart": ev.get("timestart"),
                      "timeduration": ev.get("timeduration"), "eventtype": ev.get("eventtype"),
                      "modulename": ev.get("modulename")},
                text=desc or None,
            ))

    # ---------------------------------------------------------------- notlar
    def _grades(self, snap: Snapshot, cid: int, cname: str) -> None:
        scope = f"course:{cid}:grades"
        res = self._scope_call(snap, scope, "gradereport_user_get_grade_items", {"courseid": cid, "userid": self.userid})
        if res is None:
            return
        for ug in res.get("usergrades", []):
            for gi in ug.get("gradeitems", []):
                if gi.get("itemtype") == "category":
                    continue
                title = gi.get("itemname") or ("Ders toplamı" if gi.get("itemtype") == "course" else "Not kalemi")
                snap.add(Item(
                    platform=self.name, external_id=f"moodle:grade:{cid}:{gi['id']}", kind=Kind.GRADE,
                    title=title, scope=scope, course_id=str(cid), course_name=cname,
                    url=f"{self.root}/grade/report/user/index.php?id={cid}",
                    data={"itemname": title, "gradeformatted": gi.get("gradeformatted"),
                          "percentageformatted": gi.get("percentageformatted"),
                          "lettergradeformatted": gi.get("lettergradeformatted"),
                          "rangeformatted": gi.get("rangeformatted"),
                          "feedback": html_to_text(gi.get("feedback"))},
                ))

    def _notifications(self, snap: Snapshot) -> None:
        res = self._scope_call(snap, "notifications", "message_popup_get_popup_notifications",
                               {"useridto": self.userid, "newestfirst": 1, "limit": 20, "offset": 0}, removable=False)
        if res is None:
            return
        for n in res.get("notifications", []):
            text = n.get("smallmessage") or html_to_text(n.get("fullmessagehtml"))
            snap.add(Item(
                platform=self.name, external_id=f"moodle:notification:{n['id']}", kind=Kind.NOTIFICATION,
                title=n.get("subject") or "Bildirim", scope="notifications", url=n.get("contexturl"),
                data={"subject": n.get("subject"), "text": text, "component": n.get("component"),
                      "eventtype": n.get("eventtype"), "timecreated": n.get("timecreated")},
                text=text,
            ))

    # ------------------------------------------------------------- dosyalar
    def download(self, rf: RemoteFile, dest: Path, max_bytes: int) -> DownloadResult:
        transport = self.transport()
        result = self._client().download(transport.file_url(rf.url), dest, max_bytes)
        ctype = result.content_type.lower()
        if ("text/html" in ctype or "application/json" in ctype) and not rf.filename.lower().endswith((".html", ".htm", ".json")):
            head = dest.read_bytes()[:400].decode("utf-8", "replace")
            dest.unlink(missing_ok=True)
            if "invalidtoken" in head or "login" in head.lower():
                raise AuthExpired(f"{self.pcfg.display_name}: dosya indirilirken oturum/token reddedildi.")
            raise NotAFile(f"Dosya yerine {ctype} döndü: {rf.filename}")
        return result

    def keepalive(self) -> bool:
        try:
            self._load_site_info()
            self._persist_session()
            return True
        except AuthExpired:
            return False

    def _persist_session(self) -> None:
        if self._session_state is not None and self._http is not None:
            state = dict(self._session_state)
            state["storage_state"] = merge_cookies_into_state(state["storage_state"], self._http.cookies)
            saved = self.store.save_if_unchanged(self.session_key, state, self._session_state.get("saved_at"))
            if saved is None:
                log.info("%s: oturum bu sırada yeniden kaydedilmiş; eski çerezler yazılmadı.", self.name)
            else:
                self._session_state = saved

    def close(self) -> None:
        if self._http is not None:
            self._http.close()
            self._http = None

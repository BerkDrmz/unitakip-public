"""Gmail API (OAuth 2.0) bildirici + isteğe bağlı Google Drive yükleyici.

Kapsamlar (en az yetki):
  - https://www.googleapis.com/auth/gmail.send  → yalnızca e-posta GÖNDERME (okuma yok)
  - https://www.googleapis.com/auth/drive.file  → yalnızca bu uygulamanın oluşturduğu dosyalar (isteğe bağlı)
"""

from __future__ import annotations

import base64
import io
import json
import logging
from pathlib import Path
from typing import Any

from ..logging_setup import register_secret
from ..session.store import SessionStore
from .base import Email, NotifierError

log = logging.getLogger(__name__)

GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send"
DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"
SECRET_NAME = "gmail.oauth"
_MEDIA_UPLOAD_THRESHOLD = 4 * 1024 * 1024


def run_oauth_flow(client_secret_path: Path, store: SessionStore, *, drive: bool = False) -> dict[str, Any]:
    """Mac'te bir kez çalıştırılır: tarayıcıda Google onay ekranı açılır, kullanıcı onaylar."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    scopes = [GMAIL_SEND] + ([DRIVE_FILE] if drive else [])
    client_config = json.loads(client_secret_path.read_text(encoding="utf-8"))
    flow = InstalledAppFlow.from_client_config(client_config, scopes)
    creds = flow.run_local_server(port=0, open_browser=True, prompt="consent", access_type="offline",
                                  authorization_prompt_message="Tarayıcıda Google hesabınla onay ver: {url}",
                                  success_message="UniTakip yetkilendirildi. Bu pencereyi kapatabilirsin.")
    if not creds.refresh_token:
        raise RuntimeError("Google yenileme token'ı vermedi. Uygulama erişimini kaldırıp tekrar dene.")
    record = {"authorized_user": json.loads(creds.to_json()), "scopes": scopes}
    store.save(SECRET_NAME, record)
    return record


class GmailNotifier:
    name = "gmail_api"

    def __init__(self, store: SessionStore, to: str):
        if not to:
            raise NotifierError("Alıcı adresi yok: config notify.to veya UNITAKIP_NOTIFY_TO ayarla.")
        self.store = store
        self.to = to
        self._creds = None
        self._service = None

    def _credentials(self):  # type: ignore[no-untyped-def]
        from google.auth.exceptions import RefreshError
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        if self._creds is None:
            record = self.store.load(SECRET_NAME)
            if not record:
                raise NotifierError("Gmail yetkisi yok: `unitakip gmail-auth --client-secret <dosya>` çalıştır.")
            info = record["authorized_user"]
            register_secret(info.get("refresh_token"))
            register_secret(info.get("client_secret"))
            self._creds = Credentials.from_authorized_user_info(info, record.get("scopes"))
        if not self._creds.valid:
            try:
                self._creds.refresh(Request())
            except RefreshError as exc:
                # Diske yeni yetki aktarılmış olabilir (push-session): bir sonraki denemede yeniden oku
                self._creds = None
                self._service = None
                raise NotifierError(
                    "Gmail yenileme token'ı reddedildi (iptal edilmiş veya OAuth uygulaması 'Testing' modunda "
                    "7 gün dolmuş olabilir). `unitakip gmail-auth` ile yeniden yetkilendir."
                ) from exc
            record = self.store.load(SECRET_NAME) or {}
            record["authorized_user"] = json.loads(self._creds.to_json())
            self.store.save(SECRET_NAME, record)
            register_secret(self._creds.token)
        return self._creds

    def _gmail(self):  # type: ignore[no-untyped-def]
        from googleapiclient.discovery import build

        creds = self._credentials()
        if self._service is None:
            self._service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        return self._service

    def send(self, email: Email) -> str:
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaIoBaseUpload

        try:
            raw = bytes(email.to_mime(self.to))
        except OSError as exc:  # ek dosyası silinmiş/okunamıyor
            raise NotifierError(f"E-posta eki okunamadı: {exc}") from exc
        try:
            msgs = self._gmail().users().messages()
            if len(raw) > _MEDIA_UPLOAD_THRESHOLD:
                media = MediaIoBaseUpload(io.BytesIO(raw), mimetype="message/rfc822", resumable=True)
                result = msgs.send(userId="me", body={}, media_body=media).execute()
            else:
                result = msgs.send(userId="me", body={"raw": base64.urlsafe_b64encode(raw).decode()}).execute()
        except HttpError as exc:
            status = int(getattr(exc.resp, "status", 0) or 0)
            # 400/413: ileti reddedildi (ör. boyut). 401/403/429/5xx: kanal sorunu → hepsi ertelenir.
            raise NotifierError(f"Gmail API hatası: HTTP {status}", permanent=status in (400, 413)) from exc
        except OSError as exc:
            raise NotifierError(f"Gmail bağlantı hatası: {exc}") from exc
        log.info("Gmail ile gönderildi: %s (id=%s)", email.subject, result.get("id"))
        return str(result.get("id"))

    def has_drive_scope(self) -> bool:
        record = self.store.load(SECRET_NAME) or {}
        return DRIVE_FILE in (record.get("scopes") or [])


class DriveUploader:
    """Büyük dosyaları kullanıcının kendi Drive'ına yükler. Paylaşım izni DEĞİŞTİRİLMEZ (yalnızca sahibi görür)."""

    def __init__(self, notifier: GmailNotifier, folder_name: str):
        self.notifier = notifier
        self.folder_name = folder_name
        self._service = None
        self._folder_id: str | None = None

    def _drive(self):  # type: ignore[no-untyped-def]
        from googleapiclient.discovery import build

        if self._service is None:
            self._service = build("drive", "v3", credentials=self.notifier._credentials(), cache_discovery=False)
        return self._service

    def _folder(self) -> str:
        if self._folder_id:
            return self._folder_id
        drive = self._drive()
        q = (f"name = '{self.folder_name.replace(chr(39), '')}' and mimeType = 'application/vnd.google-apps.folder'"
             " and trashed = false")
        found = drive.files().list(q=q, fields="files(id)", pageSize=1).execute().get("files", [])
        if found:
            self._folder_id = found[0]["id"]
        else:
            meta = {"name": self.folder_name, "mimeType": "application/vnd.google-apps.folder"}
            self._folder_id = drive.files().create(body=meta, fields="id").execute()["id"]
        return self._folder_id

    def upload(self, path: Path, filename: str) -> str:
        from googleapiclient.http import MediaFileUpload

        media = MediaFileUpload(str(path), resumable=True)
        meta = {"name": filename, "parents": [self._folder()]}
        result = self._drive().files().create(body=meta, media_body=media, fields="id, webViewLink").execute()
        return str(result.get("webViewLink"))

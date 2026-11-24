"""Şifreleme, gizli değer maskeleme, salt-okunur koruma ve güvenli bağlantı kuralları."""

from __future__ import annotations

import logging
import stat

import pytest

from unitakip.adapters.moodle import FunctionNotAllowed, TokenTransport, flatten_params
from unitakip.adapters.webpages import is_safe_file_link, is_safe_link
from unitakip.crypto import DecryptionError, SecretBox
from unitakip.logging_setup import RedactingFilter, redact, register_secret
from unitakip.models import strip_secrets_from_url
from unitakip.session.store import SessionStore, cookies_from_storage_state, merge_cookies_into_state

from .conftest import ROOT, http_for


def test_secretbox_roundtrip_and_wrong_key(box):
    blob = box.encrypt_json({"token": "abc", "tr": "çğıöşü"})
    assert b"abc" not in blob
    assert box.decrypt_json(blob) == {"token": "abc", "tr": "çğıöşü"}
    with pytest.raises(DecryptionError):
        SecretBox(SecretBox.generate_key()).decrypt_json(blob)


def test_session_store_permissions_and_names(tmp_path, box):
    store = SessionStore(tmp_path / "secrets", box)
    store.save("sanal.token", {"token": "gizli-token-123"})
    path = tmp_path / "secrets" / "sanal.token.enc"
    assert b"gizli-token-123" not in path.read_bytes()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert store.load("sanal.token")["token"] == "gizli-token-123"
    assert store.age("sanal.token") is not None
    with pytest.raises(ValueError):
        store.save("../kacis", {})
    assert store.delete("sanal.token") and store.load("sanal.token") is None


def test_redaction_patterns():
    text = ("GET /webservice/pluginfile.php/1/a.pdf?token=abcdef123456&x=1 "
            '{"password": "hunter22", "refresh_token": "1//xyz"} Cookie: MoodleSession=s3cr3t sifre=parola123')
    out = redact(text)
    for secret in ("abcdef123456", "hunter22", "1//xyz", "s3cr3t", "parola123"):
        assert secret not in out
    register_secret("calisma-aninda-gizli")
    assert "calisma-aninda-gizli" not in redact("hata: calisma-aninda-gizli reddedildi")
    assert "errorcode=invalidtoken" in redact("errorcode=invalidtoken")


def test_redaction_covers_identity_tokens_and_escaped_json_values():
    out = redact(r'{"password": "masked\"fragment", "id_token": "identity-token"} id_token=redirect-token')
    assert "fragment" not in out and "identity-token" not in out and "redirect-token" not in out
    url = "https://student:synthetic@portal.test/page?id=123&refresh_token=synthetic#id_token=synthetic"
    assert strip_secrets_from_url(url) == "https://portal.test/page?id=123"


def test_logging_filter_masks_args_and_exceptions(caplog):
    logger = logging.getLogger("test.redact")
    logger.addFilter(RedactingFilter())
    with caplog.at_level(logging.INFO, logger="test.redact"):
        logger.info("istek %s", "server.php?wstoken=deadbeefcafe")
        try:
            raise RuntimeError("password=supersecret")
        except RuntimeError:
            logger.exception("hata")
    joined = "\n".join(r.getMessage() + (r.exc_text or "") for r in caplog.records)
    assert "deadbeefcafe" not in joined and "supersecret" not in joined


def test_moodle_write_functions_are_blocked():
    transport = TokenTransport(http_for(lambda r: None), ROOT, "tok123456")
    for fn in ("mod_assign_save_submission", "mod_quiz_start_attempt", "core_user_update_users",
               "enrol_self_enrol_user", "mod_forum_add_discussion_post"):
        with pytest.raises(FunctionNotAllowed):
            transport.call(fn, {})


def test_flatten_params():
    assert flatten_params({"courseids": [3, 5], "options": {"userevents": True, "x": None}, "n": 1}) == {
        "courseids[0]": "3", "courseids[1]": "5", "options[userevents]": "1", "n": "1"}


@pytest.mark.parametrize("url,text,safe", [
    ("https://x/index.php?do=dersler", "Derslerim", True),
    ("https://x/index.php?do=derskayitol&id=5", "Kayıt Ol", False),
    ("https://x/logout.php", "", False),
    ("https://x/Account/LogOff", "Çıkış", False),
    ("https://x/index.php?do=sil&id=3", "", False),
    ("https://x/odev.php?id=2", "Teslim Et", False),
    ("javascript:void(0)", "", False),
])
def test_crawl_denylist(url, text, safe):
    assert is_safe_link(url, text) is safe


def test_file_links_are_not_overblocked():
    assert is_safe_file_link("https://x/dosya/Ders_Silabusu.pdf")
    assert is_safe_file_link("https://x/files/addendum.docx")
    assert not is_safe_file_link("https://x/dosya.php?action=delete&f=a.pdf")


def test_cookie_conversion_roundtrip():
    state = {"cookies": [{"name": "PHPSESSID", "value": "1", "domain": "web.test", "path": "/"}]}
    jar = cookies_from_storage_state(state)
    jar.set("PHPSESSID", "2", domain="web.test", path="/")
    merged = merge_cookies_into_state(state, jar)
    assert [c["value"] for c in merged["cookies"] if c["name"] == "PHPSESSID"] == ["2"]

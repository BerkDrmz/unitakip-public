"""LLM sağlayıcıları: Ollama (yerel, ücretsiz) ve Anthropic Claude (ücretli, açık onay gerekir).

Her iki sağlayıcı da yalnızca verilen içeriğe dayanmak zorundadır. Yanıt şemaya uymazsa veya
hata olursa kural tabanlı analize geri dönülür. Bu yüzden bildirim hiçbir zaman AI yüzünden kaybolmaz.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

from ..storage.db import Database
from .base import ANALYSIS_SCHEMA, IMPORTANCE_LEVELS, Analysis, AnalysisInput, redact_personal

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "Bir üniversite öğrencisi için ders platformlarındaki yeni içerikleri değerlendiriyorsun. "
    "YALNIZCA verilen içerikteki bilgileri kullan; içerikte olmayan tarih, not, kural veya ayrıntı uydurma. "
    "Son tarih içerikte açıkça yoksa 'deadline' alanını boş dize bırak. "
    "'evidence' alanına, tarih veya önem kararını destekleyen kısa bir alıntıyı içerikten aynen kopyala. "
    "Özet Türkçe, en fazla 3 cümle olsun. Önem: düşük | orta | yüksek | kritik. "
    "Öncelik 1 (hemen ilgilen) ile 5 (acil değil) arasında olsun. "
    "Metin kırpılmış olabilir; bu durumda yalnızca görünen kısma göre karar ver."
)

# USD / 1M token (giriş, çıkış). claude-api skill tablosundan, 2026-10-06 önbelleği.
PRICES_PER_MTOK = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}
# Sunucu tarafı ret yedeklemesini ("fallbacks") destekleyen modeller
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"}


def build_user_prompt(inp: AnalysisInput, text: str, truncated: bool) -> str:
    return (
        f"Platform: {inp.platform}\n"
        f"Ders: {inp.course or 'bilinmiyor'}\n"
        f"Tür: {inp.kind_label}\n"
        f"Değişiklik türü: {inp.change_type}\n"
        f"Başlık: {inp.title}\n"
        f"Platformdaki teslim/son tarih alanı: {inp.due_at.isoformat() if inp.due_at else 'yok'}\n"
        f"Metin {'(KIRPILDI)' if truncated else ''}:\n<icerik>\n{text}\n</icerik>"
    )


def validate(data: dict[str, Any], provider: str, truncated: bool) -> Analysis:
    importance = str(data.get("importance", "orta")).lower()
    if importance not in IMPORTANCE_LEVELS:
        importance = "orta"
    try:
        priority = max(1, min(5, int(data.get("priority", 3))))
    except (TypeError, ValueError):
        priority = 3
    actions = [str(a)[:200] for a in (data.get("actions") or []) if str(a).strip()][:6]
    return Analysis(
        course=str(data.get("course") or "")[:150], topic=str(data.get("topic") or "")[:150],
        summary=str(data.get("summary") or "")[:800], importance=importance,
        deadline=(str(data.get("deadline")).strip() or None) if data.get("deadline") else None,
        actions=actions, priority=priority, evidence=str(data.get("evidence") or "")[:300],
        source=provider, truncated=truncated,
    )


class OllamaAnalyzer:
    """Yerel model (ör. qwen3:8b). Veri makineden çıkmaz. Yaklaşık 6-8 GB RAM ister."""

    name = "ollama"

    def __init__(self, url: str, model: str, max_input_chars: int, redact: bool, timeout: float = 180.0):
        self.url = url.rstrip("/")
        self.model = model
        self.max_input_chars = max_input_chars
        self.redact = redact
        self.timeout = timeout

    def analyze(self, inp: AnalysisInput) -> Analysis:
        text, truncated = inp.combined_text(self.max_input_chars)
        if self.redact:
            text = redact_personal(text)
        resp = httpx.post(
            f"{self.url}/api/chat",
            json={
                "model": self.model, "stream": False, "format": ANALYSIS_SCHEMA,
                "options": {"temperature": 0},
                "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                             {"role": "user", "content": build_user_prompt(inp, text, truncated)}],
            },
            timeout=self.timeout,
        )
        resp.raise_for_status()
        content = resp.json()["message"]["content"]
        return validate(json.loads(content), self.name, truncated)


class AnthropicAnalyzer:
    """Claude API. ÜCRETLİ: yalnızca ai.provider=anthropic VE ai.allow_paid=true ise oluşturulur."""

    name = "anthropic"

    def __init__(self, model: str, max_input_chars: int, redact: bool, db: Database, monthly_budget_usd: float):
        import anthropic  # isteğe bağlı bağımlılık: pip install 'unitakip[anthropic]'

        if not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
            raise RuntimeError("ANTHROPIC_API_KEY tanımlı değil (.env).")
        self._anthropic = anthropic
        self.client = anthropic.Anthropic(max_retries=2, timeout=120.0)
        self.model = model
        self.max_input_chars = max_input_chars
        self.redact = redact
        self.db = db
        self.monthly_budget_usd = monthly_budget_usd

    def _cost(self, model: str, usage: Any) -> tuple[int, int, float]:
        in_tok = int(getattr(usage, "input_tokens", 0) or 0)
        out_tok = int(getattr(usage, "output_tokens", 0) or 0)
        pin, pout = PRICES_PER_MTOK.get(model, PRICES_PER_MTOK["claude-opus-5-5"])
        return in_tok, out_tok, (in_tok * pin + out_tok * pout) / 1_000_000

    def analyze(self, inp: AnalysisInput) -> Analysis:
        spent = self.db.ai_month_cost(self.name)
        if spent >= self.monthly_budget_usd:
            raise BudgetExceeded(f"Aylık AI bütçesi doldu: ${spent:.2f} / ${self.monthly_budget_usd:.2f}")
        text, truncated = inp.combined_text(self.max_input_chars)
        if self.redact:
            text = redact_personal(text)
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": build_user_prompt(inp, text, truncated)}],
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": ANALYSIS_SCHEMA}},
        }
        if self.model in _FALLBACK_MODELS:
            response = self.client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **params)
        else:
            response = self.client.messages.create(**params)

        served_by = getattr(response, "model", self.model) or self.model
        in_tok, out_tok, cost = self._cost(served_by, response.usage)
        self.db.ai_record_usage(self.name, served_by, in_tok, out_tok, cost)
        if response.stop_reason == "refusal":
            raise RuntimeError("Model isteği reddetti (refusal).")
        if response.stop_reason == "max_tokens":
            raise RuntimeError("Yanıt max_tokens sınırında kesildi.")
        text_block = next((b.text for b in response.content if b.type == "text"), None)
        if not text_block:
            raise RuntimeError("Yanıtta metin bloğu yok.")
        analysis = validate(json.loads(text_block), self.name, truncated)
        analysis.notes.append(f"model={served_by}, ~${cost:.4f}")
        return analysis


class BudgetExceeded(RuntimeError):
    pass

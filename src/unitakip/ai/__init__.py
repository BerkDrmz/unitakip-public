"""AI katmanı fabrikası: önbellek, gizlilik kuralları, bütçe ve güvenli geri dönüş."""

from __future__ import annotations

import logging

from ..config import AIConfig
from ..models import SENSITIVE_KINDS, Kind, canonical_json, sha256_text
from ..storage.db import Database
from .base import Analysis, AnalysisInput, Analyzer
from .heuristic import HeuristicAnalyzer

log = logging.getLogger(__name__)

# AI'ın anlamlı katkı sağlamadığı türler: kural tabanlı analiz yeterli (maliyet + gizlilik)
_HEURISTIC_ONLY = {Kind.COURSE, Kind.LINK} | SENSITIVE_KINDS


class AnalysisService:
    def __init__(self, cfg: AIConfig, db: Database, timezone: str):
        self.cfg = cfg
        self.db = db
        self.heuristic = HeuristicAnalyzer(timezone, cfg.max_input_chars)
        self.llm: Analyzer | None = None
        self.llm_error: str | None = None
        try:
            self.llm = self._make_llm()
        except Exception as exc:  # noqa: BLE001 - AI yoksa sistem yine çalışmalı
            self.llm_error = str(exc)
            log.error("AI sağlayıcısı başlatılamadı, kural tabanlı analiz kullanılacak: %s", exc)

    def _make_llm(self) -> Analyzer | None:
        if self.cfg.provider == "heuristic":
            return None
        if self.cfg.provider == "ollama":
            from .llm import OllamaAnalyzer
            return OllamaAnalyzer(self.cfg.ollama_url, self.cfg.ollama_model, self.cfg.max_input_chars,
                                  self.cfg.redact_personal_data)
        if self.cfg.provider == "anthropic":
            if not self.cfg.allow_paid:
                raise RuntimeError("ai.provider=anthropic ücretli bir servistir; ai.allow_paid=true ile açıkça onayla.")
            from .llm import AnthropicAnalyzer
            return AnthropicAnalyzer(self.cfg.anthropic_model, self.cfg.max_input_chars, self.cfg.redact_personal_data,
                                     self.db, self.cfg.monthly_budget_usd)
        raise RuntimeError(f"Bilinmeyen AI sağlayıcısı: {self.cfg.provider}")

    def analyze(self, inp: AnalysisInput) -> Analysis:
        use_llm = self.llm is not None and inp.kind not in _HEURISTIC_ONLY and bool((inp.text or inp.file_text or "").strip())
        if not use_llm:
            return self.heuristic.analyze(inp)
        assert self.llm is not None
        key = sha256_text(canonical_json({
            "p": self.llm.name, "k": str(inp.kind), "c": inp.change_type, "t": inp.title, "x": inp.text,
            "d": inp.diff_summary, "f": inp.file_text, "due": inp.due_at.isoformat() if inp.due_at else None}))
        cached = self.db.ai_cache_get(key)
        if cached:
            return Analysis.from_dict(cached)
        try:
            result = self.llm.analyze(inp)
        except Exception as exc:  # noqa: BLE001 - hiçbir AI hatası bildirimi engellememeli
            log.warning("AI analizi başarısız (%s), kural tabanlıya dönülüyor: %s", self.llm.name, exc)
            result = self.heuristic.analyze(inp)
            result.notes.append(f"{self.llm.name} kullanılamadı: {str(exc)[:120]}")
            return result
        # Uydurma tarih koruması: platformda yapılandırılmış tarih varsa o esas alınır
        if inp.due_at is not None:
            result.deadline = inp.due_at.isoformat(timespec="minutes")
        self.db.ai_cache_put(key, self.llm.name, result.to_dict())
        return result


__all__ = ["Analysis", "AnalysisInput", "AnalysisService"]

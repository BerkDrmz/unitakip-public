# Yapay zekâ katmanı: seçenekler ve karar

## Ne zaman çalışır?

- Yalnızca **bildirilecek** (yeni/güncellenmiş, baseline olmayan) içeriklerde çalışır.
- Aynı içerik için sonuç önbelleğe alınır (`ai_cache`), yani bir içerik iki kez analiz edilmez.
- Notlar ve devamsızlık (`grade`, `attendance`) **hiçbir zaman** harici modele gönderilmez. Bunlar her zaman yerel kural tabanlı analizle işlenir.
- Platformda yapılandırılmış bir teslim tarihi varsa, modelin bulduğu tarih yerine o kullanılır (uydurma tarih koruması).
- Model hata verirse, bütçe dolarsa ya da yanıt şemaya uymazsa kural tabanlı analize dönülür. Bildirim hiçbir durumda AI yüzünden kaybolmaz.

## Karşılaştırma

| | `heuristic` (varsayılan) | `ollama` (yerel LLM) | `anthropic` (Claude API) |
|---|---|---|---|
| Maliyet | 0 | 0 (donanım/elektrik) | Ücretli, kullanım başına |
| Gizlilik | Veri makineden çıkmaz | Veri makineden çıkmaz | Metin Anthropic'e gider (e-posta, telefon, TC no ve öğrenci no maskelenir) |
| Donanım | Yok denecek kadar az | 8B model için ~6–8 GB RAM, CPU'da ileti başına 20–90 sn | Yok |
| Kalite | Tarih ve anahtar sözcük kuralları; özet = ilk cümleler | İyi; Türkçe performansı modele bağlı | En iyi; şemaya uyan JSON (structured outputs) |
| 1 GB'lık ucuz VPS'te | ✔ | ✘ (RAM yetmez) | ✔ |
| Kurulum | Yok | `docker compose --profile local-ai up -d` + `ollama pull qwen3:8b` | `pip install 'unitakip[anthropic]'`, `ANTHROPIC_API_KEY`, `ai.allow_paid: true` |

### Claude API maliyet tahmini

Varsayım: içerik başına ~3.000 giriş + ~400 çıkış token'ı, ayda ~60 bildirilecek içerik.
Fiyatlar Anthropic'in 2026-10 liste fiyatlarıdır (1M token başına giriş/çıkış).

| Model | Fiyat ($/1M token) | İçerik başına | Aylık (60 içerik) |
|---|---|---|---|
| `claude-opus-5-5` (yapılandırmadaki varsayılan) | 4 / 20 | ~$0,020 | ~$1,2 |
| `claude-haiku-5-5` (en ucuz) | 0,10 / 0,50 | ~$0,0005 | ~$0,03 |

`ai.monthly_budget_usd` (varsayılan $2) dolunca ücretli çağrılar o ay için durur.
Model seçimi senin kararın: bu iş türü (kısa özet ve tarih çıkarma) için Haiku büyük olasılıkla yeterli
ve yaklaşık 40 kat daha ucuz. Opus ise en yüksek doğruluğu verir.

## Öneri

1. **Başlangıç:** `heuristic`. Ücretsizdir, gizlidir, 1 GB RAM'li sunucuda çalışır. Tarih çıkarma ve önem derecesi zaten bildirimde yer alır.
2. Özet kalitesi yetmezse: **`anthropic` + `claude-haiku-5-5`**. Aylık maliyet birkaç sentle sınırlıdır. Açmak için `config.yaml` dosyasında:
   ```yaml
   ai:
     provider: anthropic
     allow_paid: true          # açık onay — bu satır olmadan ücretli çağrı yapılmaz
     anthropic_model: claude-haiku-5-5
     monthly_budget_usd: 1.0
   ```
3. Verinin hiç dışarı çıkmamasını istiyorsan ve sunucuda 8 GB+ RAM varsa: **`ollama`**.

Ücretli servis bu projede **etkinleştirilmedi**.

# Faz 2 — Mimari

## Genel akış

```
                 ┌──────────────── daemon (scheduler.py) ────────────────┐
                 │  her 30 sn "tick": vadesi gelen platformu çalıştır,   │
                 │  bekleyen bildirimleri gönder, heartbeat yaz          │
                 └──────┬───────────────────────────────┬────────────────┘
                        │ platform başına izole         │
        ┌───────────────▼───────────┐         ┌─────────▼─────────┐
        │ Adapter.fetch() → Snapshot│         │ Notifier (Gmail)  │
        │  moodle.py  (WS/AJAX)     │         │  outbox = changes │
        │  webpages.py (HTTP/PW)    │         │  notified_at NULL │
        └───────────────┬───────────┘         └─────────▲─────────┘
                        │ Item[] + complete_scopes      │
                ┌───────▼────────┐   yeni/değişen  ┌────┴──────┐
                │ diff.py        ├────────────────►│ AI katmanı│
                │ SQLite (items, │   dosyalar      │ heuristic │
                │ changes, files)├──► archive.py ─►│ / ollama  │
                └────────────────┘   SHA-256 dedup │ / claude  │
                                                   └───────────┘
```

## Bileşenler ve kararlar

| Modül | Görev | Karar ve gerekçe |
|---|---|---|
| `config.py` | YAML + ortam değişkenleri | Pydantic ile doğrulama. Gizli bilgiler YAML'a değil `.env`'e yazılır |
| `crypto.py` | Fernet (AES-128-CBC + HMAC-SHA256) | Kimliği doğrulanmış şifreleme, `cryptography` kütüphanesi. Anahtar `UNITAKIP_MASTER_KEY` ortam değişkeninde, veriden ayrı |
| `session/store.py` | Platform başına şifreli oturum (`data/secrets/*.enc`) | Playwright `storage_state` ve Moodle token'ı aynı formatta saklanır. Taşınabilir: Mac'te giriş, VPS'te kullanım |
| `session/browser.py` | Görünür tarayıcıda manuel giriş | Kullanıcı giriş yapar, sistem yalnızca çerezleri alır. CAPTCHA ve MFA'ya dokunulmaz |
| `adapters/moodle.py` | Sanal Öğrenme | Belgelenmiş Moodle WS API'si kullanılıyor, HTML kazıma yok. Sürüm değişikliklerine dayanıklı. `site_info.functions` listesine göre kendini ayarlıyor. **Salt-okunur izin listesi** dışındaki fonksiyonlar kod düzeyinde engelli |
| `adapters/webpages.py` | Öğreniyorum.net, ÜBYS | Seçici tahmini yok. Tablolar satır kayıtlarına, dosya bağlantıları dosya kayıtlarına, sayfa metni satır farkına dönüştürülüyor. Sayfa listesi keşif aracından geliyor. Engel listesiyle güvenli gezinti |
| `http.py` | Tek HTTP istemcisi | Host başına en az 1,5 sn aralık, 429/5xx ve ağ hatalarında üstel geri çekilme (en fazla 3 deneme), yanıt boyutu sınırı |
| `storage/db.py` | SQLite (WAL) | Tek süreç, düşük yazma hacmi, sıfır yönetim, tek dosya yedeği. PostgreSQL bu ölçek için gereksiz bir işletim yükü olurdu |
| `diff.py` | Değişiklik algılama | `(platform, external_id)` kararlı kimlik. Normalize edilmiş verinin SHA-256 özeti. Silinme yalnızca **eksiksiz çekilen kapsamlarda** işaretleniyor (kısmi hata yanlış "silindi" üretmesin). İlk tarama ve yeni bir ders **baseline** sayılıyor, toplu bildirim üretmiyor Toplu düşüş koruması: daha önce ≥3 öğesi olan bölüm %30'un altına düşerse 3 kontrol boyunca işlenmez (bakım sayfası), sonra kabul edilip bildirilir. `updated` tekilleştirmesi gün bazlı |
| `archive.py` | Dosya arşivi | `source_key = sha256(url'nin token'sız hali + timemodified + boyut)` ile aynı sürüm yeniden indirilmez. İçerik SHA-256 ile tekilleştirilir. HTML dönerse (oturum düşmüşse) dosya olarak kaydedilmez |
| `ai/` | Analiz | Varsayılan sağlayıcı `heuristic`: ücretsiz, yerel, veri dışarı çıkmaz. `ollama` yerel LLM, `anthropic` ücretli olup açık onay bayrağı olmadan çalışmaz. Notlar ve devamsızlık **asla** harici modele gönderilmez |
| `notify/` | Gmail API (OAuth 2.0, `gmail.send` kapsamı) | En az yetki ilkesi gereği okuma izni yok. Bir çalıştırmadaki değişiklikler tek e-postada toplanıyor. Ek sınırı 15 MB (base64 ile ~20,5 MB, Gmail sınırı 25 MB). Aşanlar Drive'a (`drive.file`, isteğe bağlı) ya da bağlantı olarak gidiyor. Gönderilemeyen bildirim **asla düşürülmez**; 10→60 dk geri çekilmeyle yeniden denenir. Tekrar tekrar başarısız olan grup tek tek gönderilir ki bozuk tek kayıt kuyruğu kilitlemesin |
| `scheduler.py` | 7/24 döngü | `next_run_at` veritabanında, yeniden başlatmada kalınan yerden devam. Platformlar sırayla ve izole çalışıyor. Döngünün her adımı korumalı: beklenmeyen bir hata loglanır ve döngü devam eder. Ağ hatasında 10 → 20 → 40 dk geri çekilme. Dosya kilidi çift örneği engelliyor Bekçi iş parçacığı takılan kontrolde süreci yeniden başlatır. Sessiz arıza koruması (haftalık durum e-postası, 24 saat uyarısı, sürekli alınamayan bölüm uyarısı), günlük SQLite yedeği, disk alanı kontrolü, saat geri alınmasına karşı zamanlama koruması |
| `logging_setup.py` | Loglar | Token, parola, çerez ve `wstoken=` değerleri maskeleniyor. Çalışma anında kaydedilen gizli değerler de maskeleniyor |

## Veri modeli (SQLite)

- `platform_state`: oturum durumu, baseline, `next_run_at`, ardışık hata sayısı, yeniden giriş bildirimi zamanı
- `items`: `UNIQUE(platform, external_id)`, `kind`, `scope`, `course_*`, `title`, `url`, `due_at`, `version`, `content_hash`, `data` (JSON), `first_seen/last_seen/last_changed/removed_at`
- `changes`: `dedupe_key UNIQUE` (`platform|external_id|change_type|content_hash`), `summary` (alan farkı), `ai_json`, `notified_at`, `notify_attempts`, `baseline`
- `files`: `source_key UNIQUE`, `sha256`, `size`, `path`
- `runs`: çalıştırma geçmişi
- `ai_cache`, `ai_usage`: aynı içerik iki kez analiz edilmiyor, aylık bütçe takibi

## Değişiklik türleri

`new`, `updated` (alan farkı: "Teslim tarihi: 12.11 → 15.11", "Not: - → 85"), `removed` (varsayılan olarak bildirilmez),
`new_scope` (yeni ders veya sayfa, tek özet satırı), `reauth_required`, `platform_unreachable`.

## Güvenlik sınırları (kodda zorunlu)

1. Moodle: `READ_ONLY_FUNCTIONS` izin listesi. `mod_assign_save_submission`, `*_submit_*`, `*_update_*` gibi fonksiyonlar çağrılamaz.
2. Web sayfaları: yalnızca GET. Form gönderimi yok (isteğe bağlı otomatik giriş formu dışında). Bağlantılar engel listesinden geçiyor.
3. CAPTCHA, SMS ve e-Devlet adımları yalnızca kullanıcı tarafından tamamlanır.
4. Gizli değerler `data/secrets/` altında şifreli. `.env` ve `data/` git dışında.

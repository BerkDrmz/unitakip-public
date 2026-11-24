# Faz 1 — Öğreniyorum.net (ogreniyorum.net/mooc) keşif raporu

Tarih: 2026-11-09. Hesap girişi **yapılmadı**.

## 1. Doğrulanan bulgular (giriş yapmadan)

| Konu | Bulgu |
|---|---|
| Platform | Özel PHP uygulaması (Moodle değil). `server: LiteSpeed`, `x-powered-by: PleskLin` |
| Kök | `/` → `301 /mooc`. `robots.txt` yok (404) |
| `index.php?do=derskayitol` | Giriş yapılmamışsa **giriş formunu** gösteriyor (200, yaklaşık 7 KB) |
| Giriş formu | `POST` (action yok, yani aynı URL'ye gidiyor). Alanlar: `kullaniciadi` (e-posta), `sifre`, `remember` (checkbox, "Beni Hatırla") |
| CSRF / CAPTCHA | Formda CSRF token'ı **yok**. CAPTCHA **yok** |
| Çerez | `PHPSESSID` (secure, HttpOnly, SameSite=Lax) |
| Diğer sayfalar | `sifremi_unuttum.php`, `yenikayit.php` |
| Dinamik yapı | Giriş sayfasında harici script yok. Büyük olasılıkla sunucu tarafında üretilen HTML |

## 2. Tasarıma etkisi

- **Oturum yöntemi:** Playwright ile görünür tarayıcıda kullanıcı **kendisi** giriş yapar.
  "Beni Hatırla" işaretlenirse uzun ömürlü bir çerez bekleniyor (oturumlu keşifte doğrulanacak).
  Çerezler şifreli `storage_state` olarak saklanır, kontroller hafif HTTP istekleriyle yapılır.
- **Oturum bitti algılaması:** Yanıtta `name="sifre"` alanı görünüyorsa oturum düşmüştür.
  Bu işaret herkese açık sayfada doğrulandı.
- **İsteğe bağlı otomatik yeniden giriş:** Form alanları belli ve CAPTCHA yok. Kullanıcı açıkça
  `--remember-credentials` derse, şifreli saklanan bilgilerle aynı formu gönderip oturumu
  tazeleyebiliriz. Varsayılan olarak **kapalı**.
- **İçerik takibi:** Giriş sonrası sayfaların yapısı bilinmediği için seçici **tahmin edilmedi**.
  Genel "web sayfası" adaptörü tabloları satır satır, dosya bağlantılarını ve metin bloklarını normalize
  edip izliyor. Oturumlu keşif hangi sayfaların izleneceğini önerecek
  (`unitakip discover ogreniyorum --apply`).

## 3. Riskler

- `do=derskayitol` = "derse kayıt ol". Bu sayfadaki bağlantılar **kayıt işlemi** yapıyor olabilir.
  Gezgin, `kayit|kaydol|enrol|sil|kaydet|onay|cikis...` içeren bağlantıları **asla** takip etmiyor.
  Bu engel listesi testlerle doğrulanıyor.
- Platform özel yazılım olduğu için yapı habersiz değişebilir. Adaptör seçici değil yapı tabanlı
  çalıştığı için değişikliklerde çökmüyor, en kötü durumda gürültülü bir "sayfa değişti" bildirimi üretiyor.

## 4. Oturumlu keşif

```bash
.venv/bin/unitakip login ogreniyorum      # tarayıcı açılır, "Beni Hatırla"yı işaretleyip giriş yap
.venv/bin/unitakip discover ogreniyorum   # salt-okunur gezinti + ağ istekleri kaydı
```

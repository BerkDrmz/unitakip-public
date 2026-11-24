# Faz 1 — ÜBYS (ubys.bartin.edu.tr) keşif raporu

Tarih: 2026-11-09. Hesap girişi **yapılmadı**.

## 1. Doğrulanan bulgular (giriş yapmadan)

| Konu | Bulgu |
|---|---|
| Platform | ASP.NET MVC (`X-Powered-By: ASP.NET`, `Server: UBS Web Server`), AdminLTE tabanlı arayüz |
| Ana sayfa | Yaklaşık **4,6 MB** tek HTML (menüler ve gömülü scriptler). Saatlik tam indirme pahalı, hafif uç noktalar tercih edilmeli |
| Çerezler | `ASP.NET_SessionId`, `__RequestVerificationToken` (antiforgery) |
| Giriş akışı | `#loginForm` → AJAX `POST /Account/Login` (`username`, `password`, `__RequestVerificationToken`) |
| **İkinci adım (SMS)** | `#loginCodeForm` → `POST /Account/LoginCode`, alan `code`. Metin: "Sisteme giriş için telefonunuza gelen sms kodunu giriniz". Süre `timeValue = 180` sn |
| e-Devlet | `giris.turkiye.gov.tr` OAuth2 (`scope=Kimlik-Dogrula`, `redirect_uri=/edevlet`) |
| CAPTCHA | Değişkenler var ama şu an **kapalı** (`_usingCaptcha=false`, `_usingreCaptchav3=false`, `_reCAPTCHASiteKey=null`) |
| Diğer | Şifre sıfırlama (e-posta / SMS), e-imza alanları |

## 2. Tasarıma etkisi

- **SMS doğrulaması bir MFA kontrolüdür ve aşılmayacak.** İlk giriş her zaman kullanıcı tarafından
  görünür tarayıcıda yapılır (kullanıcı adı ve parola + SMS, ya da e-Devlet).
- Bu yüzden ÜBYS'de **otomatik yeniden giriş yapılmayacak**. Oturum düşünce sistem Gmail ile
  "yeniden giriş gerekli" e-postası atar (24 saatte en fazla bir hatırlatma).
- Oturumun ne kadar yaşadığı (boşta zaman aşımı, kayan süre, kalıcı auth çerezi) **giriş sonrası
  ölçülecek**. Kısa bir boşta zaman aşımı varsa (ASP.NET varsayılanı 20 dk), yapılandırmadaki
  `keepalive_minutes` ile hafif bir canlı tutma isteği açılabilir. Bu istek, keşifte bulunacak
  küçük bir uç noktaya gönderilmeli, 4,6 MB'lık ana sayfaya değil.
- Arayüz AJAX ağırlıklı göründüğü için varsayılan oluşturucu `browser` (Playwright headless)
  seçildi. JavaScript ile yüklenen not ve devamsızlık tabloları da böylece okunabiliyor.
- **Oturum bitti algılaması:** Sayfada `id="loginForm"` / `/Account/Login` görünüyorsa oturum düşmüştür
  (herkese açık sayfada doğrulandı).

## 3. Oturum gerektiren ve DOĞRULANMAMIŞ konular

- Öğrenci menüsünün yapısı (not bilgileri, devamsızlık, ders programı, sınav takvimi, duyurular).
- Bu verilerin geldiği AJAX uç noktaları (JSON mı, HTML parçası mı).
- Oturum çerezlerinin süresi ve IP'ye bağlı olup olmadığı. Bu nokta, Mac'te giriş yapıp oturumu
  VPS'e taşıma senaryosunu doğrudan etkiliyor.
- Yurt dışı IP'lerden erişimin engellenip engellenmediği (VPS konumu seçimini etkiler).

## 4. Oturumlu keşif

```bash
.venv/bin/unitakip login ubys      # tarayıcı açılır: kullanıcı adı, parola, SMS kodu SENİN tarafından
.venv/bin/unitakip discover ubys   # menüyü salt-okunur gezer, XHR uç noktalarını ve çerez sürelerini kaydeder
```

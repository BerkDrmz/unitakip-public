# Güvenlik, gizlilik ve sınırlar

## Gizli bilgiler nerede?

| Bilgi | Yer | Koruma |
|---|---|---|
| Şifreleme anahtarı | `.env` → `UNITAKIP_MASTER_KEY` | git dışı, `chmod 600`, veriden ayrı |
| Moodle token'ı | `data/secrets/sanal.token.enc` | Fernet (AES-128-CBC + HMAC-SHA256) |
| Tarayıcı oturumları (çerezler) | `data/secrets/<platform>.session.enc` | Fernet |
| Gmail OAuth yenileme token'ı | `data/secrets/gmail.oauth.enc` | Fernet, `gmail.send` kapsamı (okuma yok) |
| Gmail uygulama şifresi (SMTP seçilirse) | `data/secrets/gmail.smtp.enc` | Fernet; OAuth'tan daha geniş erişim, yalnızca gizli terminal istemiyle alınır |
| Kimlik bilgileri (yalnızca `--remember-credentials`) | `data/secrets/<platform>.credentials.enc` | Fernet. **Varsayılan: saklanmaz** |
| Anthropic anahtarı (isteğe bağlı) | `.env` | git dışı |

- Parolalar kaynak koduna, loglara ve yapılandırmaya **yazılmaz**. Loglarda `token=`, `wstoken=`, `password`, `sifre`, çerez ve `Authorization` değerleri, ayrıca çalışma anında kaydedilen her gizli değer maskelenir. Bunu `tests/test_security.py` doğruluyor.
- URL'ler kalıcı kimlik veya e-posta bağlantısı olarak kullanılmadan önce `token`/`sesskey` parametrelerinden arındırılır.
- Not: Proje harici bir diskteyse (exFAT veya APFS "owners disabled" modu) dosya izinleri (chmod 600/700) uygulanmayabilir; şifreleme yine korur. Dahili diskte ve sunucuda izinler normal çalışır.

## `--remember-credentials` takası

| | Kapalı (varsayılan) | Açık |
|---|---|---|
| Moodle token'ı dolunca | E-posta → sen `unitakip login sanal` çalıştırırsın | Otomatik yenilenir (`auto_relogin: true`) |
| Öğreniyorum.net oturumu düşünce | E-posta | Aynı giriş formu otomatik gönderilir |
| Risk | Yalnızca iptal edilebilir token/çerez saklanır | Sunucu ele geçirilir ve `.env` de çalınırsa parola açığa çıkar |
| ÜBYS | — | **Desteklenmez**: SMS doğrulaması var, otomatik giriş yapılmaz |

## Platform kuralları ve yasaklar (kodla zorunlu)

- **Salt-okunur:** Moodle'da yalnızca `READ_ONLY_FUNCTIONS` listesindeki fonksiyonlar çağrılabilir. Ödev teslimi, quiz denemesi, forum gönderisi ve kayıt işlemleri listede yok ve engellenir (`test_moodle_write_functions_are_blocked`).
- Web sayfalarında yalnızca GET isteği atılır. Tek istisna, izin verilmiş otomatik giriş formudur. Keşif gezgini `kayıt, sil, onay, teslim, çıkış, şifre, ödeme...` içeren bağlantıları takip etmez (`test_crawl_denylist`).
- CAPTCHA, SMS kodu, e-Devlet ve Moodle'ın "yalnızca resmi uygulama" (QR) kısıtlaması **aşılmaz**. Bu adımlar her zaman kullanıcı tarafından tamamlanır.
- Yalnızca kullanıcının kendi hesabıyla erişebildiği içerik işlenir.
- Hız sınırı: saatlik kontrol, host başına en az 1,5 sn aralık, gereksiz kaynak (görsel/font) yüklenmez.

## Harici servislere giden veri

| Servis | Ne gider | Ne zaman |
|---|---|---|
| Gmail API veya SMTP | Bildirim e-postası (yapılandırılmış alıcıya); SMTP'de Google'a TLS üzerinden uygulama şifresiyle giriş yapılır | Her bildirimde; `smtp-auth` yalnızca girişi doğrular |
| Google Drive (isteğe bağlı) | Toplam 15 MB'ı aşan ekler; paylaşım izni değiştirilmez | `drive_upload: true` ise |
| Anthropic (isteğe bağlı) | Duyuru/ödev metni ve dosya metni (≤12.000 karakter). Kişisel tanımlayıcılar maskelenir; not ve devamsızlık **asla** gitmez | `provider: anthropic` + `allow_paid: true` ise |

## Gmail SMTP / uygulama şifresi

`unitakip smtp-auth` normal hesap şifresini değil, Google'ın oluşturduğu 16 karakterli uygulama şifresini
ister. Şifre terminalde görünmez; gizli giriş mümkün değilse komut şifreyi almadan durur.
Doğrulanmış TLS bağlantısı zorunludur (`smtp.gmail.com:465`); sertifika kontrolü kapatılamaz.
Şifre yalnızca başarılı girişten sonra mevcut şifreli depoya yazılır; doğrulama e-posta göndermez.
Uygulama şifresi `gmail.send` gibi dar bir kapsamla sınırlı değildir; ele geçirilirse Gmail'e daha geniş
erişim sağlayabilir. Google hesabındaki uygulama şifreleri sayfasından iptal edilebilir.
SMTP sağlayıcısında Drive yüklemesi kullanılmaz.

## Gmail OAuth: önemli tuzak

Google Cloud'daki OAuth uygulaması **"Testing"** durumundaysa yenileme token'ı **7 gün sonra** geçersiz olur.
Bu durumda bildirimler durur. Çözüm: OAuth consent screen → **"Publish app" (In production)**.
Kişisel kullanım için Google doğrulaması gerekmez; yalnızca "doğrulanmamış uygulama" uyarısı çıkar.
Ayrıntılar: [08-kurulum.md](08-kurulum.md#3-gmail-api).

# Faz 1 — Sanal Öğrenme (sanalogrenme.bartin.edu.tr) keşif raporu

Tarih: 2026-11-09. Yöntem: herkese açık uç noktalara `curl` ile, tarayıcıyla aynı yükte (birkaç istek) erişim.
Hesap girişi **yapılmadı**. Oturum gerektiren her bulgu aşağıda ayrıca işaretlendi.

## 1. Doğrulanan bulgular (giriş yapmadan)

| Konu | Bulgu | Kaynak |
|---|---|---|
| Platform | Moodle **5.3** (hata bağlantısı `docs.moodle.org/503/...`), tema `boost`, ESM/React yükleyici `r.php` | `tool_mobile_get_public_config`, giriş sayfası |
| Sunucu | Apache/2.4.58 (Ubuntu) | HTTP başlıkları |
| `/my/` | Giriş yoksa `303 → /login/index.php` | HTTP |
| Web servisleri | `enablewebservices = 1`, `enablemobilewebservice = 1` | public config |
| Giriş tipi | `typeoflogin = 1` → **"uygulama içinden" giriş**: resmi Moodle uygulaması `login/token.php` ile kullanıcı adı ve parola gönderip token alıyor | public config |
| Tarayıcı ile SSO (`launch.php`) | **Kapalı**: "Eklenti etkin değil veya yapılandırılmamış" | `admin/tool/mobile/launch.php` |
| QR ile giriş | `tool_mobile_qrcodetype = 2`, ancak `tool_mobile_get_tokens_for_qr_login` yalnızca resmi uygulamadan çağrılabiliyor (`apprequired`). Bu kısıtlama bilinçli olarak **aşılmadı**. | nologin AJAX |
| MFA | `tool_mfa_enabled = false` | public config |
| CAPTCHA | `enableloginrecaptcha = false` | public config |
| Oturum zaman aşımı | `sessiontimeout = 28800` sn (**8 saat boşta kalma**), uyarı 1200 sn | `M.cfg` |
| Çerez | `MoodleSession` (secure, HttpOnly, SameSite=Lax) | HTTP |
| Giriş formu | `username`, `password`, `logintoken` (CSRF) ve `anchor`. Misafir girişi açık. | giriş sayfası |
| REST uç noktası | `/webservice/rest/server.php` çalışıyor. Token yoksa `invalidtoken` dönüyor. | HTTP |
| `token.php` | Çalışıyor. Parametre yoksa `missingparam (username)` dönüyor. | HTTP |
| Saat dilimi / dil | `Avrupa/Istanbul`, `tr` | `M.cfg` |
| `slasharguments` | `0` → dosya URL'leri `pluginfile.php?file=/...` biçiminde | `M.cfg` |

## 2. Bu bulguların tasarıma etkisi

1. **Birincil yöntem: Moodle Web Servisi + mobil uygulama token'ı.** Site, resmi mobil uygulamaya
   `typeoflogin=1` ile kullanıcı adı ve parolayla token aldırıyor. Biz de aynı resmi ve desteklenen
   yolu kullanıyoruz. Kullanıcı parolasını **bir kez** kendi terminalinde gizli istemle giriyor.
   Parola HTTPS POST ile yalnızca `token.php`'ye gidiyor ve hiçbir yere yazılmıyor. Yalnızca token
   şifreli olarak saklanıyor.
   - Token, admin iptal edene veya `tokenduration` süresi dolana kadar geçerli kalıyor (Moodle
     varsayılanı yaklaşık 12 hafta, sitenin ayarı bilinmiyor). Süre dolunca sistem Gmail ile haber veriyor.
   - İsteğe bağlı (`--remember-credentials`): kimlik bilgileri şifreli saklanır ve token süresi
     dolunca otomatik yenilenir. Varsayılan olarak **kapalı**. Güvenlik takası `docs/07-guvenlik.md` dosyasında anlatılıyor.
2. **Yedek yöntem: tarayıcı oturumu (Playwright) + `lib/ajax/service.php?sesskey=...`.** Oturum
   8 saat boşta kalınca bitiyor. Saatlik kontrol oturumu canlı tutar. Yalnızca `ajax=true` işaretli
   fonksiyonlar çağrılabiliyor, hangilerinin çalıştığı oturumlu keşifte ölçülecek.
3. MFA ve CAPTCHA olmadığı için ilk girişin otomasyonu kolay. Yine de giriş her zaman kullanıcı
   tarafından yapılıyor.
4. `launch.php` kapalı olduğu için "tarayıcıda giriş yap → token al" yolu **bu sitede çalışmaz**.
   Kod bunu tahmin etmiyor, doğrulanan duruma göre tasarlandı.

## 3. Oturum gerektiren ve henüz DOĞRULANMAMIŞ konular

Aşağıdakiler Moodle'ın belgelenmiş API'sine göre kodlandı. Ancak **bu sitede hangi fonksiyonların
mobil servise açık olduğu** ancak giriş yapılınca `core_webservice_get_site_info` → `functions`
listesinden okunabilir. Adaptör bu listeye göre kendini ayarlıyor: listede olmayan fonksiyonu çağırmıyor.

| Özellik | Kullanılacak WS fonksiyonu | Durum |
|---|---|---|
| Ders listesi | `core_enrol_get_users_courses`, `core_course_get_enrolled_courses_by_timeline_classification` | doğrulanacak |
| Haftalık/konu bölümleri, etkinlikler, dosyalar | `core_course_get_contents` | doğrulanacak |
| Duyurular | `mod_forum_get_forums_by_courses` + `mod_forum_get_forum_discussions` | doğrulanacak |
| Ödevler | `mod_assign_get_assignments` | doğrulanacak |
| Sınavlar (quiz) | `mod_quiz_get_quizzes_by_courses` | doğrulanacak |
| Takvim | `core_calendar_get_action_events_by_timesort`, `core_calendar_get_calendar_events` | doğrulanacak |
| Notlar | `gradereport_user_get_grade_items` | doğrulanacak |
| Bildirimler | `message_popup_get_popup_notifications` | doğrulanacak (varsayılan kapalı) |
| Devamsızlık | `mod_attendance_*` (eklenti kuruluysa) | doğrulanacak; büyük olasılıkla ÜBYS'de |
| Yapay zekâ / planlama araçları | `core_ai_*`, `aiplacement_*`, `block_*` fonksiyon önekleri | keşif aracı raporlayacak |
| Dosya güncelleme mekanizması | Dosya başına `timemodified` + `filesize` (+ indirilince SHA-256) | doğrulanacak |
| Hata ve erişim kısıtları | `requireloginerror`, `nopermissions`, gizli etkinlikler (`uservisible=false`) | doğrulanacak |

## 4. Oturumlu keşfi tamamlama (kullanıcının 2 dakikası)

```bash
cd unitakip
.venv/bin/unitakip login sanal        # kullanıcı adı + gizli parola istemi
.venv/bin/unitakip discover sanal     # otomatik, salt-okunur keşif
```

Keşif aracı:
- yalnızca **okuma** fonksiyonlarını çağırır (kod içinde izin listesi var, yazma fonksiyonları engelli),
- ham yanıtları `data/discovery/` altına kaydeder (git dışı, kişisel veri içerir),
- anonimleştirilmiş özeti `docs/kesif/01b-sanal-ogrenme-oturumlu.md` dosyasına yazar
  (fonksiyon listesi, modül türleri, dosya uzantıları, sayılar). Ad, not ve mesaj içeriği bu özete girmez.

# Kurulum rehberi (tek seferlik, yaklaşık 20 dakika)

Bu belge yerel Python/Docker sürümünü anlatır. Cloudflare (bilgisayar kapalıyken çalışan) kurulum için
önce [README](../README.md) dosyasına bak. Tüm komutlar projeyi indirdiğin klasörden çalıştırılır
(ör. `cd ~/unitakip`).

## 1. Mac'te ortam

```bash
scripts/setup-mac.sh
```
Bu betik `.venv` sanal ortamını, bağımlılıkları ve Chromium'u (~150 MB) kurar, ardından `unitakip init` çalıştırır.
`init`, `config/config.yaml` ve şifreleme anahtarını içeren `.env` dosyasını oluşturur. `.env` dosyasını
yedekle ama git'e ekleme. `.gitignore` bunu zaten engelliyor.

`.env` içine bildirim adresini yaz:
```
UNITAKIP_NOTIFY_TO=ornek.ogrenci@gmail.com
```

## 2. Sitelere giriş (her biri bir kez)

`config/config.yaml` içinde kendi sitelerini tanımla veya hazır şablonu `enabled: true` yap. Sonra giriş
isteyen her site için:

```bash
.venv/bin/unitakip login <site-id>      # Moodle: kullanıcı adı + gizli parola istemi → resmi mobil uygulama token'ı
                                        # Web sitesi: tarayıcı açılır, girişi (SMS/e-Devlet dahil) sen yaparsın
```

Bartın Üniversitesi şablonu örneği: `login sanal` (Moodle tokenı), `login ogreniyorum` ("Beni Hatırla"yı
işaretle), `login ubys` (kullanıcı adı, parola, SMS kodu veya e-Devlet).
- Giriş algılanınca tarayıcı kendiliğinden kapanır. Algılanmazsa terminalde **Enter**'a bas, oturum o anki haliyle kaydedilir. `--manual` ile otomatik algılama tamamen kapanır.
- İsteğe bağlı otomatik yenileme (bkz. [07-guvenlik.md](07-guvenlik.md)): `login sanal --remember-credentials` ve config'te `auto_relogin: true`.

## 3. Gmail bildirimleri

İki yöntem desteklenir: Gmail API (yalnızca gönderim izni) veya Gmail SMTP (Google Cloud gerektirmez).

### Seçenek A — Gmail uygulama şifresi / SMTP

Kişisel Gmail hesabında 2 Adımlı Doğrulama açık olmalıdır. Hesap türüne veya Google'ın koruma
ayarlarına göre uygulama şifresi seçeneği bulunmayabilir.

1. <https://myaccount.google.com/apppasswords> sayfasını aç; gerekirse kimliğini doğrula.
2. Uygulama adına `UniTakip` yazıp **Oluştur** düğmesine kendin bas.
3. Şifreyi sohbete, kaynak koda veya `.env` dosyasına yapıştırma. Terminalde çalıştır:
   ```bash
   .venv/bin/unitakip smtp-auth
   ```
   Gönderen Gmail adresini gir (alıcıyla aynıysa Enter). Google'ın ürettiği 16 karakterli
   uygulama şifresini gizli isteme yapıştır. Boşlukları otomatik kaldırılır. Normal Gmail şifreni kullanma.
   Komut Google'a TLS üzerinden giriş yaparak doğrular; **e-posta göndermez**.
   Yalnızca başarılı girişten sonra `data/secrets/gmail.smtp.enc` içine şifreli kaydeder.
4. `config/config.yaml` içinde `notify` bölümündeki `provider` değerini `gmail_smtp` yap:
   ```yaml
   notify:
     provider: gmail_smtp
   ```
   Mevcut `notify` bölümünü düzenle; ikinci bir bölüm ekleme.
5. Gönderimi denemek istediğinde `.venv/bin/unitakip test-email` çalıştır.

Uygulama şifresi OAuth'taki `gmail.send` kapsamından daha geniş erişim verir; Google bu nedenle
desteklenen uygulamalarda OAuth kullanımını önerir. UniTakip SMTP'yi yalnızca e-posta göndermek için kullanır.
İstediğin zaman Google hesabından bu uygulama şifresini iptal edebilirsin. Hesap şifreni
değiştirdiğinde Google uygulama şifrelerini de iptal eder; yeniden `smtp-auth` gerekir.
Bu yöntemde isteğe bağlı Drive yüklemesi kullanılmaz; büyük dosyalar yerelde arşivlenir.

Kaynaklar: [Google uygulama şifreleri](https://support.google.com/accounts/answer/185833?hl=tr),
[Gmail SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp).

### Seçenek B — Gmail API / OAuth

Bu seçenek için `notify.provider: gmail_api` kullanılır.

1. <https://console.cloud.google.com/> → yeni proje (ör. `unitakip`).
2. **APIs & Services → Library → Gmail API → Enable.** Drive eki istiyorsan Google Drive API'yi de etkinleştir.
3. **OAuth consent screen:** User type **External**, uygulama adı `UniTakip`, kendi e-postan.
   Kapsam ekleme adımını atlayabilirsin (kod istiyor). **Test users** bölümüne kendi Gmail adresini ekle.
4. **Credentials → Create credentials → OAuth client ID → Desktop app** → JSON'u indir.
5. **Önemli:** OAuth consent screen → **Publish app** ile durumu "In production" yap. Aksi halde token 7 günde düşer.
6. Yetkilendir ve dene:
   ```bash
   .venv/bin/unitakip gmail-auth --client-secret ~/Downloads/client_secret_XXXX.json   # Drive için: --drive
   .venv/bin/unitakip test-email
   ```
   Tarayıcıda "Google bu uygulamayı doğrulamadı" uyarısı çıkarsa **Gelişmiş → UniTakip'e git** de.
   Uygulamanın sahibi sensin. Onaydan sonra indirdiğin JSON dosyasını silebilirsin.

## 4. Oturumlu keşif (Faz 1'in tamamlanması)

```bash
.venv/bin/unitakip discover sanal
.venv/bin/unitakip discover ogreniyorum --apply
.venv/bin/unitakip discover ubys --apply
```
- Özetler `docs/kesif/` altına yazılır (anonim). Ham veri `data/discovery/` altına gider (kişisel, git dışı).
- `--apply`, izlenecek sayfa önerilerini `config/<platform>.pages.yaml` dosyasına yazar. Gözden geçir, gereksizleri sil.
- ÜBYS oturumunun ne kadar yaşadığını ölçmek için (yaklaşık 2,5 saat sürer):
  `.venv/bin/unitakip probe-session ubys`. Sonuca göre config'te `keepalive_minutes` değerini ayarla.

<a id="ubys-sayfa-listesi"></a>

### ÜBYS not sayfası keşifte çıkmadıysa

ÜBYS’ye normal tarayıcından giriş yap. Geçerli dönemin **Ders İşlemlerim** veya not sayfasını aç ve adres çubuğundaki okul adresini kopyala. Yerelde `config/ubys.pages.yaml` dosyasını oluştur veya mevcut listenin sonuna aşağıdaki kaydı ekle. `url` alanındaki metni kopyaladığın tam HTTPS adresiyle değiştir. Bu dosya kişisel bağlantılar içerebilir ve Git dışında tutulur.

```yaml
- id: donem-notlari
  url: "BURAYA_UBYS_NOT_SAYFASININ_TAM_HTTPS_ADRESINI_YAPISTIR"
  kind: grade
  track_text: false
  track_links: false
  track_tables: true
```

Sayfa başka tablolar da içeriyorsa kayda `content_selector` ekleyerek not tablosunu seç. Ders materyalleri ve ödevler için her dersin kendi detay adresini ayrı bir kayıt olarak ekleyip `kind: course_materials` kullan. Her kayda farklı bir `id` ver. Sayfayı açtığında adres sabit kalıyorsa ana sayfayı not sayfası olarak kaydetme. Okulun doğrudan açılabilen ders veya not bağlantısına ihtiyacın var. Son olarak [paketi yeniden hazırlayıp Cloudflare’a yükle](../README.md#ubys-sayfalari).

## 5. Deneme ve çalıştırma

```bash
.venv/bin/unitakip run-once --dry-run     # veritabanının geçici kopyasında çalışır: gerçek durum DEĞİŞMEZ,
                                          # e-posta yerine data/outbox/*.eml üretir (istediğin kadar çalıştır)
.venv/bin/unitakip run-once               # gerçek: ilk çalıştırma baseline'dır, e-posta göndermez
.venv/bin/unitakip status
.venv/bin/unitakip daemon                 # Mac açıkken 7/24 döngü (Ctrl+C ile durur)
```

## 6. Mac kapalıyken: sunucu

[06-dagitim-vps.md](06-dagitim-vps.md):
```bash
scripts/push-session.sh kullanici@sunucu unitakip --with-env   # önce anahtar + oturumlar
scripts/deploy-vps.sh kullanici@sunucu                          # sonra kod + konteyner
```

## 7. "Yeniden giriş gerekli" e-postası gelince

```bash
.venv/bin/unitakip login <platform>
scripts/push-session.sh kullanici@sunucu     # sunucu kullanıyorsan
```
Diğer platformlar bu sırada çalışmaya devam eder.

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| `UNITAKIP_MASTER_KEY tanımlı değil` | `unitakip init` çalıştır veya `.env` dosyasını sunucuya kopyala (`--with-env`) |
| `Şifreli veri çözülemedi` | Mac ile sunucudaki `.env` anahtarları farklı. Aynı `.env` kullan |
| Gmail `invalid_grant` | OAuth uygulaması "Testing" modunda (7 gün). Publish et, sonra `gmail-auth` çalıştır |
| ÜBYS her kontrolde "oturum düştü" | Oturum IP'ye bağlı ya da kısa ömürlü olabilir. `probe-session` ile ölç, `keepalive_minutes` ayarla. Sorun sürerse sunucuyu ev ağına taşı |
| Sanal Öğrenme `accessexception` | Token süresi dolmuş: `unitakip login sanal` (`--remember-credentials` + `auto_relogin: true` ise otomatik yenilenir) |
| ÜBYS / Öğreniyorum'dan her saat "sayfa değişti" e-postası | Sayfada değişen bir sayaç/saat satırı var: `config/<platform>.pages.yaml` içinde ilgili sayfaya `ignore_patterns: ['^Sayaç:']` ekle |
| Tablo satırları "yeni" diye bildiriliyor | Satır kimliği yanlış sütundan seçilmiş: sayfaya `key_columns: [0]` (kimlik sütununun sırası) ekle |

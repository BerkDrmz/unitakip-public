# Panel kullanımı

## Site ekleme

**Siteler → Site ekle** bölümünde site adresini yapıştır ve **Ekle**’ye bas. UniTakip bilinen adreslerde uygun şablonu seçer. Herkese açık sitelerde aynı alan adında duyuru arşivi veya duyuru RSS/Atom akışı arar. Tanınan arşivlerde her duyuru ayrı kaydedilir. Yapı tanınamazsa eklenen adres genel sayfa olarak izlenir. Bağlantı testi otomatik çalışır ve kartta nelerin okunabildiğini gösterir.

**İsteğe bağlı ayarlar** bölümünde adı, bağlantı türünü ve izlenecek sayfaları düzenleyebilirsin. Sayfa adresleri aynı alan adında olmalı. İlk tam tarama mevcut içeriği kaydeder ve bildirimler sonraki değişikliklerle başlar. Site giriş istiyorsa karttaki [oturum yenileme](#oturum-yenileme) adımlarını izle.

Yerel yapılandırmadan da site ekleyebilirsin. `config/config.yaml` dosyasındaki `platforms` bölümüne siteyi tanımla, gerekiyorsa `.venv/bin/unitakip login <site-id>` ile giriş yap ve bulut paketini yeniden yükle. Pakette yer alan yeni siteler panele eklenir. Panelden kaldırdığın bir site kendiliğinden geri eklenmez.

## Bağlantı testi

**Bağlantıyı test et** siteyi Cloudflare'dan bir kez okur. Kayıtlara hiçbir şey eklemez ve e-posta göndermez.
Sonuçta okunan öğe sayısı, türlere göre dağılım ve bulunan içerikten en fazla 8 örnek başlık görünür. Hata varsa
nedeni yazılır:

| Mesaj | Anlamı |
|---|---|
| Siteye ulaşılamadı | Adres yanlış, site kapalı ya da yalnızca okul ağından açılıyor |
| Giriş gerekiyor | Oturum/token yok veya süresi dolmuş → oturumu yenile |
| Sayfa yapısı tanınmadı | Sayfa okundu ama bu bağlantı türü içeriği anlamadı → uyarlama gerekebilir |
| Başka bir alan adına yönlendiriyor | Giriş ayrı bir alan adında (ör. merkezi giriş); güvenlik için okunmaz |
| Kısmen okundu / Süre doldu / Bakımda | Bazı bölümler alınamadı; biraz sonra yeniden dene |

## Oturum yenileme

Giriş isteyen bir sitenin oturumu dolduğunda e-posta gelir ve panelde **Giriş gerekli** görünür. **Siteler → ilgili site → Panelden yeniden bağlan** yolunu aç. Desteklenen sitelerde site şifren ve gerekiyorsa SMS kodunla telefondan veya bilgisayardan bağlanabilirsin. Tarayıcıda doğrulama isteyen siteler için karttaki komutu kurulum yaptığın bilgisayarda proje klasöründen çalıştır. [ÜBYS için kopyalanabilir e-Devlet komutu](../README.md#e-devlet-terminal)

```bash
python3 cloud/cloudflare/refresh-session.py <site-id>
# Panelde eklenen ve yerelde tanımı olmayan bir site için kart şu biçimi gösterir:
python3 cloud/cloudflare/refresh-session.py bolum-duyurulari --type webpages --url https://obs.ornek-universite.edu.tr/duyurular
```

Komut sırasıyla:

1. Site yerelde tanımlı değilse tanımı Git dışındaki `config/sites.local.yaml` dosyasına yazar (kendi
   `config.yaml` dosyan değişmez).
2. Girişi başlatır. Web sitelerinde tarayıcı açılır ve girişi **sen** yaparsın (SMS, e-Devlet dahil).
   Moodle'da resmi mobil uygulama token yöntemi kullanılır: kullanıcı adı ve şifre yalnızca kendi
   terminalinde istenir, şifre saklanmaz. Okulun Moodle'ı ayrı bir merkezi giriş (SSO) kullanıyorsa bu
   yöntem çalışmayabilir.
3. Yerel paketi yeniler ve Cloudflare'a yüklemeden önce **onay ister**.

Sonra panelde **Bağlantıyı test et** ile doğrula. Oturumların ömrü siteye bağlıdır; “Beni hatırla” bile kesintisiz
oturum garantisi değildir.

## Çalışmayan siteler için: Claude / Codex ile uyarlama

Bir site mevcut bağlantılarla okunamıyorsa veya istediğin özellik desteklenmiyorsa, kartta
**Claude / Codex ile uyarlama** bölümü bir yardım promptu hazırlar. **Promptu kopyala** ile al, projeyi
bilgisayarında Claude Code veya Codex ile aç ve yapıştır. Prompt yalnızca site adını, herkese açık adresi
(sorgu parametreleri olmadan), bağlantı türünü, istenen özellikleri ve hata türünün genel açıklamasını içerir.
Şifre, token, çerez, e-posta, kişisel not veya sorgu parametresi **eklenmez**.

Örnek (genel bir site için):

```text
UniTakip projesinde "Öğrenci Bilgi Sistemi" sitesi için takip desteği geliştirmeni istiyorum. Proje bu klasörde açık.

## Site
- Ad: Öğrenci Bilgi Sistemi
- Herkese açık adres: https://obs.ornek-universite.edu.tr/
- Bağlantı türü: Genel web sayfası (HTTP ile sayfa okuma)
- İstenen takip: Sınav, Not
- Şu anki durum: Sayfa yapısı tanınmadı; mevcut adaptör bu siteyi okuyamıyor (desteklenmeyen yapı).
- Şu an desteklenmeyen istekler: Sınav, Not

## Projede bakılacak yerler
- Site kaydı ve desteklenen özellikler: cloud/cloudflare/src/sites.js
- Genel web sayfası adaptörü: cloud/cloudflare/src/core.js · Moodle: cloud/cloudflare/src/moodle.js
- Bağlantı testi: cloud/cloudflare/src/runtime.js (testSite)

## Yapmanı istediklerim
1. Önce mevcut Moodle ve genel web sayfası adaptörlerini yeniden kullan...
2. Girişi ben kendi tarayıcımda yapacağım; benden şifre, token veya çerez isteme...
3. CAPTCHA, SMS veya e-Devlet doğrulamasını aşmaya çalışma; yalnızca okuma yap...
(… kişisel veri içermeyen örnek HTML ile test yaz, npm test çalıştır, dağıtımdan önce bana sor …)
```

Uyarlamayı test ettikten sonra kendi hesabına `npm run deploy` ile yüklersin. Projeyi GitHub'a gönderirken gizli
dosyaların eklenmediğinden emin ol (aşağıda).

## Güvenlik ve gizli dosyalar

| Ne | Nerede | Git |
|---|---|---|
| Şifreleme anahtarı | `.env` | dışında |
| Yapılandırma, yerel site tanımları, keşif sayfaları | `config/config.yaml`, `config/*.local.yaml`, `config/*.pages.yaml` | dışında |
| Oturumlar, tokenlar, Gmail uygulama şifresi (şifreli) | `data/secrets/` | dışında |
| Bulut paketi ve yönetim anahtarı | `data/cloudflare/` | dışında |
| Bulutta | Cloudflare Secrets + AES-GCM ile şifreli Durable Object durumu | — |

GitHub'a göndermeden önce kontrol et:

```bash
git check-ignore -v .env config/config.yaml config/sites.local.yaml data/secrets data/cloudflare/secrets.json
git status --short
```

Panel giriş kodu yalnızca yapılandırılmış adrese gider; panel API'si token, çerez veya SMTP şifresi döndürmez.
Okul şifren panele girilmez ve buluta gönderilmez.

## Sınırlar

- Bulutta tarayıcı yoktur: JavaScript ile yüklenen sayfalar, yalnızca okul ağından açılan siteler ve girişi başka bir
  alan adında yapan siteler (ör. merkezi giriş) bulutta okunamaz.
- En fazla 12 site, site başına 10 sayfa. Dosya indirme sınırı 20 MB, arşiv sınırı 400 MB, e-posta ekleri 15 MB.
- Cloudflare Workers Free kotası aşılırsa kontroller hata verir; hesap ücretsiz planda tutulmalıdır.
- Hazır Bartın şablonları dışındaki üniversitelerin siteleri bu projede gerçek hesapla denenmedi. Bir sitenin
  çalıştığını görmek için mutlaka bağlantı testini kullan.

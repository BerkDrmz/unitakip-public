# UniTakip

**Üniversite ders sitelerindeki ödevleri, sınavları, notları ve duyuruları tek panelden takip et.**

UniTakip; farklı okul sistemlerindeki yaklaşan teslimleri, açıklanan notları, yeni dosyaları ve duyuruları düzenli aralıklarla kontrol eder. Değişiklik olduğunda Gmail üzerinden haber verir. Panel telefonda ve bilgisayarda çalışır; Cloudflare üzerinde yayımlandığı için kendi bilgisayarın kapalıyken de takip devam eder.

> [!IMPORTANT]
> Bu depo bir SaaS hizmeti değil, kendi hesabına kurduğun kişisel bir takip sistemidir. Okul ve Gmail bilgilerin geliştiriciyle paylaşılmaz; oturumları ve anahtarları kendi bilgisayarında ve kendi Cloudflare hesabında yönetirsin.

[Özellikler](#özellikler) · [Hızlı demo](#hızlı-demo) · [Cloudflare kurulumu](#cloudflare-kurulumu) · [Oturum yenileme](#yeniden-giris) · [Destek](#destek)

## Özellikler

- Yaklaşan ödevleri ve sınavları teslim tarihine göre tek ekranda toplar.
- Yeni açıklanan notları, eklenen dosyaları ve duyuruları algılar.
- Gmail ile değişiklik ve yeniden giriş bildirimi gönderir.
- Eklenen adresi otomatik test eder. Herkese açık sitelerde duyuru arşivini veya RSS/Atom akışını arar.
- Bir sitenin oturumu kapanınca diğer etkin siteleri izlemeye devam eder.
- Açık/koyu tema ve telefon uyumlu web paneli içerir.

| Kaynak | Takip edilenler | Giriş yenileme |
| --- | --- | --- |
| **Sanal Öğrenme** | Ödevler, sınavlar, notlar, dosyalar ve duyurular | Kullanıcı adı/şifre veya kayıtlı oturum |
| **Öğreniyorum.net** | Ders etkinlikleri ve teslimler | Kullanıcı adı/şifre veya kayıtlı oturum |
| **Bartın BTBS ve Fen Fakültesi** | Arşivdeki duyuruların başlığı, tarihi ve bağlantısı | Giriş gerekmez |
| **Google Classroom** | Etkin öğrenci derslerinin ödevleri ve duyuruları | [Apps Script kurulumu](docs/google-classroom.md#otomatik-kurulum) · [Ortak Google bağlantısı pilotu](docs/google-classroom.md#ortak-google-bağlantısı) |
| **ÜBYS** | Tanımlanan ders ve not sayfaları | ÜBYS kullanıcı adı ve şifresiyle panelden, yalnızca e-Devlet kullanıyorsan kurulum bilgisayarından. [Yeniden giriş adımları](#yeniden-giris) |

Bu sürüm, kendi derslerimi takip etmek için kullandığım UniTakip sisteminin herkese açık kopyasıdır. Kurulumda paneli kendi Cloudflare hesabında yayımlar, bildirimler için kendi Gmail hesabını bağlar ve izleyeceğin okul sitelerine kendi hesabınla giriş yaparsın.

## Ekran görüntüleri

Örnek verilerle çalışan panelin **Bugün** ekranı yaklaşan teslimleri ve yeniden giriş isteyen siteleri gösterir.

![Bugün ekranında takip özeti ve yaklaşan teslimler](docs/gorseller/bugun.png)

| Teslimler | Notlar |
| --- | --- |
| [![Teslim tarihlerine göre ödev listesi](docs/gorseller/teslimler.png)](docs/gorseller/teslimler.png) | [![Derslere göre sınav sonuçları](docs/gorseller/notlar.png)](docs/gorseller/notlar.png) |

## Hızlı demo

Önce arayüzü örnek verilerle yerel olarak deneyebilirsin. Bu demo okul hesaplarına bağlanmaz ve gerçek bildirim göndermez.

**Gereksinimler:** Git ve Node.js 24 (npm dahil). Komutlar macOS, Linux ve Windows üzerinde WSL içindir.

```sh
git clone https://github.com/BerkDrmz/unitakip-public.git unitakip
cd unitakip
npm ci --prefix cloud/cloudflare
npm ci --prefix cloud/cloudflare/ui
UNITAKIP_UI_DEMO=1 UNITAKIP_UI_DEMO_RICH=1 npm --prefix cloud/cloudflare/ui run dev
```

[Demo panelini aç](http://127.0.0.1:5174), **Giriş kodu gönder** düğmesine bas ve `123456` kodunu gir. Kapatmak için terminalde **Ctrl+C** tuşlarına bas.

<a id="cloudflare-kurulumu"></a>

## Cloudflare kurulumu ve arka plan takibi

Kurulum için bir Cloudflare hesabı ve bildirim gönderecek bir Gmail hesabı gerekir. Aşağıdaki komutları **kendi bilgisayarının terminalinde** çalıştır. Kurulum tamamlanınca panel Cloudflare Workers üzerinde açılır. Takip kayıtlarını aynı hesaptaki SQLite tabanlı Durable Object saklar. Zamanlanmış kontrolleri Cloudflare çalıştırır. Terminali kapatabilir, günlük kullanımda paneli telefonundan açabilirsin.

**1. Yerel kurulumu hazırla.** Yukarıdaki indirme ve iki `npm ci` adımını tamamla. Proje klasöründe `python3 --version` çalıştır. Çıktı en az 3.12 olmalı. Mac’te 3.9 görünüyorsa Python 3.13 kurup aşağıdaki ilk satırda `python3.13 -m venv .venv` kullan. [Python indirmeleri](https://www.python.org/downloads/)

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m playwright install chromium
.venv/bin/unitakip init
```

Linux veya WSL’de Chromium açılırken sistem kütüphanelerinin eksik olduğu yazarsa `.venv/bin/python -m playwright install --with-deps chromium` çalıştır. [Playwright tarayıcı kurulumu](https://playwright.dev/python/docs/browsers)

**2. Gmail’i bağla.** Oluşan `config/config.yaml` dosyasının mevcut `notify` bölümünde `provider` değerini `gmail_smtp`, `to` değerini bildirimleri ve panel giriş kodunu alacağın e-posta adresi yap. Gönderen kişisel Gmail hesabında iki adımlı doğrulamayı açıp 16 karakterlik bir [uygulama şifresi oluştur](https://myaccount.google.com/apppasswords). İlk komut gönderen Gmail adresini ve bu şifreyi sorar. Gönderen ile alıcı aynıysa adres sorusunda Enter’a bas. Şifreyi yazarken karakterler görünmez. İkincisi yerel kurulum paketini hazırlar.

```sh
.venv/bin/unitakip smtp-auth
.venv/bin/python cloud/cloudflare/prepare.py
```

**3. Paneli yayınla.** Cloudflare hesabında **Workers & Pages** sayfasını aç. İlk kurulumunsa hesabın için bir `workers.dev` alt alanı seç. [Cloudflare’ın alt alan kurulum rehberi](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) E-postadaki bağlantıların kendi panelini açması için [Worker ayarlarında](cloud/cloudflare/wrangler.jsonc) `PANEL_URL` değerini `https://unitakip.<alt-alan-adın>.workers.dev` biçimindeki kendi adresinle değiştir. Sonuna `/` ekleme. Aşağıdaki komutlarla aynı hesaba giriş yapıp paneli ve ayarlarını yükle.

```sh
cd cloud/cloudflare
npx wrangler login
npx wrangler whoami
```

Tarayıcıdaki Cloudflare iznini onayla. `whoami` çıktısında kullanmak istediğin hesabı görünce aynı terminalde devam et. Dağıtım sonunda yazan panel adresini kaydet.

```sh
npm run deploy
npx wrangler secret bulk ../../data/cloudflare/secrets.json
cd ../..
```

**4. Takibi başlat.** İlk komut adresi sorduğunda dağıtım çıktısındaki kendi HTTPS panel adresini yapıştır. Gmail bağlantı testi başarılı olunca aynı adres sonraki komutlar için kaydedilir.

```sh
printf 'Panel adresin: '
read -r panel_adresi
node cloud/cloudflare/manage.mjs smtp-check "$panel_adresi" &&
  node cloud/cloudflare/manage.mjs start &&
  node cloud/cloudflare/manage.mjs status
```

`status` çıktısında `"armed":true` takibin başladığını gösterir. Bu aşamada sıfır site görünmesi normaldir. `smtp-check` Gmail oturumunu sınar. İlk gerçek e-posta teslimini sonraki adımda panel kodunun gelen kutuna ulaşmasıyla doğrularsın.

**5. İlk siteyi ekle ve doğrula.** Dağıtım çıktısındaki panel adresini telefonunda veya bilgisayarında aç. **Giriş kodu gönder** ile Gmail’e gelen kodu gir. **Siteler → Site ekle** bölümüne adresi yapıştır ve **Ekle**’ye bas. UniTakip bağlantıyı otomatik test eder ve bulduklarını kartta gösterir. Aynı alan adında tanınan bir duyuru arşivi veya duyuru akışı bulursa duyuruları ayrı ayrı izler. Genel sayfa takibi devreye girerse kart bunu belirtir. Giriş isteyen bir site için aşağıdaki yeniden bağlanma adımlarını izle. ÜBYS şablonu ilk kurulumda yalnızca ana adresi bilir. Notların ve derslerin için aşağıdaki [ÜBYS sayfalarını tanıtma](#ubys-sayfalari) adımını da tamamla. İlk tam kontrol mevcut kayıtları toplar. Sonraki değişiklikler bildirim üretir.

`.env`, yerel `config/` dosyaların ve `data/` klasörünü güvenli bir yerde yedekle. Bu dosyalar kişisel anahtarlar ve oturum bilgileri içerir. Git bunları dışarıda tutar.

<a id="ubys-sayfalari"></a>

### ÜBYS’de ilk kez hangi sayfalar izlenecek?

Önce aşağıdaki **e-Devlet ile yeniden giriş** adımlarıyla kurulum bilgisayarında ÜBYS oturumunu aç. Ardından proje klasöründe şu komutu **ilk kurulumda** çalıştır. Bu komut sayfa önerilerini yazar. Önceden elle düzenlediğin bir `config/ubys.pages.yaml` varsa önce yedeğini al.

```sh
.venv/bin/unitakip discover ubys --apply
```

`config/ubys.pages.yaml` dosyasını aç. Kendi döneminin not veya ders sayfaları listelenmiş mi kontrol et. Dosya oluşmadıysa ya da yalnızca ana sayfa görünüyorsa [sayfaları elle ekleme adımını](docs/08-kurulum.md#ubys-sayfa-listesi) uygula. Sonra güncel listeyi kendi Worker’ına aktar.

```sh
.venv/bin/python cloud/cloudflare/prepare.py
(cd cloud/cloudflare && npx wrangler secret bulk ../../data/cloudflare/secrets.json)
```

**Siteler → ÜBYS → Bağlantıyı test et** sonucunda beklediğin içerikten bir örnek ara. Ardından **Bugün → Şimdi kontrol et** ile kayıtları panele getir. Sonraki oturum yenilemelerinde aynı sayfaları yeniden tanıtman gerekmez.

### Cloudflare’ın çalıştığını nasıl kontrol ederim?

UniTakip’te **Siteler** sayfasını aç. Bir sitenin kartındaki **Son başarılı kontrol** zamanı, Cloudflare’ın o siteyi en son ne zaman okuyabildiğini gösterir. Varsayılan tam tarama aralığı 60 dakikadır. Arada 10 dakikalık arka plan kontrolleri ve bunların ortasında yalnızca ÜBYS oturumu için ek bir yoklama vardır. Bu yoklama, okulun süresini doldurduğu oturumu yeniden açamaz.

Cloudflare tarafında **Workers & Pages → unitakip → Settings → Trigger Events → View events** yolundan zamanlanmış çalışmaları görebilirsin. İki zamanlama dağıtım sırasında proje ayarlarından kurulur. [Cloudflare zamanlanmış görevler rehberi](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

<a id="yeniden-giris"></a>

## Panelden veya okul sitesinden çıkış olursa

| Ekranda ne görüyorsun? | Ne yapmalısın? |
| --- | --- |
| **UniTakip giriş ekranı** | Kendi panel adresini aç, **Giriş kodu gönder** düğmesine bas ve Gmail’e gelen kodu gir. Bu işlem telefonda da bilgisayarda da çalışır. Panel oturumunun kapanması arka plan takibini durdurmaz. |
| **Bir okul sitesinde “Giriş gerekli”** | Gmail’deki yeniden bağlanma bağlantısını aç veya panelde **Siteler → ilgili site → Panelden yeniden bağlan** yolunu izle. Sitenin kendi kullanıcı adı ve şifresiyle giriş destekleniyorsa telefondan da bilgisayardan da **Bağlan**’a bas. Site SMS kodu isterse kodu gir ve **Doğrula**’ya bas. Eski bir uyarı seni **Bugün** ekranına getirirse **Siteler** kartına bak. Oturum arada düzelmişse yeni giriş gerekmez. Diğer etkin sitelerin takibi sürer. |
| **“Siteye ulaşılamadı” veya bakım uyarısı** | Biraz sonra **Bağlantıyı test et** ile tekrar dene. Site yeniden yanıt verdiğinde son başarılı kontrol zamanına bak. |

**ÜBYS’ye yalnızca e-Devlet ile giriyorsan** uyarıyı telefonda açabilirsin. Okul oturumunu Cloudflare’a aktarmak için UniTakip’i kurduğun bilgisayarı kullan.

1. **Siteler → ÜBYS → Panelden yeniden bağlan → Mac’te e-Devlet ile bağlan** bölümünden komutu **Kopyala**. Bilgisayarında UniTakip proje klasöründe bir terminal aç ve komutu çalıştır. Örneğin varsayılan kayıt için `.venv/bin/python cloud/cloudflare/refresh-session.py ubys` kullanılır. Karttaki komutta `--type` ve `--url` varsa onları da kopyala.
2. Açılan ÜBYS sayfasında **e-Devlet ile Giriş**’i seç. T.C. kimlik numaranı ve e-Devlet şifreni yalnızca resmî `giris.turkiye.gov.tr` ekranına gir. ÜBYS’ye döndüğünde giriş otomatik algılanmazsa terminalde **Enter**’a bas.
3. Terminal okul oturumunu kendi Cloudflare hesabına aktarmayı sorduğunda **e** yazıp **Enter**’a bas. **Oturum aktarıldı** mesajından sonra telefondan da devam edebilirsin.
4. **Siteler → ÜBYS → Bağlantıyı test et** ile erişimi doğrula. Yeni kayıtları hemen taramak istersen **Bugün → Şimdi kontrol et**’e bas. Tur tamamlanınca ÜBYS kartında **Son başarılı kontrol** zamanını kontrol et.

[Site ekleme ve oturum yenileme](docs/panel-kullanimi.md) · [ÜBYS sayfalarını keşfetme ve yerel kurulum](docs/08-kurulum.md) · [Cloudflare çalışma düzeni ve testler](cloud/cloudflare/README.md) · [Docker ile kurulum](docs/06-dagitim-vps.md)

## Destek

Kurarken veya kullanırken bir sorunla karşılaşırsan GitHub Issues üzerinden bana yazabilirsin. Hangi adımda takıldığını, ne olmasını beklediğini ve gördüğün hata mesajını belirtmen yeterli. Buraya yazdıkların herkese açık olduğu için ekran görüntülerindeki kişisel bilgileri gizle. Şifreni, giriş kodunu veya oturum bilgilerini paylaşma.

[Mevcut sorunlara bak](https://github.com/BerkDrmz/unitakip-public/issues) · [Yeni sorun bildir](https://github.com/BerkDrmz/unitakip-public/issues/new)

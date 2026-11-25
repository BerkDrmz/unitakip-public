# Google Classroom bağlantısı

UniTakip Classroom’daki etkin öğrenci derslerini, yayınlanmış ödevleri ve duyuruları izler. İlk aktarım mevcut kayıtları kaydeder. Sonraki değişikliklerin bildirimi UniTakip’teki Gmail ayarlarınla gönderilir. İlk kez kuruyorsan [otomatik kurulumdan](#otomatik-kurulum) başla.

<a id="otomatik-kurulum"></a>

## Windows, macOS ve Linux’ta otomatik kurulum

1. [Cloudflare kurulumunu](../README.md#cloudflare-kurulumu) tamamla. `smtp-check` komutunun başarılı olduğunu ve `status` çıktısında `"armed":true` yazdığını doğrula. Classroom komutu, `smtp-check` sırasında kaydedilen Worker adresini kullanır.
2. Proje klasöründe aşağıdaki komutu çalıştır. Cloudflare kurulumunu Windows’ta WSL ile yaptıysan aynı WSL terminalini kullan.

   ```sh
   npm --prefix cloud/cloudflare run classroom:setup
   ```

3. Açılan Google ekranında derslerini gördüğün hesabı seç. İlk kurulumda **clasp – The Apps Script CLI** izni istenebilir. Bu izin, komutun hesabında özel Apps Script projesini oluşturmasını sağlar. Ardından **UniTakip Classroom** ekranında Classroom erişimine izin ver. Tarayıcı açılmazsa terminalde gösterilen Google bağlantısını aç.
4. Google sayfasında **İlk Classroom aktarımı tamamlandı** mesajını gördüğünde paneline dön. **Siteler → Google Classroom** kartındaki **Son Apps Script aktarımı** zamanını ve **Teslimler** bölümündeki ödevlerini kontrol et. Sonraki aktarımlar yaklaşık 10 dakikada bir çalışır.

Bu akış ayrı bir Cloudflare test panelinde gerçek Google hesabıyla doğrulandı. İzinlerden sonra ilk ödevler otomatik olarak panele geldi.

### Kurulumda bir adım takılırsa

- **Cloudflare kurulumu eksik** uyarısında rehberdeki `smtp-check` adımını kendi panel adresinle tamamla.
- **Google projeyi oluşturamadı** uyarısında derslerini gördüğün Google hesabında **Google Apps Script API** ayarını aç ve komutu yeniden çalıştır. Okul yöneticisi erişimi kısıtlıyorsa okulun izni gerekir. [Apps Script API ayarı](https://script.google.com/home/usersettings) · [Google’ın clasp kurulum rehberi](https://developers.google.com/apps-script/guides/clasp)
- Komut **Apps Script düzenleyicisini** açtıysa **startUniTakip → Çalıştır**’ı seçip Google izin ekranını tamamla. Bu, otomatik kurulum sayfası açılamadığında kullanılan yedek yoldur.

Yerel kurulum dosyaları `data/cloudflare/classroom-script/` altında, Git dışında tutulur. Bir hata sonrası aynı komut mevcut projeyle devam eder. Bağlantıyı bilinçli olarak değiştirmek için komutun sonuna `-- --replace` ekle. Bu, eski aktarım anahtarını iptal eder.

## Apps Script’i tarayıcıdan kurma

Bu yöntemde Google Apps Script, Classroom hizmeti için kendi varsayılan projesini kullanır. Okul yöneticisinin Apps Script veya Classroom API erişimini kısıtladığı hesaplarda bu yol engellenebilir. [Apps Script’in varsayılan projesi](https://developers.google.com/apps-script/guides/services/advanced#enable_advanced_services)

1. UniTakip’te takibin açık olduğunu kontrol et. **Siteler → Site ekle** bölümüne `classroom.google.com` yaz. Mevcut bir Classroom kaydın varsa onu kullan.
2. Classroom kartında **Apps Script ile bağlan → Tarayıcıdan elle kur** düğmesine bas. Bu ekran, sana özel kodu ve manifest dosyasını ayrı ayrı kopyalamanı sağlar.
3. Classroom derslerini gördüğün Google hesabıyla bir Apps Script projesi aç. **Proje Ayarları** bölümünden `appsscript.json` dosyasını düzenleyicide göstermeyi seç. UniTakip’in hazırladığı metinleri `appsscript.json` ve `Code.gs` dosyalarına yapıştırıp kaydet. [Apps Script ana sayfası](https://script.google.com/home)
4. Düzenleyicide **startUniTakip** işlevini seçip **Çalıştır**’a bas. Google’da Classroom erişimine izin ver. İlk aktarım başarılı olunca **Son Apps Script aktarımı** zamanı ve okunan kayıtlar Classroom kartında görünür. Script sonraki aktarımları yaklaşık 10 dakikada bir yapar. [Apps Script zamanlayıcıları](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers)

Aktarım anahtarı `Code.gs` dosyasında yer alır. Projeyi özel tut. İlk aktarım gelmezse Apps Script’te **Yürütmeler** bölümündeki hata mesajına bak. Yeni kod hazırlamak önceki anahtarı geçersiz kılar. Sadece aktarımı yeniden denemek için mevcut projedeki **syncUniTakip** işlevini çalıştır. UniTakip bir aktarımda en fazla 80 etkin ders, 2.000 kayıt ve 1 MB veri alır.

## Google Cloud OAuth ile bağlantı

Kendi Google Cloud projesini kullananlar için alternatif yöntem. Kurulumdan sonra Classroom kartından **Google ile bağlan** düğmesini kullan.

1. Kendi Google Cloud projeni seç veya yeni bir proje oluştur. **Google Classroom API**’yi etkinleştir. [Google Classroom API](https://console.cloud.google.com/apis/library/classroom.googleapis.com)
2. **Google Auth Platform** bölümünde uygulamayı yapılandır. **Audience** altında uygulamanın hedef kitlesini seç. Harici uygulama test modundaysa Classroom hesabını **Test users** listesine ekle. Okul hesabında üçüncü taraf uygulamalar kısıtlıysa okul yöneticisinin bu OAuth uygulamasına izin vermesi gerekebilir. [Google OAuth ekranı kurulumu](https://developers.google.com/workspace/guides/configure-oauth-consent)
3. **Data Access** bölümüne `openid` ile aşağıdaki üç Classroom iznini ekle. `openid` bağlantının aynı Google hesabına ait olduğunu doğrular. Classroom izinleri salt okunurdur.

   - `https://www.googleapis.com/auth/classroom.courses.readonly`
   - `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
   - `https://www.googleapis.com/auth/classroom.announcements.readonly`

4. **Clients → Create client → Web application** yolunu izle. **Authorized redirect URIs** alanına kendi HTTPS panel adresinin sonuna `/oauth/classroom/callback` ekleyerek tam adresi yaz. Örneğin `https://panel.example.com/oauth/classroom/callback`. Tarayıcıda kullandığın panel adresi ile kayıtlı adres birebir eşleşmeli. [Google OAuth web uygulaması belgeleri](https://developers.google.com/identity/protocols/oauth2/web-server)
5. Google’ın verdiği istemci kimliğini ve istemci gizli anahtarını kendi Worker’ına ekle. Proje klasöründen aşağıdaki komutları çalıştır. Her komut ilgili değeri terminalde sorar.

   ```sh
   cd cloud/cloudflare
   npx wrangler whoami
   npx wrangler secret put CLASSROOM_CLIENT_ID
   npx wrangler secret put CLASSROOM_CLIENT_SECRET
   ```

   Bu değerleri GitHub’a, Issues’a veya sohbete koyma. Paneli yenileyip **Google ile bağlan**’ı aç.

<a id="baglanti-duserse"></a>

## Bağlantı düşerse

**Apps Script kullanıyorsan** kendi Apps Script projenin **Yürütmeler** bölümünü aç. Geçici bir hata varsa `syncUniTakip` işlevini bir kez çalıştır. Google yeniden izin isterse aynı Classroom hesabıyla onayla. Ardından panelde **Son Apps Script aktarımı** zamanının güncellendiğini kontrol et. Panel aktarım anahtarının geçersiz olduğunu bildirirse [otomatik kuruluma](#otomatik-kurulum) dön. Bağlantıyı bilinçli olarak yenilemek için komutun sonuna `-- --replace` ekle.

**Google Cloud OAuth kullanıyorsan** Classroom kartından **Google ile bağlan**’a bas ve aynı hesabı seç. Farklı bir hesap seçersen panel yeni hesabın verileriyle yeniden başlar. Google test modundaki harici uygulamalarda OAuth yenileme anahtarı genellikle yedi gün geçerlidir. [Google OAuth yenileme anahtarı süreleri](https://developers.google.com/identity/protocols/oauth2#expiration)

Classroom bağlantısını kaldırmak için UniTakip’teki site kartını silebilirsin. Google tarafındaki izni de kaldırmak istiyorsan Google hesabındaki bağlı uygulamalardan UniTakip’i kaldır. [Google Hesabı bağlantıları](https://myaccount.google.com/connections)

## Ortak Google bağlantısı

Ortak bağlantı pilot aşamasındadır. Herkese açık kurulumlarda şu anda aşağıdaki Apps Script yöntemi kullanılabilir.

Servis etkinleştirildiğinde, **Siteler → Site ekle** bölümüne `classroom.google.com` yaz. Classroom kartından **Google ile bağlan** düğmesine bas ve derslerini gördüğün Google hesabıyla okuma izni ver. Takip açıksa ilk aktarım otomatik başlar. Sonraki kontroller telefon veya bilgisayar kapalıyken de devam eder. Okul hesabı üçüncü taraf erişimini kısıtlıyorsa okul yöneticisinin izni gerekebilir.

### Ortak bağlantı servisinin yönetimi

Bu bölüm ortak servisi işleten kişi içindir. Öğrenciler Google istemcisi ya da Apps Script projesi kurmaz.

1. Ayrı bir Google Cloud projesinde Classroom API’yi aç. Google Auth Platform’da uygulamanın ana sayfası, gizlilik sayfası ve yetkili alan adını kaydet. Üretim doğrulaması için yönettiğin ve Google Search Console’da doğrulayabildiğin bir alan adı kullan. [Google alan adı doğrulaması](https://support.google.com/cloud/answer/13804266)
2. Aşağıdaki **Google Cloud OAuth ile bağlantı** bölümünde listelenen dört izni ekle. Bir web OAuth istemcisi oluştur ve yetkili dönüş adresi olarak ortak servisin HTTPS adresine `/oauth/classroom/callback` ekle. Örneğin `https://classroom.example.com/oauth/classroom/callback`.
3. `cloud/cloudflare/wrangler.classroom.jsonc` dosyasında `BROKER_ORIGIN` değerini ortak servisin adresiyle eşleştir. Ayrı Worker’ı `npx wrangler deploy --config wrangler.classroom.jsonc` ile dağıt. Aynı dosyayı `--config` ile belirterek `CLASSROOM_CLIENT_ID`, `CLASSROOM_CLIENT_SECRET` ve `BROKER_STATE_KEY` değerlerini Wrangler secret olarak ekle. `BROKER_STATE_KEY` için 32 baytlık, Base64 kodlanmış rastgele bir anahtar kullan. Anahtarı değiştirmek, önceki şifreli bağlantıların yeniden kurulmasını gerektirir.
4. Pilot Google projesine bir test kullanıcısı ekle. Ortak Worker’da `BROKER_MODE` değerini `enabled` yapıp ayrı Worker’ı tekrar dağıt. Test panelinin `CLASSROOM_BROKER_URL` değişkenine servis adresini ver. **Google ile bağlan**, ilk aktarım, sonraki kontrol ve siteyi silme akışlarını gerçek hesapla sınadıktan sonra üretim izinlerini doğrulamaya gönder. Herkese açık dağıtımda doğrulanmış servis adresi panelin varsayılanı olarak ayarlanır. [OAuth doğrulaması](https://support.google.com/cloud/answer/13463073)

Google erişim anahtarları ortak serviste şifreli tutulur. Panelin bağlantı anahtarı yalnız kendi Classroom kayıtlarını okumaya ve bağlantıyı kaldırmaya yetkilidir. Ortak Worker’da ödev ve duyuru içeriği kalıcı olarak saklanmaz. Classroom sitesini silmek panel kayıtlarını ve ortak bağlantıyı kaldırır. Google’da verdiğin izni de Google hesabından iptal edebilirsin. [Google Hesabı bağlantıları](https://myaccount.google.com/connections)

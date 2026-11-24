# UniTakip — Cloudflare ücretsiz çalışma sürümü

Bilgisayar kapalıyken çalışmak üzere sitelerin HTTP/API kontrollerini Workers + SQLite Durable Object
ortamında yürütür. Her kullanıcı kendi Cloudflare hesabına kurar; kurulumlar birbirinden bağımsızdır.
Yeni kullanıcı kurulumu için kök [README](../../README.md) dosyasına bak. Bu belge iç yapıyı anlatır.
`cloud/apps-script` ayrı, kullanılmayan bir denemedir.

## Kontrol paneli

Panel `https://unitakip.<alt-alan-adın>.workers.dev/` adresindedir. React/Vite arayüzü aynı Worker'ın
ücretsiz statik dosya hizmetinden sunulur.

- “Siteler” bölümünde site ekleme, düzenleme, bağlantı testi, duraklatma ve kaldırma yapılır. Her kartta
  duyuru/dosya/ödev/sınav/not için gerçek destek düzeyi (Tam / Kısmi / Yok), son test sonucu ve
  içerik önizlemesi, gerekirse oturum yenileme komutu ve “Claude / Codex ile uyarlama” promptu bulunur.
  Destek düzeyi içerik takibi ve bildirimi anlatır. ÜBYS ders adaptöründe duyuru, dosya ve ödev takibi
  tam desteklidir; dosyalar kaynak siteden açılır, otomatik arşivleme ve ödev teslim durumu takibi kapsam dışıdır.
  Öğreniyorum.net'te `iceriklistele` sayfaları eklenmişse PDF/konu listesi takibi; `odevler` sayfası
  eklenmişse ödev listesi takibi tam desteklidir. Ödevin ders, konu, başlık, açıklama ve teslim tarihi
  sütunları okunur; sıra numarası kimlik sayılmaz. Yeni ayrıştırıcıya geçiş sessiz yapılır. Dosyaların
  içeriği indirilip karşılaştırılmaz; aynı başlık altında sessizce değiştirilen PDF tespit garantisi yoktur.
- Bugün sayfasında siteler, takip edilen kayıtlar ve son tam kontrol görünür.
- Ödev ve sınav listesi ders adı, platform, tür ve tarihle filtrelenebilir. Ayrıntı
  penceresi kaynak platforma bağlantı verir; teslim edildi/edilmedi bilgisi varsaymaz.
- “Sınav ve notlar” bölümünde sınavlar, açıklanan/beklenen notlar ve ilgili gönderilmiş
  bildirimler ayrıdır. Ders toplamları not kayıtları olarak kalır; her not kaydı bir
  sınav sonucu gibi etiketlenmez. Mevcut Moodle quiz/takvim/not ve ÜBYS not kaynakları
  kullanılır. Üniversitenin izlenmeyen ayrı sınav takvimi sayfaları kapsama varsayılmaz.
- “Dosyalar” takip edilen sitelerin dosya ve ders bağlantılarını site/ders/dosya
  türüne göre filtreler. ÜBYS şablonunda derslerin `ClassDetail` sayfaları ayrıca izlenebilir.
  Dersin kendi kullandığı `_jsm` Base64 JSON modeli ayrıştırılır; içindeki JavaScript
  çalıştırılmaz. PDF kayıtları kaynak ders sayfasına, öğretmenin paylaştığı HTTPS
  bağlantıları ilgili kaynağa açılır. ÜBYS'nin `SaveDownloadLog` ve dosya indirme POST
  akışları otomatik tetiklenmez; ÜBYS dosyaları bu sürümde doğrudan arşivlenmez.
- Bildirim geçmişi başarılı e-posta gönderimlerinden tutulur; en son 200 kayıt saklanır.
  Önceki sürümden yalnızca gerçekten kayıtlı durum/bağlantı iletileri aktarılır; eski
  deneme e-postaları için geçmiş uydurulmaz.
- “Şimdi kontrol et” kalıcı alarm kurar; panel kapatılsa da kontrol devam eder.
  Elle kontrolde aynı sunucuya istek başlangıçları en az 1 saniye aralıklıdır; arka plan
  kontrollerinde 1,5 saniye korunur. Panel kontrol edilen siteyi ve tamamlanan site sayısını
  mevcut yoklamalarla gösterir. İlerleme için ek veritabanı yazımı veya yoklama sıklığı artışı yoktur.
- Moodle mobil servisi destekliyorsa içerik, not ve duyuru okumaları en çok dörderli resmî toplu
  isteklerle yapılır. Bütün kayıtlar her tam taramada yeniden okunur; taramalar arasında içerik önbelleği yoktur.
  Toplu uç nokta desteklenmiyorsa veya geçersiz yanıt verirse tekli okuma kullanılır. Bölüm hatasında
  sunucunun atladığı diğer okumalar tekli tamamlanır; oturum ve kota hataları üst kontrol akışına iletilir.
- Takip duraklatılıp sürdürülebilir; tam tarama aralığı 30/60/120 dakika seçilebilir.
  Cron'ın 10 dakikalık oturum/yeniden deneme ritmi korunur.
- Giriş kodu yalnızca yapılandırılmış sahibin e-postasına gönderilir. Kullanıcıdan
  rastgele bir alıcı adresi kabul edilmez. Kod 10 dakika/tek kullanım ve 5 yanlış
  denemeyle sınırlıdır; en fazla saatte 5 kod ve kodlar arasında 60 saniye bekleme vardır.
  Kodun kendisi depoda tutulmaz. Başarılı giriş 30 günlük imzalı HttpOnly/Secure/
  SameSite=Strict çerezi üretir; panel kullanıldıkça (en fazla günde bir) çerez yenilenir,
  30 gün hiç açılmayan cihazda oturum kapanır. Yazma istekleri aynı kaynak denetiminden geçer.
  Panele geçici olarak ulaşılamaması giriş ekranı göstermez; giriş yalnızca oturum gerçekten yoksa istenir.
- Panel API'si ayrı bir açık alan projeksiyonudur; token, oturum çerezi, anahtar,
  özel giriş formu veya SMTP şifresi tarayıcıya gönderilmez.

Arayüz geliştirme:

```sh
cd cloud/cloudflare
npm ci
npm --prefix ui ci
UNITAKIP_UI_DEMO=1 npm --prefix ui run dev
```

Yerel önizlemedeki `123456` kodu ve örnek veriler yalnızca Vite geliştirme sunucusunda
çalışır. Üretim paketine dahil edilmez. Gerçek Worker ile geliştirme için önce
`npm run build:ui`, sonra `npm run dev` kullanılır.

## Ücretsiz çalışma düzeni

- Worker'ın 10 dakikalık Cron tetikleyicisi tek bir Durable Object'i çağırır.
- Başlatmadan 30 saniye sonra bir defalık kalıcı alarm ilk arka plan kontrolünü çalıştırır.
- Tam tarama saatte bir; aradaki çalışmalarda web oturumlarının erişimi kontrol edilir,
  dosya kuyruğu ve e-posta tekrar denemeleri sürdürülür.
- HTML ayrıştırma ve takip SQLite Durable Object içinde gerçekleşir (belgelenen varsayılan
  CPU sınırı 30 saniye). Worker yalnızca yönlendirir.
- SQLite durum ve dosya içeriği ayrı bir AES-GCM anahtarıyla şifrelenir. Anahtar ve
  oturum paketi Cloudflare Secrets içinde tutulur. HTML veya notlar loglanmaz.
- Gmail `smtp.gmail.com:465` üzerinden TLS kullanır; ücretli gönderim sağlayıcısı gerekmez.
- Containers, R2, Browser Run, ücretli yapay zekâ veya Workers Paid kullanılmaz.

Güncel resmi sınırlar: [Durable Objects fiyatlandırması](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[çalışma sınırları](https://developers.cloudflare.com/durable-objects/platform/limits/).
Workers Free kotası aşılırsa işlemler hata verir. Hesap ücretsiz planda tutulmalıdır.
Kodun dosya arşivi sınırı 400 MB şifreli metin, dosya indirme sınırı 20 MB, e-posta ek sınırı
toplam 15 MB'dır. Büyük dosyalarda özgün site bağlantısı kullanılır.

## Doğrulama

```sh
cd cloud/cloudflare
npm ci
npm --prefix ui ci
npm test
npm run check
```

Testler: değişiklikler ve sessiz başlangıç; yarım veri; iç içe not tablosu ve satır sırası;
gönderim öncesi kalıcı kayıt; uzun SMTP kesintisi; cookie/host yalıtımı; HTTP boyut sınırı;
Moodle salt okunur işlevler ve bölüm yalıtımı; TLS SMTP ve MIME; AES-GCM doğrulaması;
gerçek yerel Worker + SQLite ortamında yeniden başlatma ve işlemin geri alınması. Panel için
OTP'nin ömrü/tek kullanımı, hız sınırları, imzalı oturum, aynı kaynak kontrolü, veri
projeksiyonunda gizli bilgi olmaması ve İstanbul takvimindeki teslim günleri test edilir.
Site kaydı için (`test/sites.test.mjs`): değişken site sayısı (0–12), mevcut üç siteli kurulumun
aynı kimlik ve kayıtlarla geçişi, panelden ekleme/duraklatma/kaldırma, sıfır siteyle başlatma,
bağlantı testi hata sınıfları (ağ, oturum, eksik token, tanınmayan yapı) ve önizleme, panel
verisinde gizli değer olmaması. Uyarlama promptunun gizli veri içermemesi `test/prompt.test.mjs`
ile doğrulanır.

## Kurulum ve etkinleştirme

Bilgisayarından Wrangler ile giriş, Worker dağıtımı, gizli ayarları yükleme, Gmail testi ve takibi başlatma komutları için [Cloudflare kurulum adımlarını](../../README.md#cloudflare-kurulumu) izle. Yeni kurulumda `LIVE_ENABLED=true` gelir. Takip, `start` çalıştırılınca etkinleşir.

Yerelde üretilen `data/cloudflare/secrets.json` dosyası 0600 izinle ve Git dışında tutulur. `prepare.py` yapılandırmayı 4000 baytlık ASCII parçalara böler. Paket okul sitesinin oturum bilgilerini, izlenecek sayfaları, Gmail ayarlarını ve UniTakip anahtarlarını içerir. Oturumu yenilerken mevcut şifreleme ve yönetim anahtarları korunur. Paketi yerelde sınamak için proje kökünden `node cloud/cloudflare/probe-local.mjs` çalıştırabilirsin.

İlk zamanlanmış çalışmayı doğrulamak için `node cloud/cloudflare/manage.mjs status` çıktısında `lastScheduledAt`, `lastScheduledSource` ve `scheduledRuns` alanlarını kontrol et. Kalıcı alarmın kaynağı `alarm`, zamanlanmış görevin kaynağı `cron` olarak görünür.

`/` panel kabuğunu, `/health` yalnızca genel sağlık bilgisini döndürür. `/auth/code` ve
`/auth/verify` giriş akışını işletir. `/api/*` yolları imzalı panel oturumu veya yönetim
anahtarı ister. Eski yönetim yolları `Authorization: Bearer <ADMIN_TOKEN>` ister.
Anahtarı URL'ye koyma veya loga yazma.
`/status` GET; `/probe`, `/smtp-check`, `/test-email`, `/start`, `/stop`, `/run` POST kullanır.
`/stop` kayıtları ve kuyruktakileri silmeden takibi durdurur.
Site bazında ödev bildirimi denemesi için yetkili POST `/test-email?platform=<site-id>`
kullanılır. Konu `[DENEME]` ile başlar ve mesaj bunun gerçek
bir ödev duyurusu olmadığını belirtir. Bu yol takip verilerine veya değişiklik kuyruğuna
deneme kaydı eklemez.

Yerel yönetim yardımcısı anahtarı komut satırına veya URL'ye yazmadan çağrı yapar:
`node cloud/cloudflare/manage.mjs status https://unitakip.<alt-alan-adın>.workers.dev/`.
İlk başarılı çağrı dağıtım adresini yerelde kaydeder; sonraki çağrılarda yalnızca `status`,
`probe`, `smtp-check`, `test-email`, `start`, `stop` veya `run` komutu yeterlidir.

**Panelden yeniden bağlanma.** Bir sitenin oturumu düşünce gönderilen uyarıda
`<PANEL_URL>/#/baglan/<site-id>` bağlantısı bulunur (telefondan da açılır). Panel girişinden sonra
kullanıcı adı, site şifresi ve gerekiyorsa SMS kodu girilir. Giriş isteğini Worker kendisi yapar
(`src/relogin.js`): Moodle için resmi mobil uygulama token yöntemi, ÜBYS için `/Account/Login` ve
`/Account/LoginCode`, diğer siteler için sayfadaki tek şifreli form. Şifre ve kod hiçbir yere yazılmaz;
SMS bekleyen adım 5 dakika boyunca geçerlidir ve çerezleri şifreli durumda tutulur. Açılan oturum şifreli
durumda `platforms[<id>].login` altında saklanır ve bilgisayardan yeni paket yüklenene kadar
geçerlidir. CAPTCHA veya e-Devlet adımları bilgisayardaki tarayıcıda tamamlanır.
Site başına 15 dakikada en fazla 6 deneme yapılabilir. ÜBYS aynı anda tek oturuma
izin veriyor olabilir: başka bir cihazdan girmek bulut oturumunu kapatabilir.

ÜBYS’yi e-Devlet ile bağlamak için **Siteler → ÜBYS → Panelden yeniden bağlan → Mac’te e-Devlet ile bağlan**
bölümündeki komutu proje klasöründe çalıştır. Varsayılan ÜBYS kaydında komut
`python3 cloud/cloudflare/refresh-session.py ubys` şeklindedir. Cloudflare dağıtımında `MAC_PROJECT_DIRECTORY`
tanımlıysa panel, proje klasörüne geçen ve `.venv` içindeki Python’u kullanan hazır komutu gösterir. Açılan ÜBYS sayfasında
**e-Devlet ile Giriş**’i seç ve ÜBYS’ye dönene kadar pencereyi açık tut. Oturum otomatik
algılanmazsa ÜBYS açıldıktan sonra terminalde Enter’a bas. Komut, okul oturumunu doğruladıktan
sonra yerel paketi yeniler ve Cloudflare’a yüklemeden önce onay ister. Pakete yalnızca okul
sitesinin oturum çerezleri alınır. Telefondan bağlanmak için ÜBYS kullanıcı adını ve şifreni
kullan. ÜBYS şifreni okulun giriş sayfasındaki **Giriş yapamıyor musunuz?** bağlantısından yenileyebilirsin.

Diğer siteler için panel kartı uygun `refresh-session.py` komutunu gösterir.
Eski `finish-learning-login.py` aynı komutu `ogreniyorum` için çağırır.

## Site kaydı

- Kayıt şifreli Durable Object durumunda (`state.sites`) tutulur; giriş bilgileri yalnızca
  Secrets paketindeki `platforms[<id>]` altında durur ve yalnızca aynı adres için kullanılır.
- İlk açılışta mevcut paketteki siteler aynı kimliklerle kayda alınır (geçiş); kayıtlar,
  kapsamlar ve bekleyen bildirimler korunur. Pakete sonradan eklenen siteler kayda kendiliğinden
  girer; panelden kaldırılanlar geri gelmez.
- Panel uçları (imzalı oturum + aynı kaynak): `POST /api/sites/save`, `/pause`, `/resume`,
  `/remove`, `/test`. Adres yalnızca `https`, herkese açık alan adı (IP, `localhost`, iç ağ adları
  reddedilir); sayfalar sitenin kendi alan adında olmalıdır.
- `src/sites.js` içindeki `capabilities` her türün gerçek destek düzeyini tek yerden tanımlar.

## Bilinen sınırlar

- Öğreniyorum.net ders ve konu kartları da materyal listesine alınır. `icerikpdf` gibi
  `.pdf` uzantısı taşımayan içerik adresleri PDF bağlantısı olarak tanınır; başlık ve ders
  bilgisi mevcut sayfalardan okunur, dosya indirilmez ve ek sayfa taraması yapılmaz.
  İlk geçiş mevcut içerikleri sessizce ekler; sonraki yeni materyaller bildirilir.
- Sağlıklı ara kontrollerde durum ve zamanlayıcı bilgisi tek kayıtta yazılır. Yeni içerik,
  hata ve yenilenen oturum çerezleri için erken kalıcı kayıt korunur. SQLite deposu zaten
  kalıcı olduğu doğrulanmış aynı durumu tekrar şifreleyip yazmaz; başarısız yazma yeniden
  denenebilir. Üç siteli yerel SQLite karşılaştırmasında sağlıklı ara kontrol 20 yerine
  4 satır değişikliği üretti (%80 azalma). Bu, tüm günlük tüketim için bir yüzde garantisi
  değildir; tam taramalar ve bildirim yoğunluğu ayrıca tüketim oluşturur.
- Yalnızca bildirim için yerel site yapılandırmasında `download_files: false` ve
  `download_existing_files: false` kullanılır; ardından bulut paketi güncellenir.
  Dosya adı/bağlantısı ve sayfa değişiklikleri izlenir, dosyanın kendisi otomatik
  indirilmez veya arşivlenmez. Durum raporları bu ayardan bağımsızdır.
- Uzun süreli oturum ömrü siteye göre değişir ve henüz ölçülmedi.
- Web oturumlarının ömrü siteye bağlıdır. Süre dolarsa uyarı gönderilir; bilgisayarda tekrar giriş
  ve bulut paketini yenilemek gerekir. “Beni hatırla” kesintisiz oturum garantisi değildir.
- Otomatik okul şifresiyle yeniden giriş, tarayıcı gerektiren yeni sayfalar ve ücretli AI
  Python sürümünden taşınmadı. Bugünkü yapılandırılmış sayfalar HTTP ile okunabiliyor.
- Kuyruk gönderim öncesinde kalıcıdır ve başarısız denemeler sayıları yüzünden silinmez.
  Kabul edilmiş bir e-postanın hemen ardından süreç kesilirse tekrar gönderim olabilir.
- İstanbul saatiyle 09.00 ve 15.00 sonrasındaki ilk olağan kontrolde kısa durum e-postası gelir.
  Her site için son başarılı tam kontrol saati gösterilir. Kaçırılan eski saatler topluca gönderilmez.
  21.00 sonrasında günlük özet gelir. Daha önce bildirilen erişim sorunu düzelirse ayrıca durum
  raporu gönderilir. Başarısız gönderimler kalıcı kuyrukta yeniden denenir.
- Erişim, giriş, okuma ve anket/onay ekranı hataları ilk tespit edilen kontrolde, diğer sitelerin
  taraması bitmeden gönderilmeye çalışılır. Aynı kesinti sürdükçe uyarı yinelenmez; düzelip yeniden
  bozulursa yeni olay olarak bildirilir. Giriş sayfasıyla gelen anonim çerezler saklı oturumun üzerine
  yazılmaz. Moodle tokenı ve web oturumları 10 dakikalık olağan kontrollerde sınanır. Bartın ÜBYS’ye
  arada bir oturum isteği daha gönderildiği için ÜBYS yaklaşık 5 dakikada bir yoklanır. Ara yoklama
  geçerli oturumun yenilenen çerezlerini saklar. Tam taramayı ve giriş uyarılarını olağan kontrol yürütür.
  Düzelme raporunda da yalnızca düzelen siteler yer alır.
- Toplu görünüm koruması: bir bölümde tek kontrolde 12 ya da daha çok yeni/güncellenen kayıt varsa
  tek özet gönderilir; bütün kayıtlar panelde korunur. Özet yeni ve güncellenen sayılarını ayırır ve ilk
  kayıtların farklarını gösterir. Bu, gerçek bir toplu yükleme de olabilir; sayıdan içeriğin eski olduğu
  sonucu çıkarılmaz. Daha küçük yüklemeler normal içerik bildirimi olarak kalır.
- Yeniden girişte her HTTP yanıtının başlığı ve gövdesi 20 saniyeyle, bir giriş adımının tamamı 60
  saniyeyle sınırlıdır. Yanıt gövdesi en fazla 2 MiB okunur; takılan istek iptal edilir, takip kilidi bırakılır.
- Gönderilen e-posta sayacı yalnızca SMTP kabulünden sonra artar; başarısız denemeler kuyrukta kalır.
  Günlük özet henüz doğrulanmamış bir kontrol hatasını "sitelerde sorun yok" diye göstermez.
- "Şimdi kontrol et" her zaman bütün siteleri baştan okur (yarım kalmış turda okunmuş site de yeniden okunur)
  ve tek çalışmaya sığmazsa 10 dakikalık zamanlayıcıyı beklemeden birkaç saniye arayla sürer. Bir sitede okuma
  sorunu (anket ekranı, eksik bölüm, ulaşılamayan site) sürerken tam tarama 20 dakikada bir yinelenir.
- Moodle dosyaları panelden doğrudan iner (`/api/file?id=…`): istek panel oturumu ister, yalnızca takip edilen
  bir dosyanın kimliğini kabul eder, dosyayı bulutun kendi anahtarıyla sitenin kendi alan adından getirir ve
  her zaman ek (attachment) olarak verir. Anahtar yanıtta görünmez; yönlendirme izlenmez.
- Yanıt vermeyen sitede art arda iki istek başarısız olursa sonraki istekler yeniden denenmez; böylece çökmüş
  bir site dış istek payını tüketip "site çok büyük" diye yanlış uyarı üretmez.
- Oturumlar boşta bırakılmaz: tam tarama birkaç kontrole yayıldığında, o kontrolde okunmayan çerezli
  her site tek istekle yoklanır. Her sitenin tam okuma maliyeti (istek sayısı) hatırlanır ve kalan paya sığmayacağı bilinen
  okuma başlatılmaz, yarım okumayla pay ve site boşuna yorulmaz.
- Site, bir form tamamlanana kadar bütün sayfalarında aynı ekranı gösteriyorsa (zorunlu anket,
  sözleşme onayı) bu içerik değişikliği sayılmaz: en az üç sayfa aynı kontrolde aynı metne
  dönüşürse o sayfalar birleştirilmez, eski kayıtlar korunur ve "Site anket veya onay ekranı
  gösteriyor" uyarısı bir kez gider. Form siteye girilip tamamlanınca takip kendiliğinden sürer.
- `/status` ve panel verisi `statusReportIntervalHours`, `statusReportMode` (`on-change`),
  `lastStatusReportSentAt` ve `nextStatusReportAt` (yeni raporun gidebileceği en erken zaman)
  alanlarını verir. Son gönderim zamanı SMTP kabulünden sonra yazılır.
  Bütün Cloudflare hesabı veya Gmail durursa aynı sistem kendi dışından uyarı veremez;
  e-posta gelmemesi tek başına sistemin çalıştığını göstermez, paneldeki son kontrol zamanına bakılır.
- Bu sürüm Python'un günlük ayrı veritabanı yedeklerini henüz üretmez. Şifreleme anahtarı
  kaybolursa şifreli duruma ve arşive erişilemez; yerel paket güvenle korunmalıdır.

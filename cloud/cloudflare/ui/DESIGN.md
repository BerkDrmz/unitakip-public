# UniTakip paneli · tasarım sistemi

**Konsept: sade, modern ajanda.** Nötr gri zemin, tek yazı tipi, ince çizgili kartlar, süssüz yüzeyler.
Arayüz bir yönetim paneli gibi değil, öğrencinin kişisel ajandası gibi davranır: ilk soru her zaman "sırada ne var?" olur.

## Bilgi mimarisi

| Sayfa (hash) | Amaç |
|---|---|
| `#/bugun` | Durum cümlesi ("Bu hafta 6 teslim var."), 3 rakam, **14 günlük ajanda şeridi**, sıradaki teslimler, son değişiklikler, platform sağlığı |
| `#/teslimler` | Ödev + sınav + sınav duyurusu tek listede; Bugün / Yarın / Bu hafta / Daha sonra kovaları; geçmiş katlanır |
| `#/notlar` | Ders başına kart; Vize/Final önce; bekleyen not "Bekleniyor" olarak, boş alan yok |
| `#/dosyalar` | Derslere göre gruplanmış materyaller; tür ve platform süzgeci; son 7 günde gelenler "Yeni" |
| `#/bildirimler` | E-postaya giden her şey, gün gün |
| `#/siteler` | Takip edilen siteler: ekle/düzenle (hazır şablon isteğe bağlı), bağlantı testi ve içerik önizlemesi, duraklat/sürdür, kaldır. Her kartta Tam/Kısmi/Yok yetenek matrisi, giriş komutu ve “Claude / Codex ile uyarlama” promptu. Mobil alt çubukta yok; Bugün ve Ayarlar’dan açılır |
| `#/ayarlar` | Takip anahtarı, sıklık, sitelerin özeti ve “Siteleri yönet”, deneme e-postası, hesap |

Hash yönlendirme sayesinde tarayıcının geri tuşu ve yer imleri çalışır. Mobilde 5 sekmeli alt çubuk var,
bildirimlere üst çubuktaki zilden gidilir.

## Belirteçler (`src/styles.css`)

- **Yazı tipi** (kendi sunucumuzdan, CSP `font-src 'self'`): yalnızca Inter Variable (optik boyutlu). Başlıklar aynı
  yazı tipinin yarı kalın kesimi ve sıkı harf aralığıyla (`font-display` sınıfı) ayrılır; italik kullanılmaz.
- **Renk rolleri:** `paper`, `card`, `wash`, `ink`/`ink-2`/`ink-3`, `rule` (nötr gri ölçek), `accent` (tek mavi vurgu).
  Aciliyet için üç ton: `hot` (bugün/yarın), `warm` (≤3 gün), `cool` (tamam/açıklandı).
  Site noktaları: Bartın şablonları `--sanal`, `--ogreniyorum`, `--ubys` renklerini kullanır; diğer siteler kimliklerinden türetilen kararlı bir palet rengi alır (`lib/meta.js`). Küçük metinler WCAG AA (≥4.5:1) hedefiyle seçildi.
- **Tema seçimi: Sistem / Aydınlık / Karanlık** (`src/lib/theme.js`). Seçim `localStorage`'da saklanır, `<html data-theme>`
  ile uygulanır; "Sistem" cihaz ayarını canlı izler. `public/theme-init.js` ilk çizimden önce çalışır (yanlış temada
  parlama olmaz; CSP satır içi betiğe izin vermediği için ayrı dosya). Değişim, View Transitions ile tıklanan
  düğmeden yayılan dairesel geçişle yapılır; hareket azaltma tercihinde anında değişir. Seçiciler: masaüstü kenar
  çubuğu, mobil üst çubuk (tek dokunuş), Ayarlar › Görünüm ve giriş sayfası. Giriş sayfasının sol paneli her temada koyudur.
- **Yüzeyler:** doku ve büyük gölge yok. Kartlar `rounded-xl` + 1 px çizgi; düğmeler `rounded-lg`; açılır pencereler
  yalnızca hafif gölge kullanır. Mobil alt çubuk tam genişlikte, üst çizgili ve şeffaf buzlu zeminlidir.

## Bileşenler

`src/components/ui/primitives.jsx`: shadcn kurallarıyla (cva + `cn`) yazılmış Button, Chip, Segmented
(Motion `layoutId` ile kayan seçici), SearchField, FilterChips, Switch, Card, SectionTitle, Empty, Sheet.
Sheet yerel `<dialog>` kullanır: masaüstünde ortada kart, mobilde alttan çekmece; Esc ve dış tıklama kapatır.

## Konsol dili (21 Kasım, güncel; yuvarlak köşeli)

Awwwards "Transitions" listesinden Koval SEO Console, North.cloud ve Orchestrated; günün sitelerinden Grids S03, ViV,
DeepBook ve A24 incelendi. Panele "takip konsolu" olarak uyarlandı. Kullanıcı köşeli yapı yerine yuvarlak köşe istedi:
kartlar 20 px, satırlar 16 px, menü ve düğmeler 12 px, çip/etiket/arama/süzgeç tam yuvarlak. (Arada denenen sol menüsüz,
yüzen alt menülü "ders masası" tasarımı beğenilmedi ve geri alındı.)

- **Zemin:** noktalı ızgara (`--dot`, 22 px). **Yazı:** Inter başlıklar `-0.045em`, JetBrains Mono etiketler.
- **Sayfa başı:** ters renkli yuvarlak numara çipi (`.chip-ink` "02"), çözülerek beliren yuvarlak etiket (`Scramble` + `.tag`),
  noktalı ayraç (`DrawRule dotted`), sağda "02 / 07"; başlık 3,75rem'e kadar, kelime kelime yükselir.
- **Menü:** 01–07 dizin numaraları; satır üzerine gelince soldan dolan zemin (`.row-sweep`), etiket kayar.
- **Bölüm başlıkları:** "[01] Ajanda ·········· 14 gün" (dizin + çizilen noktalı ayraç).
- **Liste satırları:** soldan dolan zemin, başlık 4 px kayar; durum çipleri mono, büyük harf, hap biçiminde.
- **Sayfa geçişi:** koyu perde yuvarlak üst kenarla aşağıdan kaplar, üstünde sayfa adı ve "02 / 07"; içerik perde ekranı
  kapladığında (`PAGE_COVER_MS` 330 ms) değişir, perde yukarı çekilir (0,82 sn, CSS `@keyframes page-curtain`).
  Animasyon olayı gelmezse perde 1,5 sn sonra kendiliğinden kalkar.
- **Açılış:** kenarlarda mono etiketler, 000→100 sayacı, harf harf yükselen marka, perde yukarı.
- **Kaydırma rayı** (sağ kenar, ≥1280 px, yuvarlak uçlu) ve alt bilgide noktalardan oluşan dev "UniTakip" (`.dot-type`).

## Hareket

Awwwards'ta ödül alan sitelerden (ViV MGMT, Grids S03, Emotion Agency, DeepBook, A24) çıkarılan dil, günlük kullanılan
bir panele göre kısaltıldı. Bileşenler `src/components/motion.jsx` içinde:

- **Açılış perdesi** (`Intro`): oturum başına bir kez; "UniTakip" harf harf yükselir, koyu perde yukarı kalkar (≈1,5 sn).
- **Başlıklar** (`RevealText`): kelime kelime maskenin altından yükselir (SplitText benzeri, `<em>` korunur).
- **Sayfa geçişi**: eski içerik 0,16 sn'de çıkar, yenisi 0,5 sn'de yükselir; üstte soldan sağa ince çizgi (`RouteLine`).
- **Görününce belirme**: kartlar ve bloklar (`Card`, `Reveal`) bir kez, 0,7 sn.
- **Sayaçlar** (`CountUp`), **manyetik düğme** (`Magnetic`, yalnızca fareli cihazlarda), düğmelerde alttan dolan zemin,
  ajandada seçili günün kayarak geçmesi (`layoutId`), köşe "+" işaretleri (`CornerMarks`).
- **Yumuşak kaydırma** (Lenis, `useSmoothScroll`): yalnızca fareli masaüstünde; açılır pencereler (`data-lenis-prevent`,
  `lenis.stop()`) ve sayfa başına dönüş (`scrollToTop`) onunla uyumlu.
- Eğriler: easeOutQuint `cubic-bezier(0.23,1,0.32,1)` girişlerde, easeInOutCubic `cubic-bezier(0.65,0,0.35,1)` perde ve geçişlerde.
- `MotionConfig reducedMotion="user"`, bileşenlerdeki `useReducedMotion` ve CSS `prefers-reduced-motion` ile hareket azaltma
  tercihinde hepsi kapanır. Three.js/WebGL bilinçli olarak kullanılmadı: panelin hızına ve okunurluğuna katkısı yok.
- Vite varlıkları gömmez (`assetsInlineLimit: 0`): CSP `font-src 'self'` data: yazı tiplerini engeller.

## Erişilebilirlik ve kalite kontrolleri

- Her sayfada tek `h1`, adı olmayan kontrol yok (otomatik denetlendi), görünür odak halkası, "İçeriğe geç" bağlantısı.
- 44px'ten küçük görünen kontrollerde `hit-area` ile büyütülmüş dokunma alanı.
- Platform verisindeki HTML varlıkları (`0&ndash;100`) `clean()` ile güvenle çözülür.
- 375 px genişlikte yatay taşma yok (ölçüldü). Izgaralar `grid-cols-1` / `minmax(0,1fr)` kullanır.

## Yerel önizleme

```bash
cd ui
UNITAKIP_UI_DEMO=1 UNITAKIP_UI_DEMO_RICH=1 npx vite --port 5181   # deneme kodu: 123456
```
`UNITAKIP_UI_DEMO_RICH=1` gerçekçi yoğunlukta örnek veri yükler (yalnızca yerel geliştirme).

// "Claude / Codex ile uyarlama" promptu. Saf işlev: tarayıcı ve Node testlerinde aynı çalışır.
//
// Güvenlik: Prompt yalnızca site adı, herkese açık adres (origin + yol), bağlantı türü, istenen
// özellikler ve hata KODUNUN genel açıklamasını içerir. Şifre, token, çerez, e-posta, kişisel not,
// sorgu parametresi, URL parçası (#) veya sunucunun ham hata metni asla eklenmez.

export const FEATURE_LABELS = {
  announcements: "Duyuru",
  files: "Dosya",
  assignments: "Ödev",
  exams: "Sınav",
  grades: "Not",
};

export const ERROR_SUMMARIES = {
  network: "Siteye bağlanılamadı (ağ hatası veya site Cloudflare ağından erişime kapalı olabilir).",
  auth: "Giriş gerekiyor ya da oturumun/tokenın süresi dolmuş.",
  site: "Sayfa yapısı tanınmadı; mevcut adaptör bu siteyi okuyamıyor (desteklenmeyen yapı).",
  maintenance: "Site bakım sayfası döndürdü.",
  size: "Sayfa boyutu sınırı (8 MB) aşıldı.",
  deadline: "Kontrol süre sınırına takıldı.",
  unsafe: "Site başka bir alan adına yönlendiriyor (ör. ayrı bir giriş sağlayıcısı).",
  config: "Site tanımı eksik veya geçersiz.",
  partial: "Sayfanın bazı bölümleri okunamadı.",
  gate: "Site bütün sayfalarda aynı ara ekranı (zorunlu anket/onay) gösteriyor.",
};

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HAS_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const LONG_DIGITS = /\d{5,}/g;
const OPAQUE = /^[A-Za-z0-9_-]{20,}$/;

/** Ad: e-posta ve uzun sayı dizileri (öğrenci/kimlik no) temizlenir. */
export function safeName(value) {
  const cleaned = String(value || "")
    .replace(EMAIL, "[e-posta]")
    .replace(LONG_DIGITS, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || "Adsız site";
}

/** Herkese açık adres: yalnızca https origin + yol; sorgu, parça, kimlik bilgisi ve opak kimlikler atılır. */
export function publicAddress(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return "(adres geçersiz)";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "(adres geçersiz)";
  const path = url.pathname
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {}
      if (OPAQUE.test(decoded) || /\d{5,}/.test(decoded) || HAS_EMAIL.test(decoded)) return "…";
      return segment;
    })
    .join("/");
  return `${url.protocol}//${url.hostname}${path}`;
}

/**
 * @param {{name?: string, url?: string, type?: string}} site  Panel projeksiyonu (gizli alan içermez).
 * @param {{wants?: string[], code?: string|null, unsupported?: string[]}} context
 */
export function buildAdaptationPrompt(site, { wants = [], code = null, unsupported = [] } = {}) {
  const name = safeName(site?.name);
  const address = publicAddress(site?.url);
  const type = site?.type === "moodle" ? "Moodle (web servisi)" : "Genel web sayfası (HTTP ile sayfa okuma)";
  const wanted = wants.filter((key) => FEATURE_LABELS[key]).map((key) => FEATURE_LABELS[key]);
  const missing = unsupported.filter((key) => FEATURE_LABELS[key]).map((key) => FEATURE_LABELS[key]);
  const problem = code && ERROR_SUMMARIES[code] ? ERROR_SUMMARIES[code] : "Bağlantı testi başarılı ama istenen özelliklerin bir kısmı desteklenmiyor.";

  return [
    `UniTakip projesinde "${name}" sitesi için takip desteği geliştirmeni istiyorum. Proje bu klasörde açık.`,
    "",
    "## Site",
    `- Ad: ${name}`,
    `- Herkese açık adres: ${address}`,
    `- Bağlantı türü: ${type}`,
    `- İstenen takip: ${wanted.length ? wanted.join(", ") : "belirtilmedi"}`,
    `- Şu anki durum: ${problem}`,
    ...(missing.length ? [`- Şu an desteklenmeyen istekler: ${missing.join(", ")}`] : []),
    "",
    "## Projede bakılacak yerler",
    "- Cloudflare sürümü: `cloud/cloudflare/` (Worker + Durable Object, `npm test`)",
    "  - Site kaydı, hazır şablonlar ve desteklenen özellikler: `src/sites.js`",
    "  - Genel web sayfası adaptörü: `src/core.js` (`webSnapshot`, `parsePage`, `parseUbysCourse` örneği)",
    "  - Moodle adaptörü: `src/moodle.js`",
    "  - Takip motoru ve bağlantı testi: `src/runtime.js` (`testSite`)",
    "- Yerel Python sürümü: `src/unitakip/adapters/`, giriş: `unitakip login <site-id>`",
    "",
    "## Yapmanı istediklerim",
    "1. Önce mevcut Moodle ve genel web sayfası adaptörlerini değerlendir ve yeniden kullan. Ancak gerçekten gerekiyorsa bu siteye özel bir ayrıştırıcı ekle.",
    "2. Giriş gerektiren sayfalar için girişi BEN kendi tarayıcımda yapacağım (`unitakip login <site-id>`). Benden şifre, token veya çerez isteme; bunları yazdırma, loglama ya da dosyaya koyma.",
    "3. CAPTCHA, SMS veya e-Devlet doğrulamasını aşmaya çalışma. Yalnızca okuma yap: form gönderme, ödev teslimi, kayıt veya silme işlemi yapma.",
    "4. Cloudflare Worker'da tarayıcı çalıştırılamıyor. Sayfa içeriği JavaScript ile yükleniyorsa bunu açıkça söyle; HTTP ile okunabilen bir JSON uç noktası varsa onu öner. Bulutta çalışmayan bir şeyi çalışıyormuş gibi gösterme.",
    "5. Hangi özelliklerin (duyuru, dosya, ödev, sınav, not) gerçekten desteklendiğini `capabilities` içinde dürüstçe güncelle. Sadece sayfa değişimini görebilen bir bağlantıyı not veya ödev anlıyormuş gibi gösterme.",
    "6. Kişisel veri içermeyen, temizlenmiş örnek HTML/JSON ile test yaz (`cloud/cloudflare/test/`). `npm test` ve `npm run build:ui` çalıştır.",
    "7. Gizli dosyaları (`data/`, `.env`, `config/config.yaml`) Git'e ekleme. Canlıya dağıtım ve GitHub'a gönderim yapmadan önce bana sor.",
    "8. Sonunda neyin desteklendiğini, neyi gerçek hesapla doğrulayamadığını ve kalan sınırları kısaca raporla.",
  ].join("\n");
}

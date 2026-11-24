import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleDashed,
  ClipboardCopy,
  Globe,
  KeyRound,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button, Card, Chip, Empty, PlatformDot, Sheet } from "../components/ui/primitives.jsx";
import { ClassroomConnect } from "../components/classroom-connect.jsx";
import { RefreshSessionCommand, useCopy } from "../components/refresh-session-command.jsx";
import { clean, relative } from "../lib/format.js";
import { FEATURE_KEYS, FEATURE_NAMES, platformHealth, siteTestFailure } from "../lib/meta.js";
import { buildAdaptationPrompt } from "../lib/prompt.js";
import { cn } from "../lib/utils.js";
import { PageHeader } from "./page-header.jsx";

/*
  Takip edilen siteler. Burada gösterilen her şey panel projeksiyonundan gelir: gizli alan
  (token, çerez, e-posta) yoktur. Yetenekler sunucudaki `capabilities` ile aynı kaynaktan okunur;
  arayüz bir sitenin ne yapabildiğini kendisi tahmin etmez (yalnızca form önizlemesinde kaba bir
  ipucu verir ve kayıttan sonra sunucunun dediği gösterilir).
*/

const LEVEL = {
  full: { label: "Tam", tone: "cool", icon: Check },
  partial: { label: "Kısmi", tone: "warm", icon: CircleDashed },
  none: { label: "Yok", tone: "idle", icon: Minus },
};

const TYPE_LABEL = { moodle: "Moodle", webpages: "Web sayfası", classroom: "Google Classroom" };

const TEST_MESSAGES = {
  classroom_setup: ["Classroom bağlantısı kurulmalı", "Apps Script ile bir defa bağlan. Okul hesabı izin verirse ödevler ve duyurular düzenli aktarılır."],
  classroom_waiting: ["İlk Classroom aktarımı bekleniyor", "Apps Script projesinde startUniTakip işlevini çalıştır."],
  classroom_sync: ["Classroom aktarımı gecikti", "Apps Script projesinde syncUniTakip işlevini çalıştır veya yürütme geçmişine bak."],
  classroom_policy: ["Classroom erişim izni gerekiyor", "Google Cloud projesinde Classroom API’yi ve okul hesabının uygulamaya izin verdiğini kontrol et."],
  network: [
    "Siteye ulaşılamadı",
    "Adres yanlış olabilir, site geçici olarak kapalı olabilir ya da yalnızca okul ağından açılıyor olabilir. Bulut kontrolü okul ağının dışından yapılır.",
  ],
  auth: [
    "Giriş gerekiyor",
    "Oturum yok veya süresi dolmuş. Site şifrenle panelden ya da bilgisayarındaki tarayıcıdan yeniden bağlanabilirsin.",
  ],
  site: [
    "Sayfa yapısı tanınmadı",
    "Sayfa okundu ama seçili bağlantı türü içeriği anlayamadı. Bu site için uyarlama gerekebilir.",
  ],
  maintenance: ["Site bakımda", "Site bakım sayfası gösteriyor. Biraz sonra yeniden test et."],
  size: ["Sayfa çok büyük", "Sayfa 8 MB sınırını aşıyor. Daha dar bir sayfa adresi seç."],
  deadline: ["Süre doldu", "Site zamanında yanıt vermedi. Biraz sonra yeniden dene."],
  unsafe: [
    "Başka bir alan adına yönlendiriyor",
    "Siteyi tarayıcında aç. Adres değişiyorsa açılan son HTTPS adresini ekle. Merkezi giriş gerekiyorsa okul hesabınla bağlan.",
  ],
  config: ["Kurulum eksik", "Site tanımı eksik veya geçersiz. Adresi, bağlantı türünü ve izlenecek sayfaları kontrol et."],
  partial: ["Kısmen okundu", "Bazı bölümler okunamadı; okunabilenler aşağıda."],
  gate: [
    "Site anket veya onay ekranı gösteriyor",
    "Site bütün sayfalarında aynı ekranı (zorunlu anket, sözleşme onayı vb.) gösteriyor. Siteye kendi tarayıcından girip formu tamamla; takip kendiliğinden devam eder.",
  ],
  quota: [
    "Çok fazla sayfa izleniyor",
    "Cloudflare ücretsiz planda tek çalışmada en fazla 50 dış istek yapılabilir. Bu site tek başına bu payı aşıyor; izlenen sayfa sayısını azalt (en fazla 40) ya da siteyi ikiye böl.",
  ],
};

/** Hata kodu yerine giriş adımı gösterilecek durumlar. */
const needsLogin = (site) => site.error === "auth" || site.login === "missing" || siteTestFailure(site) === "auth";

/* ------------------------------------------------------------------ Yetenek matrisi */
function CapabilityGrid({ capabilities, wants = [] }) {
  const keys = [...FEATURE_KEYS, "pageChanges"];
  return (
    <div>
    <p className="mb-2 text-xs leading-relaxed text-ink-3">Destek düzeyi, içerik takibi ve bildirim kapsamını gösterir. Dosyaların nereden açıldığı ve teslim durumu aşağıda ayrıca belirtilir.</p>
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule sm:grid-cols-3" aria-label="Desteklenen özellikler">
      {keys.map((key) => {
        const cap = capabilities?.[key] || { level: "none", note: "" };
        const level = LEVEL[cap.level] || LEVEL.none;
        const Icon = level.icon;
        const wanted = wants.includes(key);
        return (
          <li key={key} className="flex flex-col gap-1.5 bg-card px-3.5 py-3">
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                {FEATURE_NAMES[key]}
                {wanted && (
                  <span className="size-1.5 rounded-full bg-accent" title="Takip etmek istediğin özellik" aria-label="istenen" />
                )}
              </span>
              <Chip tone={level.tone}>
                <Icon className="size-3" aria-hidden />
                {level.label}
              </Chip>
            </span>
            {cap.note && <span className="text-xs leading-snug text-ink-3">{cap.note}</span>}
          </li>
        );
      })}
    </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ Claude / Codex ile uyarlama */
function AdaptationPanel({ site, code, unsupported, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, copy] = useCopy();
  const ref = useRef(null);
  const prompt = useMemo(() => {
    // İstek belirtilmişse yalnızca istenip desteklenmeyenler; belirtilmemişse desteklenmeyen her şey.
    const wants = site.wants?.length ? site.wants : unsupported;
    const missing = unsupported.filter((key) => wants.includes(key));
    return buildAdaptationPrompt({ name: site.name, url: site.url, type: site.type }, { wants, code, unsupported: missing });
  }, [site.name, site.url, site.type, site.wants, code, unsupported]);
  return (
    <div className="rounded-2xl border border-dashed border-rule-strong">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left hover:bg-wash/60"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <Sparkles className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Claude / Codex ile uyarlama</span>
          <span className="block text-xs text-ink-3">Bu site için adaptörü kendi bilgisayarında geliştirmek üzere hazır prompt</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-4 pb-4">
              <ol className="space-y-1.5 text-sm leading-relaxed text-ink-2">
                <li>
                  <span className="mr-2 font-display text-ink-3">01</span>Projeyi bilgisayarında Claude Code veya Codex ile aç.
                </li>
                <li>
                  <span className="mr-2 font-display text-ink-3">02</span>Aşağıdaki promptu yapıştır; adaptörü geliştirip testleri çalıştırsın.
                </li>
                <li>
                  <span className="mr-2 font-display text-ink-3">03</span>Sonucu kendin kontrol et ve kendi Cloudflare hesabına dağıt.
                </li>
              </ol>
              <textarea
                ref={ref}
                readOnly
                value={prompt}
                rows={9}
                aria-label="Uyarlama promptu"
                className="block w-full resize-y rounded-2xl border border-rule bg-paper px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-2"
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" icon={copied === "ok" ? Check : ClipboardCopy} onClick={() => copy(prompt, ref.current)}>
                  {copied === "ok" ? "Kopyalandı" : "Promptu kopyala"}
                </Button>
                <span className="text-xs leading-snug text-ink-3" role="status">
                  {copied === "fail"
                    ? "Kopyalanamadı; metni seçip elle kopyala."
                    : "Şifre, token, çerez, e-posta ve sorgu parametreleri prompta eklenmez."}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ Son test sonucu */
function TestResult({ test, historical = false, initialized = false }) {
  if (!test) return null;
  const message = test.code ? TEST_MESSAGES[test.code] : null;
  const counts = Object.entries(test.counts || {}).filter(([, n]) => n > 0);
  return (
    <div className="rounded-2xl bg-wash/70 px-4 py-3.5" aria-live="polite">
      {historical && <p className="mb-2 text-xs text-ink-3">Önceki bağlantı testi · Güncel takip durumu yukarıda.</p>}
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Chip tone={historical ? "idle" : test.ok ? "cool" : test.code === "partial" ? "warm" : "hot"} dot>
          {test.ok ? "Test başarılı" : message ? message[0] : "Test başarısız"}
        </Chip>
        <span className="text-xs text-ink-3">{relative(test.at)}</span>
        {test.items > 0 && <span className="text-xs text-ink-3">· {test.items} öğe okundu</span>}
      </p>
      {message && !test.ok && !historical && <p className="mt-2 text-sm leading-relaxed text-ink-2">{message[1]}</p>}
      {counts.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {counts.map(([key, n]) => (
            <Chip key={key} tone="calm">
              {FEATURE_NAMES[key] || key} · {n}
            </Chip>
          ))}
        </p>
      )}
      {test.preview?.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-ink-3 uppercase">Bulunan içerikten örnekler</p>
          <ul className="divide-y divide-rule/60 rounded-2xl border border-rule bg-card">
            {test.preview.map((item, i) => (
              <li key={i} className="flex items-baseline gap-3 px-3 py-2">
                <span className="w-16 shrink-0 text-xs text-ink-3">{FEATURE_NAMES[item.kind] || "Öğe"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{clean(item.title) || "Başlıksız"}</span>
                  {item.course && <span className="block truncate text-xs text-ink-3">{clean(item.course)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {test.ok && test.counts?.pageChanges > 0 && !test.counts?.announcements && (
        <p className="mt-2 text-sm text-ink-3">Sayfanın metni izleniyor. Duyurular bu sayfada ayrı kayıtlar olarak okunamıyor.</p>
      )}
      {test.ok && test.items > 0 && !initialized && (
        <p className="mt-2 text-sm text-ink-3">İlk tarama mevcut içeriği kaydeder. Bildirimler sonraki değişikliklerle başlar.</p>
      )}
      {test.ok && !test.items && (
        <p className="mt-2 text-sm text-ink-3">Bağlantı kuruldu ama okunabilen bir öğe bulunmadı. Sayfa giriş gerektiriyor ya da içerik JavaScript ile yükleniyor olabilir.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Site kartı */
function SiteCard({ site, active, busy, onTest, onEdit, onTogglePause, onRemove }) {
  const health = platformHealth({ ...site, initialized: Boolean(site.lastSuccess) }, active);
  const unsupported = useMemo(
    () => FEATURE_KEYS.filter((key) => site.capabilities?.[key]?.level === "none"),
    [site.capabilities],
  );
  const wantedMissing = (site.wants || []).filter((key) => unsupported.includes(key));
  const failedTest = siteTestFailure(site);
  const code = site.error || failedTest || null;
  const login = needsLogin(site);
  const classroom = site.type === "classroom";
  const problem = Boolean(code) || wantedMissing.length > 0;
  const [showAdapt, setShowAdapt] = useState(false);
  const adaptable = !classroom && (problem || showAdapt);

  return (
    <Card as="article" className={cn("p-5 sm:p-6", site.paused && "opacity-80")} aria-labelledby={`site-${site.id}`}>
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <PlatformDot platform={site.id} className="mt-2.5 size-2.5" />
        <div className="min-w-0 flex-1">
          <h2 id={`site-${site.id}`} className="font-display text-lg leading-snug font-semibold text-balance">
            {site.name}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            {site.url ? (
              <a
                href={site.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-ink-2 underline-offset-4 hover:underline"
              >
                {site.hostname}
                <ArrowUpRight className="size-3" aria-hidden />
              </a>
            ) : (
              <span>Adres yok</span>
            )}
            <span aria-hidden>·</span>
            <span>{TYPE_LABEL[site.type] || site.type}</span>
            {site.preset && (
              <>
                <span aria-hidden>·</span>
                <span>Hazır şablon</span>
              </>
            )}
            {site.origin !== "panel" && (
              <>
                <span aria-hidden>·</span>
                <span title="Bu site bilgisayarındaki yapılandırmadan aktarıldı">Yerel yapılandırma</span>
              </>
            )}
          </p>
        </div>
        {/* Dar ekranda durum etiketi uzun site adlarını sıkıştırmasın diye alt satıra iner */}
        <div className="order-last w-full pl-[1.625rem] sm:order-none sm:w-auto sm:pl-0">
          <Chip tone={health.tone} dot size="md">
            {health.label}
          </Chip>
        </div>
      </header>

      <p className="mt-3 text-xs text-ink-3">
        {site.lastSuccess ? `Son başarılı kontrol ${relative(site.lastSuccess)}` : "Henüz takip kontrolünden geçmedi"}
        {site.items ? ` · ${site.items} kayıt` : ""}
        {site.partialCount ? ` · ${site.partialCount} bölüm okunamadı` : ""}
        {site.type === "webpages" && site.pagesCount ? ` · ${site.pagesCount} sayfa izleniyor` : ""}
      </p>

      <div className="mt-5">
        <CapabilityGrid capabilities={site.capabilities} wants={site.wants} />
      </div>

      {(code || wantedMissing.length > 0) && (
        <div className="mt-4 space-y-3">
          {code && !site.paused && (
            <div className={cn("rounded-2xl px-4 py-3.5", login ? "bg-hot-soft/60" : "bg-warm-soft/60")} role="note">
              <p className={cn("flex items-center gap-2 text-sm font-semibold", login ? "text-hot" : "text-warm")}>
                {login ? <KeyRound className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}
                {(TEST_MESSAGES[code] || ["Kontrol gerekli"])[0]}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">
                {(TEST_MESSAGES[code] || [null, "Son kontrolde bir sorun oluştu. Bağlantıyı test ederek ayrıntıyı görebilirsin."])[1]}
              </p>
              {login && !classroom && (
                <>
                  <div className="mt-3">
                    <Button size="sm" icon={KeyRound} onClick={() => { window.location.hash = `/baglan/${encodeURIComponent(site.id)}`; }}>
                      Panelden yeniden bağlan
                    </Button>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-ink-2">
                    Panelden giriş olmazsa (ör. CAPTCHA) proje klasöründe şu komutu çalıştır; site kendi tarayıcında açılır, girişi sen yaparsın. CAPTCHA veya SMS doğrulaması
                    varsa onu da sen tamamlarsın. Komut, oturumu şifreli olarak kendi Cloudflare hesabına aktarmadan önce onay ister.
                  </p>
                  <RefreshSessionCommand site={site} />
                </>
              )}
            </div>
          )}
          {wantedMissing.length > 0 && (
            <p className="flex items-start gap-2 rounded-2xl bg-wash/70 px-4 py-3 text-sm leading-relaxed text-ink-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warm" aria-hidden />
              <span>
                İstediğin <strong className="font-semibold text-ink">{wantedMissing.map((key) => FEATURE_NAMES[key]).join(", ")}</strong> bu
                bağlantıyla ayrı kayıt olarak okunamıyor. Sayfadaki değişiklikler yine bildirilir, ancak{" "}
                {wantedMissing.map((key) => FEATURE_NAMES[key].toLocaleLowerCase("tr")).join(" veya ")} olarak ayrıştırılmaz.
              </span>
            </p>
          )}
        </div>
      )}

      {classroom && (site.login !== "ok" || code === "classroom_policy" || site.classroomSyncAt) && (
        <div className="mt-4 rounded-2xl border border-rule px-4 py-3">
          <ClassroomConnect site={site} />
        </div>
      )}

      {site.announcements?.length > 0 && (
        <details className="mt-4 rounded-2xl border border-rule px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold">Duyurular ({site.announcements.length})</summary>
          <ul className="mt-2 divide-y divide-rule/60">
            {site.announcements.map(({ id, title, date, url }) => (
              <li key={id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                {url ? <a className="min-w-0 break-words underline-offset-4 hover:underline" target="_blank" rel="noreferrer" href={url}>{clean(title)}</a> : <span>{clean(title)}</span>}
                {date && <span className="shrink-0 text-xs text-ink-3">{date}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {busy === "test" && <p className="mt-4 text-sm text-ink-3" role="status">Bağlantı kontrol ediliyor…</p>}
      {site.lastTest && (
        <div className="mt-4">
          <TestResult test={site.lastTest} initialized={Boolean(site.lastSuccess)} historical={Boolean(site.lastTest?.at && site.lastSuccess > site.lastTest.at)} />
        </div>
      )}

      {adaptable && (
        <div className="mt-4">
          <AdaptationPanel site={site} code={code === "auth" ? null : code} unsupported={unsupported} defaultOpen={showAdapt} />
        </div>
      )}

      <footer className="mt-5 flex flex-wrap items-center gap-2 border-t border-rule pt-4">
        <Button size="sm" icon={RefreshCw} busy={busy === "test"} disabled={Boolean(busy)} onClick={() => onTest(site)}>
          Bağlantıyı test et
        </Button>
        <Button variant="outline" size="sm" icon={Pencil} disabled={Boolean(busy)} onClick={() => onEdit(site)}>
          Düzenle
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={site.paused ? Play : Pause}
          busy={busy === "pause"}
          disabled={Boolean(busy)}
          onClick={() => onTogglePause(site)}
        >
          {site.paused ? "Sürdür" : "Duraklat"}
        </Button>
        {!classroom && !adaptable && (
          <Button variant="ghost" size="sm" icon={Sparkles} onClick={() => setShowAdapt(true)}>
            Uyarlama promptu
          </Button>
        )}
        <Button variant="danger" size="sm" icon={Trash2} disabled={Boolean(busy)} onClick={() => onRemove(site)} className="ml-auto">
          Kaldır
        </Button>
      </footer>
    </Card>
  );
}

/* ------------------------------------------------------------------ Ekle / düzenle */
// Kaydetmeden önceki kaba ipucu; kayıttan sonra sunucunun yetenek matrisi gösterilir.
function roughCapabilities(type) {
  const L = (level, note) => ({ level, note });
  if (type === "moodle")
    return {
      announcements: L("full", "Moodle web servisi"),
      files: L("full", "Ders dosyaları"),
      assignments: L("full", "Ödevler ve teslim tarihleri"),
      exams: L("full", "Quiz ve takvim"),
      grades: L("full", "Not defteri"),
      pageChanges: L("none", "Gerekmez"),
    };
  return {
    announcements: L("none", "Yalnızca sayfa değişimi"),
    files: L("partial", "Sayfadaki dosya bağlantıları"),
    assignments: L("none", "Tanınmaz"),
    exams: L("none", "Tanınmaz"),
    grades: L("none", "Tanınmaz"),
    pageChanges: L("full", "Metin ve tablo değişimi"),
  };
}

function Field({ label, hint, children, htmlFor }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold tracking-wide text-ink-3 uppercase">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{hint}</p>}
    </div>
  );
}

const inputClass =
  "block w-full rounded-2xl border border-rule-strong bg-paper px-3.5 py-2.5 text-[0.9375rem] text-ink placeholder:text-ink-3/70 disabled:bg-wash disabled:text-ink-3";

function SiteSheet({ site, presets, onClose, onSave }) {
  const editing = Boolean(site);
  const locked = editing && site.origin !== "panel";
  const pagesLocked = locked || (editing && site.localPages);
  const available = presets.filter((p) => !p.added);
  const [preset, setPreset] = useState(site?.preset || null);
  const [name, setName] = useState(site?.name || "");
  const [url, setUrl] = useState(site?.url || "");
  const [type, setType] = useState(site?.type === "classroom" ? "webpages" : site?.type || "");
  const [pages, setPages] = useState((site?.pages || []).join("\n"));
  const [wants, setWants] = useState(site?.wants || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef(null);
  // Hata formun sonunda; uzun formda görünür alana kaydırılır (ekran okuyucu role="alert" ile duyurur).
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);

  const choosePreset = (p) => {
    if (!p) {
      setPreset(null);
      setType("");
      return;
    }
    setPreset(p.id);
    setName(p.name);
    setUrl(p.url);
    setType(p.type);
    setPages("");
  };
  const preview = editing && type === site.type ? site.capabilities : roughCapabilities(type);
  const missing = wants.filter((key) => preview[key]?.level === "none");

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!url.trim()) {
      setError("Eklemek istediğin sitenin adresini yaz.");
      return;
    }
    setBusy(true);
    try {
      await onSave({
        ...(editing ? { id: site.id } : {}),
        ...(preset && !editing ? { preset } : {}),
        name: name.trim(),
        base_url: url.trim(),
        ...(type ? { type } : {}),
        ...(type !== "moodle" && !pagesLocked
          ? { pages: pages.split(/\s*\n\s*/).map((v) => v.trim()).filter(Boolean) }
          : {}),
        wants,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={editing ? `${site.name} sitesini düzenle` : "Yeni site ekle"}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" form="site-form" icon={Check} busy={busy}>
            {editing ? "Kaydet" : "Ekle"}
          </Button>
        </>
      }
    >
      <form id="site-form" onSubmit={submit} className="space-y-6" noValidate>
        <Field
          label="Site adresi"
          htmlFor="site-url"
          hint={
            locked
              ? "Bu site bilgisayarındaki yapılandırmadan geliyor; adres ve tür orada değiştirilir."
              : "Ana sayfanın, ders sitesinin veya duyuru arşivinin adresini yapıştır."
          }
        >
          <input
            id="site-url"
            type="url"
            inputMode="url"
            className={inputClass}
            value={url}
            disabled={locked || Boolean(preset && !editing)}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="https://lms.ornek-universite.edu.tr"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>

        <details open={editing || undefined} className="rounded-2xl border border-rule px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold">İsteğe bağlı ayarlar</summary>
          <div className="mt-4 space-y-6">
            {!editing && available.length > 0 && (
              <fieldset>
                <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">Hazır seçenekler · isteğe bağlı</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[null, ...available].map((p) => {
                    const selected = (p?.id || null) === preset;
                    return (
                      <label
                        key={p?.id || "custom"}
                        className={cn(
                          "flex cursor-pointer flex-col gap-0.5 rounded-2xl border px-4 py-3 transition-colors",
                          selected ? "border-ink bg-card shadow-[0_0_0_3px_var(--accent-soft)]" : "border-rule hover:border-ink-3",
                        )}
                      >
                        <input type="radio" name="preset" checked={selected} onChange={() => choosePreset(p)} className="sr-only" />
                        <span className="text-sm font-semibold">{p ? p.name : "Kendi sitem"}</span>
                        <span className="text-xs leading-snug text-ink-3">
                          {p ? p.description : "Üniversitenin ders veya duyuru sitesinin adresini kendin gir."}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}

            <Field label="Site adı" htmlFor="site-name">
              <input
                id="site-name"
                className={inputClass}
                value={name}
                maxLength={60}
                autoComplete="off"
                placeholder="ör. Uzaktan Eğitim Sistemi"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <fieldset disabled={locked || Boolean(preset && !editing)}>
              <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">Bağlantı türü</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  ...(!editing ? [["", "Otomatik", "UniTakip bilinen siteler için hazır şablonu kullanır."]]: []),
                  ["moodle", "Moodle", "Moodle tabanlı ders siteleri. Duyuru, dosya, ödev, sınav ve not yapısal okunur. Bilgisayarında bir kez giriş (token) gerekir."],
                  ["webpages", "Genel web sayfası", "Sayfanın metni, tabloları ve dosya bağlantıları. Değişimi görür; not veya ödevin anlamını bilmez."],
                ].map(([id, label, text]) => (
                  <label
                    key={id}
                    className={cn(
                      "flex cursor-pointer flex-col gap-0.5 rounded-2xl border px-4 py-3 transition-colors",
                      type === id ? "border-ink bg-card shadow-[0_0_0_3px_var(--accent-soft)]" : "border-rule hover:border-ink-3",
                      "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70",
                    )}
                  >
                    <input type="radio" name="type" value={id} checked={type === id} onChange={() => setType(id)} className="sr-only" />
                    <span className="text-sm font-semibold">{label}</span>
                    <span className="text-xs leading-snug text-ink-3">{text}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {type !== "moodle" && (
              <Field
                label="İzlenecek sayfalar"
                htmlFor="site-pages"
                hint={
                  pagesLocked
                    ? "Sayfa listesi bilgisayarındaki yapılandırmadan geliyor; orada düzenlenir."
                    : "Her satıra bir adres; hepsi aynı alan adında olmalı (en fazla 10). Boş bırakırsan ana adres izlenir."
                }
              >
                {pagesLocked ? (
                  <p className="rounded-2xl bg-wash px-3.5 py-2.5 text-sm text-ink-3">{site?.pagesCount || 0} sayfa yerel yapılandırmada tanımlı.</p>
                ) : (
                  <textarea
                    id="site-pages"
                    rows={3}
                    className={cn(inputClass, "font-mono text-xs leading-relaxed")}
                    value={pages}
                    spellCheck={false}
                    placeholder={"https://obs.ornek-universite.edu.tr/duyurular\nhttps://obs.ornek-universite.edu.tr/takvim"}
                    onChange={(e) => setPages(e.target.value)}
                  />
                )}
              </Field>
            )}

            <fieldset>
              <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">Ne takip etmek istiyorsun?</legend>
              <div className="flex flex-wrap gap-2">
                {FEATURE_KEYS.map((key) => {
                  const on = wants.includes(key);
                  const level = LEVEL[preview[key]?.level] || LEVEL.none;
                  return (
                    <label
                      key={key}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-2 text-sm transition-colors",
                        on ? "border-ink bg-ink text-paper" : "border-rule-strong hover:border-ink-3",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={on}
                        onChange={() => setWants((list) => (on ? list.filter((k) => k !== key) : [...list, key]))}
                      />
                      {FEATURE_NAMES[key]}
                      <span className={cn("text-xs", on ? "text-paper/70" : "text-ink-3")}>{level.label}</span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-3">
                “Tam / Kısmi / Yok”, seçtiğin bağlantı türünün içerik takibi ve bildirim kapsamını gösterir. Dosya indirme ve ödev teslimi ayrı işlemlerdir.
              </p>
              {missing.length > 0 && (
                <p className="mt-3 flex items-start gap-2 rounded-2xl bg-warm-soft/60 px-4 py-3 text-sm leading-relaxed text-ink-2">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warm" aria-hidden />
                  <span>
                    {missing.map((key) => FEATURE_NAMES[key]).join(", ")} bu bağlantı türüyle okunamaz. Yine de ekleyebilirsin; sayfa değişimleri
                    bildirilir. Sonra karttaki “Claude / Codex ile uyarlama” ile siteye özel adaptör geliştirebilirsin.
                  </span>
                </p>
              )}
            </fieldset>

            {type === "moodle" && !locked && (
              <p className="rounded-2xl bg-wash/70 px-4 py-3 text-sm leading-relaxed text-ink-2">
                Moodle için ekledikten sonra bilgisayarında bir kez giriş yapman gerekir; kart sana komutu gösterecek. Şifren bu panele girilmez.
              </p>
            )}

          </div>
        </details>

        {error && (
          <p ref={errorRef} role="alert" className="rounded-2xl bg-hot-soft px-4 py-3 text-sm text-hot">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}

function RemoveSheet({ site, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      title={`${site.name} kaldırılsın mı?`}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            variant="danger"
            className="bg-hot-soft"
            icon={Trash2}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await onConfirm(site);
              if (!ok) setBusy(false);
            }}
          >
            Kaldır
          </Button>
        </>
      }
    >
      <ul className="space-y-2 text-[0.9375rem] leading-relaxed text-ink-2">
        <li>Bu siteye ait kayıtlar, bekleyen bildirimler ve son test sonucu panelden silinir.</li>
        <li>Arşive alınmış dosyalar ve geçmiş bildirim kayıtları kalır.</li>
        <li>
          Site bilgisayarındaki yapılandırmada da tanımlıysa bir sonraki aktarımda kendiliğinden geri eklenmez. Giriş bilgilerini tamamen
          silmek için yerel yapılandırmadan da kaldırıp paketi yeniden yükle.
        </li>
      </ul>
      <p className="mt-4 text-sm text-ink-3">İstersen sonra yeniden ekleyebilirsin; ilk kontrol yine sessiz başlangıç olur.</p>
    </Sheet>
  );
}

const GOOGLE_RESULTS = {
  linked: "Google hesabı bağlandı. Takip açıksa Classroom taraması başlayacak.",
  denied: "Google izni tamamlanmadı. Classroom kartından tekrar bağlanabilirsin.",
  expired: "Google bağlantısının süresi doldu. Classroom kartından yeniden başla.",
  policy: "Google, Classroom erişimine izin vermedi. İzinleri ve okul hesabı ayarlarını kontrol et.",
  setup: "Classroom için Google Cloud kurulumu gerekiyor.",
  busy: "Bir tarama sürdüğü için Google bağlantısı tamamlanamadı. Tarama bitince tekrar dene.",
  failed: "Google bağlantısı tamamlanamadı. Classroom kartından tekrar bağlanabilirsin.",
};

/* ------------------------------------------------------------------ Sayfa */
export function SitesPage({ data, active, onSiteAction }) {
  const sites = data.sites || [];
  const presets = data.presets || [];
  const [editing, setEditing] = useState(null); // null | "new" | site
  const [removing, setRemoving] = useState(null);
  const [googleResult] = useState(() => new URLSearchParams(window.location.hash.split("?")[1]).get("classroom"));
  useEffect(() => {
    if (googleResult) window.history.replaceState(window.history.state, "", "#/siteler");
  }, [googleResult]);
  const [busy, setBusy] = useState({}); // id → "test" | "pause"

  const run = async (site, kind, action, payload, options) => {
    setBusy((b) => ({ ...b, [site.id]: kind }));
    try {
      return await onSiteAction(action, payload, options);
    } finally {
      setBusy((b) => ({ ...b, [site.id]: null }));
    }
  };

  const healthy = sites.filter((s) => !s.paused && !s.error).length;
  return (
    <>
      <PageHeader
        eyebrow="Bağlantılar"
        title="Takip edilen siteler"
        actions={
          sites.length > 0 && (
            <Button icon={Plus} onClick={() => setEditing("new")}>
              Site ekle
            </Button>
          )
        }
      >
        {sites.length
          ? `${sites.length} site, ${healthy} tanesi sorunsuz. Her kartta o sitenin gerçekten neyi okuyabildiği yazar.`
          : "Henüz takip edilen bir site yok."}{" "}
        Adres eklediğinde bağlantı otomatik sınanır.
      </PageHeader>

      {Object.hasOwn(GOOGLE_RESULTS, googleResult) && (
        <p role="status" className="mb-4 rounded-2xl border border-rule bg-card px-4 py-3 text-sm text-ink-2">
          {GOOGLE_RESULTS[googleResult]}
        </p>
      )}

      {sites.length ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 xl:items-start">
          {sites.map((site) => (
            <SiteCard
              key={site.id}
              site={site}
              active={active}
              busy={busy[site.id]}
              onTest={(s) => run(s, "test", "test", { id: s.id })}
              onEdit={(s) => setEditing(s)}
              onTogglePause={(s) => run(s, "pause", s.paused ? "resume" : "pause", { id: s.id })}
              onRemove={(s) => setRemoving(s)}
            />
          ))}
        </div>
      ) : (
        <Card className="p-2">
          <Empty icon={Globe} title="İlk siteni ekle">
            Üniversitenin Moodle ders sitesini veya duyuru sayfasını ekleyebilirsin. Hazır şablonlar isteğe bağlıdır.
          </Empty>
          <div className="-mt-6 flex justify-center pb-10">
            <Button icon={Plus} onClick={() => setEditing("new")}>
              Site ekle
            </Button>
          </div>
        </Card>
      )}

      <Card className="mt-8 p-5 sm:p-7">
        <h2 className="font-display text-lg font-semibold">Nasıl çalışır?</h2>
        <dl className="mt-4 grid gap-5 sm:grid-cols-3">
          {[
            ["Herkese açık sayfalar", "Giriş istemeyen sayfalar panelden eklenir ve doğrudan bulutta kontrol edilir."],
            [
              "Giriş isteyen siteler",
              "Girişi bilgisayarında kendi tarayıcınla yaparsın; oturum şifreli olarak kendi Cloudflare hesabına aktarılır. Bulut tarayıcı açmaz, CAPTCHA veya SMS doğrulamasını aşmaz.",
            ],
            [
              "Okunamayan siteler",
              "Kartta sorun görürsen “Claude / Codex ile uyarlama” promptunu kopyala ve projeyi kendi bilgisayarında uyarlat.",
            ],
          ].map(([title, text]) => (
            <div key={title}>
              <dt className="text-sm font-semibold">{title}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-ink-3">{text}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {editing && (
        <SiteSheet
          site={editing === "new" ? null : editing}
          presets={presets}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            const result = await onSiteAction("save", payload, { throwOnError: true });
            setEditing(null);
            if (result?.site) {
              const id = result.site;
              void run({ id }, "test", "test", { id }, { retryBusy: true });
            }
            return result;
          }}
        />
      )}
      {removing && (
        <RemoveSheet
          site={removing}
          onClose={() => setRemoving(null)}
          onConfirm={async (site) => {
            const result = await onSiteAction("remove", { id: site.id });
            if (result) setRemoving(null);
            return Boolean(result);
          }}
        />
      )}
    </>
  );
}

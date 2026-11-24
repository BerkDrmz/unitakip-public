// Development-only fixtures. This Vite middleware is never part of the browser build.
// Site kaydı işlemleri gerçek motorun doğrulama/yetenek kodunu (src/sites.js) kullanır; ağ isteği yapılmaz.
import { isBartinAnnouncementArchive } from "../src/core.js";
import { isClassroomURL } from "../src/classroom.js";
import { PRESETS, capabilities, removeSite, saveSite, setPaused } from "../src/sites.js";

export function demoPlugin() {
  const now = Date.now();
  let authenticated = false;
  const platforms = [
    {
      id: "sanal",
      name: "Sanal Öğrenme",
      hostname: "sanalogrenme.bartin.edu.tr",
      url: "https://sanalogrenme.bartin.edu.tr",
      counts: { items: 68, assignments: 7, quizzes: 3, files: 24 },
    },
    {
      id: "ogreniyorum",
      name: "Öğreniyorum.net",
      hostname: "ogreniyorum.net",
      url: "https://ogreniyorum.net/mooc/",
      counts: { items: 15, assignments: 0, quizzes: 0, files: 0 },
    },
    {
      id: "ubys",
      name: "ÜBYS",
      hostname: "ubys.bartin.edu.tr",
      url: "https://ubys.bartin.edu.tr/",
      counts: { items: 22, assignments: 0, quizzes: 0, files: 0 },
    },
  ].map((p) => ({
    ...p,
    initialized: true,
    lastSuccess: now - 1800000,
    error: null,
    partialCount: 0,
  }));
  const data = {
    profile: { email: "ogrenci@example.com" },
    usage: { day: new Date().toISOString().slice(0, 10), runs: 31, requests: 214, peak: 38, deferred: 0, mails: 4, budget: 44, limit: 50, resuming: false,
      rowsWritten: 2140, yesterdayRows: 4870, rowsLimit: 100000, databaseSize: 3.4 * 1024 ** 2, storageLimit: 5 * 1024 ** 3 },
    liveEnabled: true,
    armed: true,
    checking: false,
    lastTick: now - 120000,
    lastFullAt: now - 1800000,
    nextFullAt: now + 1800000,
    intervalMinutes: 60,
    scheduledRuns: 8,
    pending: 0,
    archivedFiles: 0,
    platforms,
    tasks: [
      "Hafta 6 — Veri modelleme çalışması",
      "E-ticaret proje önerisi",
      "Algoritmalar kısa sınavı",
      "Haftalık değerlendirme",
      "Uygulama dosyalarının hazırlanması",
      "Ara sınav değerlendirmesi",
    ].map((title, i) => ({
      id: `sample-${i}`,
      platform: "sanal",
      title,
      kind: i === 2 || i === 5 ? "quiz" : "assignment",
      course: i % 2 ? "E-ticaret" : "Yönetim Bilişim Sistemleri",
      body: "Bu kayıt yalnızca yerel arayüz denemesi içindir.",
      dueAt: i === 5 ? now - 86400000 : now + (i + 1) * 86400000,
      url: "https://sanalogrenme.bartin.edu.tr",
    })),
    activity: [
      {
        id: "sample-1",
        platform: "system",
        type: "notice",
        title: "Haftalık durum raporu gönderildi",
        sentAt: now - 7200000,
      },
      {
        id: "sample-2",
        platform: "sanal",
        type: "test",
        title: "Ödev bildirimi denemesi gönderildi",
        sentAt: now - 14400000,
      },
    ],
  };
  data.exams = data.tasks.filter((t) => t.kind === "quiz");
  data.grades = [
    {
      id: "grade-a",
      platform: "ubys",
      kind: "grade",
      title: "Vize",
      course: "Algoritmalar",
      status: "published",
      fields: { "Sınav Türü": "Vize", Not: "85" },
      url: "https://ubys.bartin.edu.tr/",
    },
    {
      id: "grade-b",
      platform: "sanal",
      kind: "grade",
      title: "Ara sınav",
      course: "E-ticaret",
      status: "pending",
      fields: { Not: "-" },
      url: "https://sanalogrenme.bartin.edu.tr/",
    },
  ];
  data.grades.push({id:"grade-final",platform:"ubys",kind:"grade",title:"Final",course:"Algoritmalar",status:"pending",fields:{"Sütun 1":"Final :","Sütun 2":"-"},url:"https://ubys.bartin.edu.tr/"});
  data.materials = ["sanal", "ogreniyorum", "ubys"].flatMap((platform, i) => [
    {
      id: platform + "-pdf",
      platform,
      title: "Hafta 1 — Ders Sunumu.pdf",
      course: "Örnek Ders " + (i + 1),
      extension: "pdf",
      size: 1240000,
      url:
        platform === "ubys"
          ? "https://ubys.bartin.edu.tr/"
          : "https://" + platform + ".example.com/sunum.pdf",
      opensSource: platform === "ubys",
    },
    {
      id: platform + "-slides",
      platform,
      title: "Uygulama Slaytları.pptx",
      course: "Örnek Ders " + (i + 1),
      extension: "pptx",
      size: 980000,
      url: "https://" + platform + ".example.com/slayt.pptx",
    },
  ]);
  // Site kaydı: geçişle gelen üç hazır site + panelden eklenmiş genel bir duyuru sayfası
  const registry = {
    sites: [
      { id: "sanal", name: "Sanal Öğrenme", base_url: "https://sanalogrenme.bartin.edu.tr", type: "moodle", preset: "bartin-sanal", pages: [], wants: [], origin: "migrated" },
      { id: "ogreniyorum", name: "Öğreniyorum.net", base_url: "https://ogreniyorum.net/mooc/", type: "webpages", preset: "bartin-ogreniyorum", pages: [{ id: "derskayitol", url: "https://ogreniyorum.net/mooc/index.php?do=derskayitol", kind: "course_materials" }], wants: ["files"], origin: "migrated" },
      { id: "ubys", name: "ÜBYS", base_url: "https://ubys.bartin.edu.tr/", type: "webpages", preset: "bartin-ubys", pages: [{ id: "notlar", url: "https://ubys.bartin.edu.tr/AIS/Student/Grade", kind: "grade" }, { id: "dersler", url: "https://ubys.bartin.edu.tr/AIS/Student/Class/ClassDetail", kind: "course_materials" }], wants: ["grades"], origin: "migrated" },
      { id: "bolum-duyurulari", name: "Bölüm Duyuruları", base_url: "https://muhendislik.ornek-universite.edu.tr/duyurular", type: "webpages", preset: null, pages: [{ id: "sayfa-1", url: "https://muhendislik.ornek-universite.edu.tr/duyurular", kind: "page" }], wants: ["announcements", "exams"], origin: "panel" },
    ],
    platforms: {}, pending: {}, fileJobs: {}, removedSites: {},
    siteTests: {
      "bolum-duyurulari": { at: now - 3600000, ok: true, code: null, items: 3, counts: { pageChanges: 1, files: 2 }, preview: [
        { kind: "files", title: "2026-2027 Güz Final Programı.pdf", course: "" },
        { kind: "files", title: "Staj Başvuru Formu.docx", course: "" },
        { kind: "pageChanges", title: "Bölüm Duyuruları", course: "" },
      ], scopes: { complete: 1, failed: 0 } },
    },
  };
  const errors = { ogreniyorum: "auth" };
  const counts = { sanal: 68, ogreniyorum: 15, ubys: 22, "bolum-duyurulari": 3 };
  function needsLogin(site) {
    if (registry.platforms[site.id]?.demoLoginURL === site.base_url) return false;
    return errors[site.id] === "auth" || (site.type === "moodle" && site.origin === "panel");
  }
  function syncSites() {
    data.sites = registry.sites.map((site) => {
      const u = new URL(site.base_url);
      const test = registry.siteTests[site.id];
      const classroom = isClassroomURL(site.base_url);
      const login = classroom || needsLogin(site) ? "missing" : site.type === "moodle" || site.preset ? "ok" : "not_needed";
      return {
        id: site.id, name: site.name, url: u.origin + u.pathname, hostname: u.hostname, type: classroom ? "classroom" : site.type, preset: site.preset || null,
        origin: site.origin || "panel", paused: Boolean(site.paused), login, error: site.paused ? null : classroom ? "classroom_setup" : errors[site.id] || null,
        ...(classroom ? { googleReady: false } : {}),
        wants: site.wants || [], capabilities: capabilities(site), pagesCount: (site.pages || []).length,
        localPages: site.origin !== "panel" && site.type === "webpages",
        pages: (site.origin || "panel") === "panel" ? (site.pages || []).map((p) => p.url) : [],
        lastSuccess: counts[site.id] && site.id !== "ogreniyorum" ? now - 1800000 : site.id === "ogreniyorum" ? now - 3 * 86400000 : null,
        partialCount: 0, items: counts[site.id] || 0, lastTest: test || null,
      };
    });
    data.platforms = data.sites.map((site) => ({
      id: site.id, name: site.name, hostname: site.hostname, url: site.url, paused: site.paused, error: site.error,
      initialized: Boolean(site.lastSuccess), lastSuccess: site.lastSuccess, partialCount: 0, counts: { items: site.items },
    }));
    data.presets = Object.entries(PRESETS).map(([id, preset]) => ({
      id, name: preset.name, url: preset.base_url, type: preset.type, description: preset.description,
      added: registry.sites.some((site) => site.preset === id || site.base_url === preset.base_url),
    }));
  }
  function demoTest(site) {
    const at = Date.now();
    const host = new URL(site.base_url).hostname;
    if (isClassroomURL(site.base_url)) return { id: site.id, at, ok: false, code: "classroom_setup", items: 0, counts: {}, preview: [], scopes: { complete: 0, failed: 0 } };
    if (needsLogin(site)) return { id: site.id, at, ok: false, code: "auth", items: 0, counts: {}, preview: [], scopes: { complete: 0, failed: 0 } };
    if (errors[site.id]) return { id: site.id, at, ok: false, code: errors[site.id], items: 0, counts: {}, preview: [], scopes: { complete: 0, failed: 1 } };
    if (host.startsWith("yok.") || host.includes("kapali")) return { id: site.id, at, ok: false, code: "network", items: 0, counts: {}, preview: [], scopes: { complete: 0, failed: 1 } };
    if (host.includes("spa")) return { id: site.id, at, ok: false, code: "site", items: 0, counts: {}, preview: [], scopes: { complete: 0, failed: 1 } };
    const preview = (site.pages || []).some((page) => isBartinAnnouncementArchive(page.url))
      ? [{ kind: "announcements", title: "Örnek duyuru: Dönem etkinlik takvimi", course: "" }]
      : site.type === "moodle"
      ? [{ kind: "assignments", title: "Hafta 6 — Veri modelleme çalışması", course: "Yönetim Bilişim Sistemleri" }, { kind: "announcements", title: "Ara sınav salonları açıklandı", course: "E-ticaret" }, { kind: "grades", title: "Kısa sınav 2", course: "Algoritmalar" }]
      : [{ kind: "files", title: "Ders Programı.pdf", course: "" }, { kind: "pageChanges", title: site.name, course: "" }];
    const result = { id: site.id, at, ok: true, code: null, items: preview.length, counts: {}, preview, scopes: { complete: 1, failed: 0 } };
    for (const item of preview) result.counts[item.kind] = (result.counts[item.kind] || 0) + 1;
    return result;
  }
  syncSites();
  data.activity.push({
    id: "grade-notice",
    platform: "ubys",
    type: "updated",
    category: "grade",
    title: "Vize notu güncellendi",
    course: "Algoritmalar",
    detail: "Not: - → 85",
    sentAt: now - 60000,
  });
  // UNITAKIP_UI_DEMO_RICH=1: tasarım değerlendirmesi için gerçekçi yoğunlukta örnek veri (yalnızca yerel)
  if (process.env.UNITAKIP_UI_DEMO_RICH === "1") {
    const D = 86400000, H = 3600000;
    const courses = [
      ["sanal", "Görsel Programlama I"],
      ["sanal", "Nesneye Dayalı Programlama I"],
      ["sanal", "Veri Yapıları"],
      ["ubys", "İnsan Hakları ve Demokrasi Eğitimi"],
      ["ogreniyorum", "Türk Dili I"],
    ];
    const t = (id, platform, title, kind, course, dueAt) => ({
      id, platform, title, kind, course, dueAt, url: "https://sanalogrenme.bartin.edu.tr",
      body: kind === "assignment" ? "Çözümlerini tek bir PDF dosyası olarak yükle. Geç teslimler değerlendirilmez." : "Sınav 40 dakika sürer, tek deneme hakkın var.",
    });
    data.tasks = [
      t("r1", "sanal", "Yıldız Ödevi", "assignment", courses[0][1], now + 5 * H),
      t("r2", "sanal", "Otomatik Tıklama Programı — Laboratuvar Uygulaması", "assignment", courses[0][1], now + D + 2 * H),
      t("r3", "sanal", "Hesaplama Kaydetme", "assignment", courses[0][1], now + D + 6 * H),
      t("r4", "sanal", "Rekürsif Üs Bulma", "assignment", courses[1][1], now + 2 * D),
      t("r5", "sanal", "Hafta 6 Kısa Sınav", "quiz", courses[2][1], now + 3 * D),
      t("r6", "sanal", "Ders Uygulaması — 1", "assignment", courses[1][1], now + 5 * D),
      t("r7", "sanal", "Bağlı Liste Uygulaması", "assignment", courses[2][1], now + 8 * D),
      t("r8", "sanal", "Ara Sınav Hazırlık Quiz", "quiz", courses[2][1], now + 11 * D),
      t("r9", "sanal", "Sayı Dönüştürücü", "assignment", courses[0][1], now + 13 * D),
      t("r10", "sanal", "Üçgen Eşitsizliği Ödevi", "assignment", courses[0][1], now - 2 * D),
      t("r11", "sanal", "Hafta 1 Quiz: Python'a Giriş", "quiz", courses[1][1], now - 9 * D),
      t("r12", "sanal", "Proje Konusu Bildirimi", "assignment", courses[1][1], null),
    ];
    data.exams = [
      ...data.tasks.filter((x) => x.kind === "quiz"),
      { id: "ann1", platform: "ubys", kind: "announcement", title: "Vize sınav programı yayımlandı", course: courses[3][1], dueAt: now + 9 * D, url: "https://ubys.bartin.edu.tr/" },
    ];
    const g = (id, platform, course, label, value, status) => ({
      id, platform, kind: "grade", course, title: `${course} — ${label} :`, status,
      fields: { "Sütun 1": `${label} :`, "Sütun 2": value, Aralık: "0&ndash;100" },
      url: "https://ubys.bartin.edu.tr/",
    });
    data.grades = [
      g("g1", "ubys", "Algoritmalar", "Vize", "85", "published"),
      g("g2", "ubys", "Algoritmalar", "Final", "-", "pending"),
      g("g3", "ubys", "İnsan Hakları ve Demokrasi Eğitimi", "Vize", "72", "published"),
      g("g4", "ubys", "İnsan Hakları ve Demokrasi Eğitimi", "Final", "-", "pending"),
      g("g5", "ubys", "Türk Dili I", "Vize", "90", "published"),
      g("g6", "ubys", "Türk Dili I", "Final", "-", "pending"),
      g("g7", "sanal", "Görsel Programlama I", "Yıldız Ödevi", "-", "pending"),
      g("g8", "sanal", "Görsel Programlama I", "Hafta 1 Quiz", "8,00", "published"),
      g("g9", "sanal", "Nesneye Dayalı Programlama I", "Ders toplamı", "64,50", "published"),
    ];
    data.materials = courses.flatMap(([platform, course], ci) =>
      Array.from({ length: [9, 5, 4, 7, 3][ci] }, (_, i) => ({
        id: `m${ci}-${i}`, platform, course,
        title: `${course.split(" ")[0]} ${i + 1}. Hafta ${i % 3 === 1 ? "Uygulama Slaytı.pptx" : "Ders Notları.pdf"}`,
        extension: i % 3 === 1 ? "pptx" : "pdf", size: 400000 + i * 230000,
        url: "https://sanalogrenme.bartin.edu.tr", opensSource: platform === "ubys",
        publishedAt: now - (i * 4 + ci) * D,
      })),
    );
    data.activity = [
      { id: "a1", platform: "ubys", type: "updated", category: "grade", title: "Vize notu açıklandı", course: "Algoritmalar", detail: "Not: — → 85", sentAt: now - 40 * 60000 },
      { id: "a2", platform: "sanal", type: "new", category: "material", title: "Yeni dosya: Görsel 1. Hafta Ders Notları.pdf", course: courses[0][1], sentAt: now - 3 * H },
      { id: "a3", platform: "sanal", type: "new", category: "exam", title: "Yeni kısa sınav: Hafta 6 Kısa Sınav", course: courses[2][1], sentAt: now - 5 * H },
      { id: "a4", platform: "sanal", type: "updated", category: "other", title: "Teslim tarihi değişti: Rekürsif Üs Bulma", course: courses[1][1], detail: "Teslim tarihi: 10.11.2026 23:59 → 11.11.2026 23:59", sentAt: now - D - 2 * H },
      { id: "a5", platform: "system", type: "notice", title: "Haftalık durum raporu gönderildi", sentAt: now - D - 5 * H },
      { id: "a6", platform: "ogreniyorum", type: "new", category: "material", title: "Yeni sunum: Türk Dili 3. Hafta", course: "Türk Dili I", sentAt: now - 3 * D },
    ];
    data.pending = 1;
  }
  return {
    name: "local-preview-only",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (
          !url.pathname.startsWith("/api/") &&
          !url.pathname.startsWith("/auth/")
        )
          return next();
        res.setHeader("Content-Type", "application/json");
        const reply = (value, status = 200) => {
          res.statusCode = status;
          res.end(JSON.stringify(value));
        };
        if (url.pathname === "/auth/code")
          return reply({ ok: true, retryAfter: 1 });
        if (url.pathname === "/auth/verify") {
          let text = "";
          for await (const chunk of req) text += chunk;
          if (JSON.parse(text).code !== "123456")
            return reply({ error: "invalid_code" }, 400);
          authenticated = true;
          return reply({ ok: true });
        }
        if (url.pathname === "/auth/logout") {
          authenticated = false;
          return reply({ ok: true });
        }
        if (!authenticated) return reply({ error: "unauthorized" }, 401);
        if (url.pathname === "/api/dashboard") {
          syncSites();
          return reply(data);
        }
        if (url.pathname.startsWith("/api/sites/")) {
          let text = "";
          for await (const chunk of req) text += chunk;
          const payload = text ? JSON.parse(text) : {};
          const action = url.pathname.slice("/api/sites/".length);
          await new Promise((r) => setTimeout(r, action === "test" ? 900 : 250));
          try {
            if (action === "save") return reply({ ok: true, site: saveSite(registry, payload).id });
            if (action === "pause" || action === "resume") {
              setPaused(registry, payload.id, action === "pause");
              return reply({ ok: true });
            }
            if (action === "remove") {
              removeSite(registry, payload.id);
              return reply({ ok: true });
            }
            if (action === "login") {
              // Demo: hiçbir siteye bağlanmaz. ÜBYS benzeri siteler SMS kodu ister; kod 123456, şifre "hatali" ise reddedilir.
              const site = registry.sites.find((entry) => entry.id === payload.id);
              if (!site) return reply({ error: "config" }, 400);
              if (payload.password === "hatali") return reply({ error: "credentials" }, 400);
              if (/ubys/i.test(site.base_url)) {
                if (payload.code === undefined) return reply({ ok: true, step: "code" });
                if (payload.code !== "123456") return reply({ error: "code" }, 400);
              }
              (registry.platforms[site.id] ||= {}).demoLoginURL = site.base_url;
              if (errors[site.id] === "auth") delete errors[site.id];
              if (registry.siteTests[site.id]?.code === "auth") delete registry.siteTests[site.id];
              return reply({ ok: true, step: "done" });
            }
            if (action === "test") {
              const site = registry.sites.find((entry) => entry.id === payload.id);
              if (!site) return reply({ error: "config", message: "Site bulunamadı." }, 400);
              const result = demoTest(site);
              registry.siteTests[site.id] = result;
              return reply(result);
            }
            return reply({ error: "not_found" }, 404);
          } catch (error) {
            return reply({ error: "config", message: String(error.message).slice(0, 200) }, 400);
          }
        }
        if (url.pathname === "/api/check") {
          data.checking = true;
          setTimeout(() => {
            data.checking = false;
            data.lastFullAt = Date.now();
            data.lastTick = Date.now();
          }, 2000);
        }
        if (url.pathname === "/api/pause") data.armed = false;
        if (url.pathname === "/api/resume") data.armed = true;
        if (url.pathname === "/api/settings") {
          let text = "";
          for await (const chunk of req) text += chunk;
          data.intervalMinutes = JSON.parse(text).intervalMinutes;
        }
        if (url.pathname === "/api/test-email")
          data.activity.unshift({
            id: `demo-${Date.now()}`,
            platform: url.searchParams.get("platform"),
            type: "test",
            title: "Ödev bildirimi denemesi gönderildi",
            sentAt: Date.now(),
          });
        return reply({ ok: true, sent: true });
      });
    },
  };
}

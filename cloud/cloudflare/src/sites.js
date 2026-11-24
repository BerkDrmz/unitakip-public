// Değişken site kaydı: her kurulum kendi sitelerini panelden veya yerel yapılandırmadan ekler.
//
// Tanım (ad, adres, tür, sayfalar, istenen özellikler, duraklatma) şifreli takip durumunda (state.sites)
// tutulur. Kimlik bilgileri (Moodle tokenı, oturum çerezleri) YALNIZCA Cloudflare Secrets'taki
// yapılandırmadan (config.platforms[id]) gelir; panel bunları asla almaz ve geri döndürmez.
import { defaultWebPage, isBartinAnnouncementArchive, MonitorError } from './core.js';
import { hash } from './hash.js';
import { CLASSROOM_HOME, isClassroomURL } from './classroom.js';
import { brokerToken } from './classroom-broker-client.js';

export const CLASSROOM_SCRIPT_STALE = 3 * 60 * 60 * 1000;
export const MAX_SITES = 12;
export const MAX_PAGES = 10; // panelden eklenen bir sitenin sayfa sayısı
// Yerel keşifle gelen sayfa listeleri daha uzun olabilir. Üst sınır, bir sitenin tek çalışmanın dış istek payına
// (Workers Free: 50; bkz. core.js SUBREQUEST_BUDGET) sığmasını garanti eder.
export const MAX_SITE_PAGES = 40;
export const FEATURES = ['announcements', 'files', 'assignments', 'exams', 'grades'];
const TYPES = new Set(['moodle', 'webpages']);
// Tanımda saklanabilen, gizli olmayan izleme ayarları (yerel prepare.py çıktısından gelir).
const DEFINITION_KEYS = ['features', 'course_classification', 'include_course_ids', 'exclude_course_ids', 'calendar_days_ahead',
  'discussions_per_forum', 'logged_out_markers', 'session_check_url', 'download_files', 'download_existing_files', 'notify_removed'];

/** Hazır şablonlar: zorunlu değildir, yalnızca "Site ekle" penceresinde seçenek olarak sunulur. */
export const PRESETS = {
  'google-classroom': {
    name: 'Google Classroom', base_url: CLASSROOM_HOME, type: 'webpages', login: 'google',
    description: 'Google hesabını bağlayarak derslerini, ödevlerini ve duyurularını izle.',
  },
  'bartin-sanal': {
    name: 'Sanal Öğrenme (Bartın Üni.)', base_url: 'https://sanalogrenme.bartin.edu.tr', type: 'moodle', login: 'token',
    description: 'Moodle web servisi: duyuru, dosya, ödev, sınav ve not.',
  },
  'bartin-ogreniyorum': {
    name: 'Öğreniyorum.net', base_url: 'https://ogreniyorum.net/mooc/', type: 'webpages', login: 'session',
    pages: [
      'https://ogreniyorum.net/mooc/index.php?do=derskayitol',
      { id: 'odevler', url: 'https://ogreniyorum.net/mooc/index.php?do=odevler', kind: 'assignment', content_selector: '.content' },
      { id: 'bildirimler', url: 'https://ogreniyorum.net/mooc/index.php?do=bildirimler&durum=all', kind: 'announcement', content_selector: '.content',
        track_text: false, track_links: false, ignore_columns: ['Durum', 'Islem'], key_columns: [0, 1, 2] },
      { id: 'platform-duyurusu', url: 'https://ogreniyorum.net/mooc/index.php?do=anasayfa', kind: 'announcement', title: 'Öğreniyorum.net duyurusu',
        content_selector: '.announcement-card', track_tables: false, track_links: false },
      { id: 'sinav-takvimi', url: 'https://ogreniyorum.net/mooc/index.php?do=kacgunkaldi', kind: 'event' },
    ],
    logged_out_markers: ['name="sifre"'],
    description: 'Ders içerikleri, ödevler, bildirimler/duyuru ve sınav dönemi tarihleri. Not sayfası yok.',
  },
  'bartin-ubys': {
    name: 'ÜBYS (Bartın Üni.)', base_url: 'https://ubys.bartin.edu.tr/', type: 'webpages', login: 'session',
    pages: [], logged_out_markers: ['id="loginForm"', 'data-ajax-url="/Account/Login"'],
    description: 'Not tablosu; ders sayfalarından materyal, ödev, duyuru ve çevrimiçi sınavlar. İzlenecek sayfalar yerel keşifle belirlenir (SMS doğrulaması nedeniyle giriş yerelde).',
  },
};
const PRESET_HOSTS = { 'classroom.google.com': 'google-classroom', 'sanalogrenme.bartin.edu.tr': 'bartin-sanal', 'ogreniyorum.net': 'bartin-ogreniyorum', 'ubys.bartin.edu.tr': 'bartin-ubys' };

/** Panel ve yerel yapılandırma girdisi için ortak adres doğrulaması (SSRF ve gizli bilgi koruması). */
export function publicSiteURL(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new MonitorError('config', 'Adres geçerli bir URL değil.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new MonitorError('config', 'Yalnızca https:// adresleri desteklenir.');
  if (url.username || url.password || url.port) throw new MonitorError('config', 'Adreste kullanıcı adı, şifre veya port olamaz.');
  if (!host.includes('.') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|example|invalid)$/.test(host)) {
    throw new MonitorError('config', 'Yalnızca internetteki herkese açık alan adları eklenebilir.');
  }
  return url;
}

const slug = (value) => String(value || '').toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'site';
export const validId = (id) => /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(String(id || ''));
export function presetForURL(base) {
  try { return PRESET_HOSTS[new URL(base).hostname] || null; } catch { return null; }
}

function pageList(type, base, pages, limit = MAX_PAGES) {
  if (type === 'moodle') return [];
  const list = pages?.length ? pages : [defaultWebPage(base)];
  // Sessizce kırpmak, listenin sonundaki sayfaların hiç izlenmemesine yol açıyordu; fazlası açıkça reddedilir.
  if (list.length > limit) throw new MonitorError(limit === MAX_PAGES ? 'config' : 'quota', `Bir sitede en fazla ${limit} sayfa izlenebilir.`);
  return list.map((entry, index) => {
    const value = typeof entry === 'string' ? { url: entry } : entry;
    const url = publicSiteURL(value.url);
    if (url.hostname !== new URL(base).hostname) throw new MonitorError('config', 'İzlenecek sayfalar sitenin kendi alan adında olmalı.');
    const kind = ['page', 'grade', 'attendance', 'event', 'announcement', 'assignment', 'course_materials'].includes(value.kind) ? value.kind : 'page';
    return { ...value, id: String(value.id || `sayfa-${index + 1}`).slice(0, 60), url: url.href, kind };
  });
}

/** Sondaki eğik çizgi farkı aynı adres sayılır (yerel YAML ile panel girişi küçük biçim farkları taşıyabilir). */
export const sameBase = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Yerel paket bu site için kendi sayfa listesini veriyorsa (ör. keşifle bulunan not sayfası) panel listesi yerine o kullanılır. */
export const localPages = (site, local) => Boolean(site.type === 'webpages' && local && sameBase(local.base_url, site.base_url) && local.pages?.length);

/** Mevcut kurulumun Secrets yapılandırmasından kayıt tanımı üretir (geçiş). */
function definitionFromConfig(id, platform, origin, now) {
  const definition = {
    id, name: String(platform.display_name || id).slice(0, 60), base_url: platform.base_url, type: platform.type,
    preset: presetForURL(platform.base_url), pages: platform.type === 'webpages' ? (platform.pages || []) : [],
    wants: [], paused: false, origin, createdAt: now, updatedAt: now,
  };
  for (const key of DEFINITION_KEYS) if (platform[key] !== undefined) definition[key] = platform[key];
  return definition;
}

/**
 * Kayıt + Secrets → çalışma yapılandırması. Durum yoksa (ilk açılış/eski kurulum) mevcut
 * platformlar aynı kimliklerle kayda alınır; böylece önceki kayıtlar, kapsamlar ve geçmiş korunur.
 * Yerelde eklenip Secrets'a aktarılan yeni siteler kendiliğinden kayda eklenir (panelden
 * kaldırılanlar hariç). Durumu değiştirdiyse `changed` true döner; GET isteklerinde kaydedilmez.
 */
export function ensureSites(state, config, now = Date.now()) {
  let changed = false;
  if (!Array.isArray(state.sites)) {
    state.sites = Object.entries(config.platforms || {}).map(([id, platform]) => definitionFromConfig(id, platform, 'migrated', now));
    state.removedSites ||= {};
    changed = true;
  }
  state.removedSites ||= {};
  for (const [id, platform] of Object.entries(config.platforms || {})) {
    if (state.sites.some((site) => site.id === id) || state.removedSites[id] || state.sites.length >= MAX_SITES) continue;
    state.sites.push(definitionFromConfig(id, platform, 'local', now));
    changed = true;
  }
  // Yerel paket güncellendiyse teknik ayarlar (sayfalar, oturum işaretleri) oradan yenilenir. Panelde eklenen
  // bir site için bilgisayarda oturum/keşif yapıldıysa (aynı kimlik ve adres) yerel tanım da aynı şekilde uygulanır.
  for (const site of state.sites) {
    const local = config.platforms?.[site.id];
    if (!local || local.type !== site.type || !sameBase(site.base_url, local.base_url)) continue;
    for (const key of DEFINITION_KEYS) if (local[key] !== undefined && JSON.stringify(site[key]) !== JSON.stringify(local[key])) { site[key] = local[key]; changed = true; }
    if (site.type === 'webpages' && local.pages?.length && JSON.stringify(site.pages) !== JSON.stringify(local.pages)) { site.pages = local.pages; changed = true; }
  }
  return changed;
}

/** Secrets'taki kimlik bilgisinin özeti: panel girişinin hangi pakete göre yapıldığını ayırt eder. */
export const credentialHash = (local) => hash({ token: local?.token || '', cookies: local?.cookies || [] });

/**
 * Panelden yapılan yeniden girişin sonucu (state.platforms[id].login). Bilgisayardan yeni bir paket
 * yüklenirse (Secrets değişirse) panel girişi geçersizleşir ve yerel paket önceliklidir.
 */
export function panelLogin(state, site, local) {
  const login = state?.platforms?.[site.id]?.login;
  if (!login || !sameBase(login.base_url, site.base_url)) return null;
  return login.revision === credentialHash(local && sameBase(local.base_url, site.base_url) ? local : null) ? login : null;
}

/** Bir sitenin kimlik bilgisi durumu. Değerler asla döndürülmez. */
export function credentialStatus(site, local, login = null) {
  // Kimlik bilgisi yalnızca aynı adres için geçerlidir (effectiveSites ile aynı kural).
  const linked = local && sameBase(local.base_url, site.base_url) ? local : null;
  if (site.type === 'moodle') return linked?.token || login?.token ? 'ok' : 'missing';
  if (login?.cookies?.length) return 'ok';
  const preset = site.preset && PRESETS[site.preset];
  if (linked?.cookies?.length) return 'ok';
  return preset?.login === 'session' ? 'missing' : 'not_needed';
}

/** Takip motoruna verilecek etkin site yapılandırması (duraklatılanlar ve geçersizler ayrı listelenir). */
export function classroomConnection(state, site, config) {
  const connection = state.platforms?.[site.id]?.classroom;
  if (connection?.broker) return connection.broker === config.classroomBroker && brokerToken(connection.ticket) && brokerToken(connection.key) ? connection : null;
  return connection?.refreshToken && config.classroomOAuth?.id && connection.clientId === config.classroomOAuth.id
    ? connection : null;
}

export function effectiveSites(state, config) {
  const active = {}, problems = {};
  for (const site of state.sites || []) {
    if (site.paused) continue;
    const local = config.platforms?.[site.id] || {};
    try {
      publicSiteURL(site.base_url);
      if (isClassroomURL(site.base_url)) {
        const bridge = state.classroomBridges?.[site.id];
        if (bridge?.receivedAt) {
          if (Date.now() - bridge.receivedAt > CLASSROOM_SCRIPT_STALE) problems[site.id] = 'classroom_sync';
          continue;
        }
        const connection = classroomConnection(state, site, config);
        if (bridge && !connection) throw new MonitorError('classroom_waiting', 'İlk Apps Script aktarımı bekleniyor.');
        if (!config.classroomOAuth && !config.classroomBroker) throw new MonitorError('classroom_setup', 'Classroom bağlantısı kurulum gerektiriyor.');
        if (!connection) throw new MonitorError('auth', 'Google hesabını bağla.');
        active[site.id] = { type: 'classroom', base_url: CLASSROOM_HOME, display_name: site.name, oauth: config.classroomOAuth, connection };
        continue;
      }
      if (!TYPES.has(site.type)) throw new MonitorError('config', 'Bağlantı türü desteklenmiyor.');
      const credentials = {};
      if (sameBase(local.base_url, site.base_url)) {
        if (local.token) credentials.token = local.token;
        if (local.cookies) credentials.cookies = local.cookies;
        if (local.user_agent) credentials.user_agent = local.user_agent;
      }
      const login = panelLogin(state, site, local);
      if (login?.token) credentials.token = login.token;
      if (login?.cookies?.length) credentials.cookies = login.cookies;
      if (site.type === 'moodle' && !credentials.token) throw new MonitorError('auth', 'Moodle tokenı yok; bilgisayarında giriş yapıp bulut paketini güncellemelisin.');
      if (credentials.cookies) {
        const host = new URL(site.base_url).hostname;
        if (credentials.cookies.some((cookie) => String(cookie.domain || '').replace(/^\./, '') !== host)) throw new MonitorError('config', 'İlgisiz site çerezi engellendi.');
      }
      const pages = site.type === 'webpages' ? pageList('webpages', site.base_url, site.pages, MAX_SITE_PAGES) : [];
      if (site.type === 'webpages' && !pages.length) throw new MonitorError('config', 'İzlenecek sayfa yok; yerel keşifle sayfa belirlenmeli.');
      active[site.id] = {
        ...Object.fromEntries(DEFINITION_KEYS.filter((key) => site[key] !== undefined).map((key) => [key, site[key]])),
        base_url: site.base_url, type: site.type, display_name: site.name, pages, ...credentials,
        auto_announcements: site.origin === 'panel' && !site.preset,
        logged_out_markers: site.logged_out_markers || PRESETS[site.preset]?.logged_out_markers || [],
      };
    } catch (error) {
      problems[site.id] = error.code || 'config';
    }
  }
  return { active, problems };
}

/** Panelden gelen ekleme/düzenleme isteğini doğrular ve kayda uygular. */
export function saveSite(state, payload, now = Date.now()) {
  state.sites ||= []; state.removedSites ||= {};
  const existing = payload.id ? state.sites.find((site) => site.id === payload.id) : null;
  if (payload.id && !existing) throw new MonitorError('config', 'Site bulunamadı.');
  const selected = payload.preset && PRESETS[payload.preset] ? payload.preset : null;
  const suppliedAddress = String(payload.base_url || PRESETS[selected]?.base_url || '').trim();
  const address = !existing && suppliedAddress && !/^[a-z][a-z\d+.-]*:/i.test(suppliedAddress) ? `https://${suppliedAddress}` : suppliedAddress;
  const base = publicSiteURL(existing && existing.origin !== 'panel' ? existing.base_url : address);
  const classroom = isClassroomURL(base.href);
  const preset = classroom ? 'google-classroom' : selected || (!existing && !payload.type ? presetForURL(base.href) : null);
  const template = preset ? PRESETS[preset] : {};
  const name = String(payload.name || template.name || existing?.name || base.hostname.slice(0, 60)).trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw new MonitorError('config', 'Site adı 2–60 karakter olmalı.');
  const type = classroom ? 'webpages' : existing && existing.origin !== 'panel' ? existing.type : (payload.type || template.type || existing?.type || 'webpages');
  if (!TYPES.has(type)) throw new MonitorError('config', 'Bağlantı türü geçersiz.');
  const canonical = classroom && !existing ? new URL(CLASSROOM_HOME) : preset && !selected && !existing ? new URL(template.base_url) : base;
  const baseURL = type === 'moodle' ? canonical.origin + canonical.pathname.replace(/\/+$/, '') : canonical.href;
  // Yerel yapılandırmadan gelen sitelerin sayfaları (seçiciler, sayfa türleri) panelden ezilmez.
  const rawPages = Array.isArray(payload.pages) && (!existing || existing.origin === 'panel') ? payload.pages.filter((value) => typeof value === 'string' && value.trim()) : null;
  const keepPages = !rawPages?.length && existing?.pages?.length && existing.type === type && sameBase(existing.base_url, baseURL);
  const pages = type === 'webpages' ? pageList(type, baseURL, rawPages?.length ? rawPages : (keepPages ? existing.pages : template.pages), keepPages ? MAX_SITE_PAGES : MAX_PAGES) : [];
  const wants = Array.isArray(payload.wants) ? FEATURES.filter((feature) => payload.wants.includes(feature)) : (existing?.wants || []);
  if (existing) {
    // Adres veya tür değiştiyse bu artık başka bir kaynaktır: eski sitenin kayıtları yeni içerikle
    // karşılaştırılırsa her şey "yeni/güncellendi" sayılır ve toplu bildirim gider. Kayıtlar sıfırlanır,
    // böylece ilk kontrol yeni eklenen bir sitedeki gibi sessiz başlangıç olur.
    const moved = existing.type !== type || !sameBase(existing.base_url, baseURL);
    Object.assign(existing, { name, base_url: baseURL, type, pages, wants, updatedAt: now });
    if (moved) {
      existing.preset = presetForURL(baseURL);
      const markers = existing.preset ? PRESETS[existing.preset].logged_out_markers : null;
      if (markers) existing.logged_out_markers = markers; else delete existing.logged_out_markers;
      clearSiteRecords(state, existing.id);
    }
    return existing;
  }
  if (classroom && state.sites.some((site) => isClassroomURL(site.base_url))) throw new MonitorError('config', 'Google Classroom zaten ekli. Kartından Google hesabını bağlayabilirsin.');
  if (state.sites.length >= MAX_SITES) throw new MonitorError('config', `En fazla ${MAX_SITES} site eklenebilir.`);
  let id = validId(payload.slug) ? payload.slug : slug(preset ? preset.replace(/^bartin-/, '') : name);
  if (preset === 'bartin-sanal') id = 'sanal';
  if (preset === 'bartin-ogreniyorum') id = 'ogreniyorum';
  if (preset === 'bartin-ubys') id = 'ubys';
  const taken = new Set(state.sites.map((site) => site.id));
  if (taken.has(id) && preset) throw new MonitorError('config', 'Bu hazır site zaten ekli.');
  for (let n = 2; taken.has(id); n++) id = `${slug(name).slice(0, 25)}-${n}`;
  const site = { id, name, base_url: baseURL, type, preset, pages, wants, paused: false, origin: 'panel', createdAt: now, updatedAt: now };
  if (template.logged_out_markers) site.logged_out_markers = template.logged_out_markers;
  delete state.removedSites[id];
  state.sites.push(site);
  return site;
}

export function setPaused(state, id, paused, now = Date.now()) {
  const site = (state.sites || []).find((entry) => entry.id === id);
  if (!site) throw new MonitorError('config', 'Site bulunamadı.');
  site.paused = Boolean(paused); site.updatedAt = now;
  return site;
}

/** Siteyi ve ona ait kayıtları, bekleyen bildirimleri ve dosya işlerini siler. Arşivdeki dosyalar paylaşımlı olabileceği için kalır. */
export function removeSite(state, id, now = Date.now()) {
  const index = (state.sites || []).findIndex((entry) => entry.id === id);
  if (index < 0) throw new MonitorError('config', 'Site bulunamadı.');
  state.sites.splice(index, 1);
  state.removedSites ||= {}; state.removedSites[id] = now;
  clearSiteRecords(state, id);
}

/** Bir siteye ait takip kayıtları, bekleyen bildirimler, dosya işleri ve son test sonucu. Arşiv ve geçmiş kalır. */
export function clearSiteRecords(state, id) {
  if (state.platforms) delete state.platforms[id];
  for (const [key, change] of Object.entries(state.pending || {})) if (change.platform === id) delete state.pending[key];
  for (const [key, job] of Object.entries(state.fileJobs || {})) if (job.platform === id) delete state.fileJobs[key];
  if (state.siteTests) delete state.siteTests[id];
  if (state.classroomPending?.site === id) delete state.classroomPending;
  if (state.classroomBridges) delete state.classroomBridges[id];
}

/**
 * Hangi özelliğin GERÇEKTEN desteklendiği. Genel web sayfası bağlantısı yalnızca sayfa
 * değişimini ve sayfadaki dosya bağlantılarını izler; not/ödev anlamı çıkaramaz.
 */
export function capabilities(site, { detectedAnnouncements = false } = {}) {
  const level = (state, note) => ({ level: state, note });
  if (isClassroomURL(site.base_url)) {
    const readOnly = level('full', 'Google Classroom üzerinden salt okunur takip');
    const unavailable = level('none', 'Google bağlantısının takip kapsamı dışında');
    return { assignments: readOnly, announcements: readOnly, files: unavailable, exams: unavailable,
      grades: unavailable, pageChanges: unavailable };
  }
  if (site.type === 'moodle') {
    const full = level('full', 'Moodle web servisi');
    return { announcements: full, files: full, assignments: full, exams: level('full', 'Quiz ve takvimdeki sınav etkinlikleri'), grades: full,
      pageChanges: level('none', 'Moodle verisi yapısal olarak okunur') };
  }
  const pages = site.pages || [];
  const kinds = new Set(pages.map((page) => page.kind || 'page'));
  const ubys = site.preset === 'bartin-ubys';
  const at = (page) => { try { return new URL(page.url); } catch { return null; } };
  // Siteye özel ayrıştırıcılar (core.js): ÜBYS ders sayfası modeli ve sekmeleri, Öğreniyorum sınav sayacı.
  const ubysCourse = ubys && pages.some((page) => page.kind === 'course_materials' && at(page)?.hostname === 'ubys.bartin.edu.tr' && at(page)?.pathname === '/AIS/Student/Class/ClassDetail');
  const ogren = (action, kind) => pages.some((page) => page.kind === kind && at(page)?.hostname === 'ogreniyorum.net' && at(page)?.pathname === '/mooc/index.php' && at(page)?.searchParams.get('do') === action);
  const ogrenContents = pages.some((page) => at(page)?.hostname === 'ogreniyorum.net' && at(page)?.pathname === '/mooc/index.php' && at(page)?.searchParams.get('do') === 'iceriklistele');
  const announcementNote = ogren('bildirimler', 'announcement') || ogren('anasayfa', 'announcement')
    ? 'Platform duyurusu ve kişisel bildirimler (ör. ödev yorumu); ders bazında ayrı duyuru sayfası yok'
    : 'Duyuru tablosu satır satır izlenir';
  // Destek düzeyi öğretmenin paylaştığı içeriği takip etme kapsamıdır; arşivleme ve öğrenci işlemleri ayrıdır.
  const bartinArchive = pages.some((page) => isBartinAnnouncementArchive(page.url));
  const onlyAnnouncements = (bartinArchive && pages.every((page) => isBartinAnnouncementArchive(page.url))) ||
    (detectedAnnouncements && pages.length === 1);
  const announcements = bartinArchive ? level('full', 'Arşivdeki her duyuru başlığı, yayın tarihi ve bağlantısı ayrı okunur')
    : detectedAnnouncements ? level('full', 'Otomatik tanınan duyuru listesi veya akışı')
    : ubysCourse ? level('full', 'Ders duyurularının tarihi, başlığı, içeriği ve ek adları takip edilir. Ekler ÜBYS üzerinden açılır.')
    : kinds.has('announcement') ? level('partial', announcementNote)
      : level('none', 'Yalnızca sayfa metni değişimi olarak görünür');
  const assignments = ubysCourse ? level('full', 'Ödev adı, açıklaması, ek adları ve son teslim tarihi takip edilir. Teslim durumunu ÜBYS üzerinden kontrol edebilirsin.')
    : ogren('odevler', 'assignment') ? level('full', 'Ödev listesindeki ders, konu, başlık, açıklama ve son teslim tarihi takip edilir. Teslim işlemi Öğreniyorum.net üzerinden yapılır.')
    : kinds.has('assignment') ? level('partial', 'Ödev tablosu satır satır; teslim durumu okunmaz') : level('none', 'Bu bağlantı ödevi tanıyamaz');
  const exams = ubysCourse ? level('partial', 'Yalnızca ÜBYS üzerinden yapılan çevrimiçi sınavlar; yüz yüze vize/final tarihleri ÜBYS ders sayfasında yayımlanmıyor')
    : ogren('kacgunkaldi', 'event') ? level('partial', 'Genel sınav dönemi tarihleri (vize/final başlangıcı); derse özel sınav tarihi yok')
      : kinds.has('event') ? level('partial', 'Takvim tablosu satır satır') : level('none', 'Bu bağlantı sınavı tanıyamaz');
  const ogrenSite = pages.some((page) => at(page)?.hostname === 'ogreniyorum.net');
  return {
    announcements,
    files: onlyAnnouncements ? level('none', 'Arşiv, duyurunun asıl sayfasına bağlantı verir')
      : ubysCourse ? level('full', 'Ders dosyalarının adları, sürümleri ve yeni paylaşımları takip edilir. Dosyalar ÜBYS üzerinden açılır; otomatik arşivleme kapalıdır.')
      : ogrenContents ? level('full', 'PDF ve konu listelerindeki yeni kayıtlar ve başlık değişiklikleri takip edilir. Dosyalar Öğreniyorum.net üzerinden açılır; PDF içeriği indirilip karşılaştırılmaz.')
      : kinds.has('course_materials') ? level('partial', 'Ders materyalleri listelenir, dosyalar arşivlenmez')
      : level('partial', 'Yalnızca sayfadaki dosya bağlantıları'),
    assignments,
    exams,
    grades: kinds.has('grade') ? level(ubys ? 'full' : 'partial', ubys ? 'Not tablosu (vize/final ayrıştırılır)' : 'Not tablosu satır satır; anlamı sınırlı')
      : level('none', ogrenSite ? 'Öğreniyorum.net\'te not sayfası yok ("Performansım" yalnızca video/soru istatistiği gösterir)' : 'Bu bağlantı notu tanıyamaz'),
    pageChanges: onlyAnnouncements
      ? level('none', 'Arşivdeki duyurular ayrı kayıtlar olarak okunur') : level('full', 'Sayfa metni ve tablolardaki değişiklikler'),
  };
}

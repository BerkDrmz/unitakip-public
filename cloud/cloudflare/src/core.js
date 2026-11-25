import { load } from 'cheerio/slim';
import * as URI from 'uri-js';
import { hash } from './hash.js';
import { academicCategory } from './academic.js';
import { PUBLIC_ANNOUNCEMENTS_FORMAT, readPublicAnnouncements } from './web-announcements.js';

export class MonitorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const VOLATILE = /(?:\d+\s*(?:saniye|sn|dakika|dk|saat|gün|hafta)\s*önce|son\s+(?:görülme|giriş|erişim|oturum|ziyaret|güncelleme)|last\s+(?:login|seen|access|updated)|\d+\s*(?:kişi|kullanıcı|ziyaretçi|user)s?\s*(?:çevrimiçi|online)|çevrimiçi\s+kullanıcılar|online\s+users|sunucu\s+saati|ziyaretçi\s+sayısı|copyright|©|^\d{1,2}:\d{2}(?::\d{2})?$|^\d{1,2}[./]\d{1,2}[./]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$)/i;
const SECRET_QUERY = /^(?:token|wstoken|privatetoken|sesskey|password|sifre|code|access_token|refresh_token|id_token|client_secret|logintoken|__RequestVerificationToken)$/i;
const BLOCKED_FILE = /(?:^|[^a-zçğıöşü])(?:logout|signout|cikis|çıkış|delete|sil|remove|kaldir|kaldır|action)(?:$|[^a-zçğıöşü])/i;
const FILE_EXT = /\.(?:pdf|pptx?|docx?|xlsx?|odt|odp|ods|txt|rtf|zip|rar|7z|png|jpe?g)(?:[?#]|$)/i;

export const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const htmlText = (value) => text(load(String(value ?? '')).root().text());
export const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function safeURL(value, root) {
  const resolved = URI.resolve(root, String(value));
  const parsed = URI.parse(resolved);
  const origin = URI.parse(root);
  if (parsed.scheme !== 'https' || parsed.host !== origin.host || parsed.userinfo || (parsed.port && Number(parsed.port) !== 443)) {
    throw new MonitorError('unsafe', 'İzin verilen site dışına yönlendirme engellendi.');
  }
  return resolved;
}

export function cleanURL(url) {
  const parsed = URI.parse(url);
  parsed.userinfo = undefined;
  parsed.fragment = undefined;
  parsed.query = (parsed.query || '').split('&').filter((part) => {
    try { return !SECRET_QUERY.test(decodeURIComponent(part.split('=')[0])); } catch { return false; }
  }).join('&') || undefined;
  return URI.serialize(parsed);
}

export function withQuery(url, pairs) {
  const parsed = URI.parse(url);
  const entries = Object.entries(pairs).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  parsed.query = [parsed.query, ...entries].filter(Boolean).join('&');
  return URI.serialize(parsed);
}

export function cookieHeader(cookies, url, now = Date.now()) {
  const parsed = URI.parse(url);
  return cookies.filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    const matches = parsed.host === domain || (String(cookie.domain).startsWith('.') && parsed.host.endsWith(`.${domain}`));
    const path = cookie.path || '/';
    const actual = parsed.path || '/';
    const pathMatches = actual === path || (actual.startsWith(path) && (path.endsWith('/') || actual[path.length] === '/'));
    return matches && pathMatches && (!cookie.expires || cookie.expires < 0 || cookie.expires * 1000 > now)
      && /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(cookie.name) && !/[\r\n;]/.test(cookie.value);
  }).sort((a, b) => (b.path || '/').length - (a.path || '/').length)
    .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function updateCookies(cookies, headers, url, now = Date.now()) {
  const host = URI.parse(url).host;
  const supplied = Object.entries(headers).find(([key]) => key.toLowerCase() === 'set-cookie')?.[1];
  if (!supplied) return cookies;
  // Apps Script exposes repeated Set-Cookie headers as an array.
  const lines = Array.isArray(supplied) ? supplied : [supplied];
  const result = cookies.map((cookie) => ({ ...cookie }));
  for (const line of lines) {
    const parts = String(line).split(';');
    const eq = parts[0].indexOf('=');
    if (eq <= 0) continue;
    const cookie = { name: parts[0].slice(0, eq).trim(), value: parts[0].slice(eq + 1).trim(), domain: host, path: '/', expires: -1 };
    for (const part of parts.slice(1)) {
      const [key, ...values] = part.trim().split('=');
      const value = values.join('=');
      if (key.toLowerCase() === 'domain') cookie.domain = value.toLowerCase();
      if (key.toLowerCase() === 'path') cookie.path = value;
      if (key.toLowerCase() === 'expires') cookie.expires = Date.parse(value) / 1000;
      if (key.toLowerCase() === 'max-age') cookie.expires = now / 1000 + Number(value);
    }
    const domain = cookie.domain.replace(/^\./, '');
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    const index = result.findIndex((old) => old.name === cookie.name && old.domain === cookie.domain && old.path === cookie.path);
    if (index >= 0) result.splice(index, 1);
    if (cookie.expires < 0 || cookie.expires * 1000 > now) result.push(cookie);
  }
  return result;
}

export function assertLoggedIn(html, platform) {
  const $ = load(html);
  if ($('input[type="password"]').length || (platform.logged_out_markers || []).some((marker) => html.includes(marker))) {
    throw new MonitorError('auth', 'Oturum kapandı; yeniden giriş gerekiyor.');
  }
  if (/bakım (?:çalışması|modu)|maintenance mode|site is undergoing maintenance/i.test($.root().text())) {
    throw new MonitorError('maintenance', 'Site bakım modunda; eksik içerik işlenmedi.');
  }
}

export function makeItem(scope, id, kind, title, data = {}) {
  return { scope, id: `${scope}/${id}`, kind, title: text(title), body: '', url: '', ...data };
}

const BARTIN_ARCHIVE_PATH = '/duyuru-arsiv.html';
const BARTIN_ARCHIVE_HOSTS = new Set(['btbs.bartin.edu.tr', 'fen.bartin.edu.tr']);

export function defaultWebPage(url) {
  const source = new URL(url);
  if (BARTIN_ARCHIVE_HOSTS.has(source.hostname) && source.pathname === '/' && !source.search) {
    return new URL(BARTIN_ARCHIVE_PATH, source).href;
  }
  return source.href;
}

export function isBartinAnnouncementArchive(url) {
  try {
    const source = new URL(url);
    return source.protocol === 'https:' && BARTIN_ARCHIVE_HOSTS.has(source.hostname) && source.pathname === BARTIN_ARCHIVE_PATH;
  } catch { return false; }
}

// Duyuru arşivi üniversitenin diğer birimlerine bağlantı verebilir. Bu bağlantılara istek gönderilmez.
export function bartinAnnouncementLink(href, archive) {
  try {
    const link = new URL(href, archive);
    if (link.protocol !== 'https:' || link.username || link.password || link.port ||
        !link.hostname.endsWith('.bartin.edu.tr') || !/\.html$/i.test(link.pathname)) return '';
    return link.origin + link.pathname;
  } catch { return ''; }
}

function parseBartinAnnouncements(html, url, page) {
  const $ = load(html);
  const rows = $('main .content-area .col-lg-10 > ul.list-group > li.list-group-item');
  if (!rows.length) throw new MonitorError('site', 'Bartın duyuru arşivi okunamadı.');
  const entries = new Map();
  for (const row of rows) {
    const anchor = $(row).find('.col-10 a[href]').first();
    const title = text(anchor.text());
    const href = anchor.attr('href');
    if (!title || !href) continue;
    const source = bartinAnnouncementLink(href, url);
    if (!source) continue;
    const date = text($(row).find('.col-2').first().text());
    // Bazı duyurular aynı yönlendirme adresini farklı tarihlerde tekrar kullanıyor.
    const key = new URL(source).origin === new URL(url).origin ? source : `${source}|${date}`;
    entries.set(key, makeItem(page.id, `announcement/${hash(key)}`, 'announcement', title, {
      url: source, fields: date ? { Tarih: date } : {}, body: date ? `Yayın tarihi: ${date}` : '',
    }));
  }
  if (!entries.size) throw new MonitorError('site', 'Bartın duyuru arşivinde geçerli duyuru bulunamadı.');
  return [...entries.values()];
}

const announcementPageFormat = (url) => `${PUBLIC_ANNOUNCEMENTS_FORMAT}${hash(cleanURL(url))}:`;

async function readWebPage(platform, client, url) {
  const read = async () => {
    const response = await client.request(url);
    assertLoggedIn(response.text, platform);
    return response;
  };
  return client.recoverPage ? client.recoverPage(read) : read();
}

async function discoverAnnouncements(response, client, platform, canFollow, pageFormat, previousFormat) {
  const local = readPublicAnnouncements(response.text, response.url);
  if (local.next && canFollow) {
    try {
      const archive = await readWebPage(platform, client, local.next);
      const discovered = readPublicAnnouncements(archive.text, archive.url);
      if (discovered.entries !== null) return { entries: discovered.entries, source: archive.url, followed: true };
    } catch (error) {
      if (['quota', 'deadline'].includes(error.code)) throw error;
    }
  }
  // A failed auxiliary request must not replace a previously tracked archive with the homepage.
  const lostSource = previousFormat?.startsWith(pageFormat) && previousFormat !== pageFormat + hash(cleanURL(response.url));
  return { entries: lostSource ? null : local.entries, source: response.url, followed: Boolean(local.next && canFollow) };
}

function publicAnnouncementItems(entries, page) {
  const unique = new Map();
  for (const { title, url, date } of entries) {
    const link = cleanURL(url);
    unique.set(link, makeItem(page.id, `announcement/${hash(link)}`, 'announcement', title, {
      url: link, fields: date ? { Tarih: date } : {}, body: date ? `Yayın tarihi: ${date}` : '',
    }));
  }
  return [...unique.values()];
}

/** Read configured pages and their supported same-site sections. */
export async function webSnapshot(platform, client, pageFilter = null, previousFormats = {}) {
  const items = [], complete = [], errors = [], formats = {};
  const learningCourses = new Map();
  let canDiscoverArchive = true;
  const resultCourses = [], configuredDetails = new Map(), surveyByGrade = {}, surveyScopes = [];
  for (const page of platform.pages) {
    if (pageFilter && !pageFilter(page)) continue;
    try {
      const response = await readWebPage(platform, client, page.url);
      // ÜBYS ders modeli: yalnızca açıkça "course_materials" olarak yapılandırılmış ÜBYS ders sayfalarında.
      // Aynı ÜBYS yazılımını kullanan başka üniversitelerde de çalışabilir; yalnızca Bartın'da doğrulandı.
      const isUbysCourse = page.kind === 'course_materials' && new URL(response.url).pathname === '/AIS/Student/Class/ClassDetail';
      const source = new URL(response.url);
      const isOgrenCountdown = page.kind === 'event' && source.hostname === 'ogreniyorum.net' && source.searchParams.get('do') === 'kacgunkaldi';
      const isOgrenAssignments = page.kind === 'assignment' && source.hostname === 'ogreniyorum.net' && source.pathname === '/mooc/index.php' && source.searchParams.get('do') === 'odevler';
      const isBartinArchive = isBartinAnnouncementArchive(page.url) || isBartinAnnouncementArchive(response.url);
      if (isBartinArchive && !isBartinAnnouncementArchive(response.url)) throw new MonitorError('site', 'Duyuru arşivi başka bir sayfa açtı.');
      let discovered = null;
      if (!isBartinArchive && platform.auto_announcements && ['page', 'announcement'].includes(page.kind) && !page.content_selector) {
        const pageFormat = announcementPageFormat(page.url);
        const previousFormat = previousFormats[page.id];
        const result = await discoverAnnouncements(response, client, platform, canDiscoverArchive, pageFormat, previousFormat);
        if (result.followed) canDiscoverArchive = false;
        if (result.entries !== null) {
          discovered = publicAnnouncementItems(result.entries, page);
          formats[page.id] = pageFormat + hash(cleanURL(result.source));
        } else if (previousFormat?.startsWith(pageFormat)) {
          throw new MonitorError('site', 'Daha önce okunan duyuru listesi bu kontrolde bulunamadı.');
        } else if (previousFormat?.startsWith(PUBLIC_ANNOUNCEMENTS_FORMAT)) {
          // A different address was configured for this scope. Establish a fresh text baseline.
          formats[page.id] = 'public-page-v1';
        }
      }
      items.push(...(discovered ?? (isBartinArchive ? parseBartinAnnouncements(response.text, response.url, page)
        : isUbysCourse ? parseUbysCourse(response.text, response.url, page)
        : isOgrenCountdown ? parseOgrenCountdown(response.text, response.url, page)
          : isOgrenAssignments ? parseOgrenAssignments(response.text, response.url, page) : parsePage(response.text, response.url, page))));
      if (source.origin === 'https://ubys.bartin.edu.tr' && source.pathname === '/AIS/Student/Class/Index' && page.kind === 'grade') {
        resultCourses.push(...ubysResultCourses(response.text, response.url, page));
      }
      if (isUbysCourse) configuredDetails.set(new URL(page.url).href, response);
      complete.push(page.id);
      if (isOgrenAssignments) formats[page.id] = 'ogren-assignments-v1';
      if (isBartinArchive) formats[page.id] = 'bartin-announcements-v1';
      if (isUbysCourse) await ubysCourseTabs(platform, client, response, page, { items, complete, errors });
      if (source.hostname === 'ogreniyorum.net' && source.pathname === '/mooc/index.php' &&
          ['derskonulistele', 'iceriklistele'].includes(source.searchParams.get('do'))) {
        items.push(...parseOgrenContent(response.text, response.url, page, learningCourses));
        complete.push(`learning/${page.id}`);
      }
    } catch (error) {
      if (['auth', 'deadline', 'quota'].includes(error.code)) throw error;
      errors.push({ scope: page.id, code: error.code || 'site' });
    }
  }
  for (const course of resultCourses) {
    try {
      let detail = configuredDetails.get(course.url);
      if (!detail) {
        detail = await readWebPage(platform, client, course.url);
        if (platform.features?.assignments !== false) {
          const page = { id: course.scope }, scope = `assignments/${page.id}`;
          try {
            const info = ubysEmbedded(detail.text, '_jsm')?.StudentClassInfo;
            if (!Array.isArray(info?.Homeworks)) throw new MonitorError('site', 'ÜBYS dersinin ödev listesi okunamadı.');
            items.push(...parseUbysHomeworks(info, cleanURL(detail.url), page, course.name));
            complete.push(scope);
          } catch (error) { tabFailure(error, scope, errors); }
        }
      }
      const summaries = items.filter(item => item.scope === course.parent && item.course === course.name && item.fields?.['Sütun 1']);
      const rows = ubysResultRows(detail.text, course, summaries);
      for (const item of summaries) surveyByGrade[item.id] = rows === null;
      if (rows === null) {
        surveyScopes.push(course.scope);
        continue; // Earlier results remain available until a successful read.
      }
      items.push(...rows);
      complete.push(course.scope);
    } catch (error) {
      if (['auth', 'deadline', 'quota'].includes(error.code)) throw error;
      errors.push({ scope: course.scope, code: error.code || 'site' });
    }
  }
  return { items, complete, errors, ...(resultCourses.length ? { surveyByGrade, surveyScopes } : {}), ...(Object.keys(formats).length ? { formats } : {}) };
}

// Only follow course-detail links in the configured term table. The detail page also contains older years.
function ubysResultCourses(html, url, page) {
  if (!page.content_selector) return [];
  const $ = load(html), root = $(page.content_selector).first(), courses = [];
  for (const table of root.filter('table').add(root.find('table[id]')).toArray()) {
    const term = /^(Guz|Bahar|Yaz)(\d{4})table$/i.exec($(table).attr('id') || '');
    if (!term) continue;
    for (const link of $(table).find('a[data-class-id][href]').toArray()) {
      const target = new URL($(link).attr('href'), url);
      if (target.origin !== new URL(url).origin || target.pathname !== '/AIS/Student/Class/ClassDetail'
        || target.username || target.password || !target.searchParams.get('classId')
        || [...target.searchParams.keys()].some(key => key !== 'classId')) continue;
      const row = $(link).closest('tr'), name = text(row.children('td').eq(1).text()), code = text($(link).text());
      if (name && code) courses.push({ parent: page.id, scope: `exam-results/${page.id}/${hash(code)}`, name,
        semester: { guz: 'Güz', bahar: 'Bahar', yaz: 'Yaz' }[term[1].toLowerCase()], year: term[2], url: target.href });
    }
  }
  return courses;
}

const examKey = value => text(value).toLocaleLowerCase('tr').replace(/\s*:\s*$/, '');

function ubysResultRows(html, course, summaries) {
  const $ = load(html);
  const term = $(`ul.course-details > li.y${course.year}`).filter((_, el) => text($(el).children('.semester').text()) === course.semester);
  const table = term.find('table').filter((_, el) => $(el).find('thead th').toArray().some(th => text($(th).text()) === 'Sınav Notu'));
  if (term.length === 1 && !table.length && /notlarınızı görebilmeniz için ankete katılmanız gerekmektedir/i.test(term.children('.success-status').text())) return null;
  if (term.length !== 1 || table.length !== 1) throw new MonitorError('site', 'Dönemin sınav sonuç tablosu okunamadı.');
  const headers = table.find('thead th').map((_, th) => text($(th).text())).get();
  const allowed = new Set(['Sınav Tipi', 'Sınav Adı', 'İlan Tarihi', 'Sınav Notu', 'Mazeret', 'Sınıf Ortalaması', 'Standart Sapma', 'Harf Notu Aralığı']);
  const results = [], occurrences = new Map();
  for (const row of table.children('tbody').children('tr').toArray()) {
    const cells = $(row).children('td');
    if (cells.length === 1 && EMPTY_TABLE.test(text(cells.text()))) continue;
    if (cells.length !== headers.length) throw new MonitorError('site', 'Sınav sütunları değişti.');
    const fields = Object.fromEntries(headers.flatMap((h, i) => allowed.has(h) ? [[h, text(cells.eq(i).text())]] : []));
    const label = fields['Sınav Adı'] || fields['Sınav Tipi'];
    if (!label) throw new MonitorError('site', 'Sınav adı okunamadı.');
    const key = hash([fields['Sınav Tipi'], label]), occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    const summary = summaries.filter(item => [label, fields['Sınav Tipi']].some(v => examKey(v) === examKey(item.fields['Sütun 1'])));
    results.push(makeItem(course.scope, `${key}/${occurrence}`, 'grade', label, {
      course: course.name, url: course.url, fields, ...(summary.length === 1 ? { summaryId: summary[0].id } : {}),
    }));
  }
  return results;
}

/** Öğreniyorum uses content routes, not file extensions. Read card metadata only. */
export function parseOgrenContent(html, url, page, courses = new Map()) {
  const $ = load(html), root = $('.content').first();
  if (!root.length || !root.find('.menu-container').length) throw new MonitorError('site', 'Öğreniyorum içerik listesi bulunamadı.');
  const source = cleanURL(url), scope = `learning/${page.id}`;
  const course = page.course_name || courses.get(source) || text($('h1').first().text());
  if (!course) throw new MonitorError('partial', 'İçeriklerin bağlı olduğu ders okunamadı; eski kayıtlar korundu.');
  const items = [], seenLinks = new Set(), occurrences = new Map();
  root.find('a[href]').each((_, anchor) => {
    const card = $(anchor).find('.menu-card').first();
    const title = text(card.find('.card-content h3').first().text());
    if (!title) return;
    let link;
    try { link = cleanURL(safeURL($(anchor).attr('href'), url)); } catch { return; }
    const target = new URL(link);
    if (target.pathname !== '/mooc/index.php') return;
    const action = target.searchParams.get('do');
    if (!['iceriklistele', 'icerikpdf'].includes(action) || !target.searchParams.get('konu')) return;
    if (action === 'iceriklistele' && course) courses.set(link, course);
    if (seenLinks.has(link)) return;
    seenLinks.add(link);
    // Öğreniyorum `konu` değerini her sayfa yüklemesinde yeniden şifreler: aynı içerik her okumada farklı
    // bağlantıyla gelir. Kimlik bu yüzden bağlantıdan değil, sayfadaki işlem + başlık (+ aynı başlığın sırası)
    // ile kurulur; bağlantı değişikliği algılamaya girmez (volatileURL). Eski şifreli değerler açılmaya devam eder.
    const key = `${action}/${hash(title)}`, n = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, n);
    items.push(makeItem(scope, `material/${key}${n > 1 ? `/${n}` : ''}`, 'material', title, {
      course, url: source,
      material: { url: link, extension: action === 'icerikpdf' ? 'pdf' : 'konu', opensSource: false, volatileURL: true },
    }));
  });
  return items;
}

/** Ödev listesinin bilinen sütunlarını okur; teslim formu açılmaz ve öğrenci adına işlem yapılmaz. */
export function parseOgrenAssignments(html, url, page) {
  const $ = load(html);
  const normalize = (value) => text(value).toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
  const table = $('.content table').filter((_, element) => {
    const headers = $(element).find('thead th').map((_, cell) => normalize($(cell).text())).get();
    return ['ders', 'konu', 'baslik', 'aciklama', 'son teslim'].every((name) => headers.includes(name));
  }).first();
  if (!table.length) throw new MonitorError('site', 'Öğreniyorum ödev tablosu bulunamadı; eski kayıtlar korundu.');
  const headers = table.find('thead th').map((_, cell) => normalize($(cell).text())).get();
  // Sıra numarası kimlik değildir: yeni ödev en üste geldiğinde eski ödevler yeniden bildirilmez.
  const ignored = [...(page.ignore_columns || []), '#'];
  const kept = headers.filter((name) => !ignored.some((value) => normalize(value) === name));
  const keys = ['ders', 'konu', 'baslik'].map((name) => kept.indexOf(name));
  if (keys.some((value) => value < 0)) throw new MonitorError('site', 'Öğreniyorum ödev kimliği okunamadı.');
  const items = parsePage(table.toString(), url, { ...page, content_selector: 'table', track_text: false,
    ignore_columns: ignored, key_columns: keys });
  for (const item of items) {
    if (item.kind !== 'assignment') continue;
    const fields = Object.fromEntries(Object.entries(item.fields || {}).map(([key, value]) => [normalize(key), value]));
    item.course = fields.ders || '';
    item.title = fields.baslik || fields.konu || 'Ödev';
    item.body = fields.aciklama || '';
    const raw = text(fields['son teslim']);
    const match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
    const date = match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T${match[4].padStart(2, '0')}:${match[5]}:${match[6] || '00'}` : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw) ? raw.replace(' ', 'T') : '';
    item.dueAt = date ? localDate(date) : null;
    if (raw && !item.dueAt) item.body = [item.body, `Son teslim: ${raw}`].filter(Boolean).join('\n');
  }
  return items;
}

/** Değişiklik özeti: platformun her okumada yeniden ürettiği bağlantılar (volatileURL) özete girmez. */
export function itemFingerprint(item) {
  return hash(item.material?.volatileURL ? { ...item, material: { ...item.material, url: '' } } : item);
}

/**
 * Bir kerelik geçiş: Öğreniyorum materyallerinin eski kimliği şifreli bağlantının özetiydi ve her okumada
 * değişiyordu. Eski biçimli kayıt taşıyan kapsam silinip sessizce yeniden başlatılır; aksi hâlde yeni
 * kimlik şemasına geçiş, aynı materyalleri bir kez daha "yeni" diye gönderirdi.
 */
function rebaselineLegacyLearning(platform, scope) {
  if (!scope.startsWith('learning/')) return;
  const legacy = Object.entries(platform.items).filter(([id, record]) => record.scope === scope && /\/material\/[0-9a-f]+$/.test(id));
  if (!legacy.length) return;
  for (const [id, record] of Object.entries(platform.items)) if (record.scope === scope) delete platform.items[id];
  delete platform.scopes[scope];
  delete platform.guards[scope];
}

/** Read the same serialized course model used by ÜBYS; never execute embedded JavaScript. */
/** ÜBYS sayfalarındaki `değişken = JSON.parse(Base64.decode("..."))` kalıbını JavaScript çalıştırmadan çözer. */
function ubysEmbedded(html, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*JSON\\.parse\\(Base64\\.decode\\("([A-Za-z0-9+/=]*)"\\)`).exec(html);
  if (!match) return undefined;
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(match[1]), c => c.charCodeAt(0)))); }
  catch { throw new MonitorError('site', 'ÜBYS sayfa verisi okunamadı.'); }
}
/** ÜBYS ve Öğreniyorum tarihleri saat dilimi taşımaz; İstanbul saati kabul edilir. */
function localDate(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value) + (/[zZ]|[+-]\d\d:\d\d$/.test(value) ? '' : '+03:00'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseUbysCourse(html, url, page, now = Date.now()) {
  const model = ubysEmbedded(html, '_jsm');
  if (model === undefined) throw new MonitorError('site', 'ÜBYS ders modeli bulunamadı; eski kayıtlar korundu.');
  const info = model?.StudentClassInfo;
  if (!info || !Array.isArray(info.ClassContents)) throw new MonitorError('site', 'ÜBYS dosya listesi eksik.');
  const course = text(info.CourseName || page.course_name), items = [], source = cleanURL(url);
  for (const content of info.ClassContents) {
    if (content.IsDeleted) continue;
    const publishedAt = localDate(content.PublishedOn);
    if (publishedAt && publishedAt > now) continue;
    if (content.Files !== null && content.Files !== undefined && !Array.isArray(content.Files)) throw new MonitorError('site', 'ÜBYS dosya kaydı eksik.');
    for (const entry of content.Files || []) {
      if (entry.IsDeleted || !entry.File || content.IsDownloadableStudents === false) continue;
      const file = entry.File;
      if (!file.Name || !file.EncryptedFileArchiveId) continue;
      const version = text(file.ModifiedOn || file.CreatedOn || `${file.MajorVersionNo || 0}.${file.MinorVersionNo || 0}`);
      items.push(makeItem(page.id, `material/${content.Id}/${entry.Id}`, 'material', file.Name, {
        course, url: source, body: htmlText(content.Explanation || ''),
        fields: { 'Dosya adı': file.Name, 'Sürüm': version },
        material: { url: source, size: Number(file.FileLength) || null, extension: String(file.FileExtension || file.Name.split('.').pop()).replace(/^\./,'').toLowerCase(), opensSource: true, publishedAt },
      }));
    }
    // Teachers can publish a presentation as a link rather than a downloadable attachment.
    const $ = load(String(content.Explanation || ''));
    $('a[href]').each((index, element) => {
      let link;
      try { const parsed = new URL($(element).attr('href')); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.includes('.') || /^(?:localhost|127\.|0\.|10\.|192\.168\.)/.test(parsed.hostname)) return; link = cleanURL(parsed.href); } catch { return; }
      items.push(makeItem(page.id, `link/${content.Id}/${hash(link)}`, 'material', content.Name || text($(element).text()) || 'Ders bağlantısı', {
        course, url: source, body: htmlText(content.Explanation || ''),
        material: { url: link, extension: 'link', opensSource: false, publishedAt },
      }));
    });
  }
  return items;
}

const istanbulTime = (ms) => ms ? new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' }).format(ms) : '';
const tabFailure = (error, scope, errors) => {
  if (['auth', 'deadline', 'quota'].includes(error.code)) throw error;
  errors.push({ scope, code: error.code || 'site' });
};

/**
 * ÜBYS ders sayfasının ödev, duyuru ve sınav bölümleri. Her biri kendi kapsamındadır: biri okunamazsa
 * yalnızca o bölümün eski kayıtları korunur, ilk okumada mevcut kayıtlar için bildirim gitmez.
 * Ödevler ana sayfadaki modelden (ek istek yok); duyurular ve sınavlar tarayıcının sekme açarken kullandığı
 * GET uç noktasından (GetClassDetailPartial) okunur. Duyuru sayısı 0 olan derste duyuru isteği atılmaz.
 */
export async function ubysCourseTabs(platform, client, response, page, out, now = Date.now()) {
  const html = response.text, source = cleanURL(response.url), features = platform.features || {};
  const info = ubysEmbedded(html, '_jsm')?.StudentClassInfo || {};
  const course = text(info.CourseName || page.course_name);
  const section = async (scope, enabled, read) => {
    if (!enabled) return;
    try { out.items.push(...await read()); out.complete.push(scope); } catch (error) { tabFailure(error, scope, out.errors); }
  };
  const tab = async (number) => {
    const classId = ubysEmbedded(html, 'EncryptedClassId');
    if (typeof classId !== 'string' || !classId) throw new MonitorError('site', 'ÜBYS ders kimliği bulunamadı.');
    const url = withQuery(`${new URL(response.url).origin}/AIS/Student/Class/GetClassDetailPartial`, { ClassId: classId, ClassDetailPartial: number });
    const result = await readWebPage(platform, client, url);
    return result.text;
  };
  await section(`assignments/${page.id}`, features.assignments !== false, async () => parseUbysHomeworks(info, source, page, course, now));
  await section(`announcements/${page.id}`, features.announcements !== false, async () => {
    const badge = /id="duyurusayisigosterenSpan"[^>]*>\s*(\d+)\s*</.exec(html);
    if (badge && Number(badge[1]) === 0) return [];
    return parseUbysAnnouncements(await tab(11), source, page, course);
  });
  await section(`exams/${page.id}`, features.quizzes !== false && features.exams !== false, async () => parseUbysExams(await tab(7), source, page, course));
}

/** Ödev adı, açıklaması, son teslim tarihi ve ek adları. Öğrenci listesi (Persons) ve teslim kayıtları okunmaz. */
export function parseUbysHomeworks(info, url, page, course = '', now = Date.now()) {
  if (info.Homeworks != null && !Array.isArray(info.Homeworks)) throw new MonitorError('site', 'ÜBYS ödev listesi beklenen yapıda değil.');
  const items = [];
  for (const homework of info.Homeworks || []) {
    if (!homework || homework.IsDeleted || !homework.Name) continue;
    // ÜBYS'nin kendi ekranı da görünürlük aralığı dışındaki ödevleri öğrenciye göstermez.
    const from = localDate(homework.VisionStartDate), until = localDate(homework.VisionEndDate);
    if ((from && from > now) || (until && until < now)) continue;
    const attachments = (Array.isArray(homework.Files) ? homework.Files : []).filter((entry) => !entry?.IsDeleted && entry?.File?.Name).map((entry) => entry.File.Name);
    items.push(makeItem(`assignments/${page.id}`, `homework/${homework.Id ?? hash(homework.Name)}`, 'assignment', homework.Name, {
      course, url, dueAt: localDate(homework.LastDeliveryDate), body: htmlText(homework.Description || '').slice(0, 5000),
      fields: attachments.length ? { Ekler: attachments.join(', ') } : {},
    }));
  }
  return items;
}

/** "Duyurular" sekmesindeki tablo: tarih, başlık, içerik ve ek adları. Ekler indirilmez. */
export function parseUbysAnnouncements(html, url, page, course = '') {
  const $ = load(html), table = $('#announcementTable');
  if (!table.length) throw new MonitorError('site', 'ÜBYS duyuru tablosu bulunamadı; eski kayıtlar korundu.');
  const items = [];
  table.find('tbody tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length < 4) return; // "kayıt bulunamadı" gibi birleşik satırlar
    const date = text(cells.eq(1).text()), title = text(cells.eq(2).text());
    if (!date && !title) return;
    const attachments = cells.eq(4).find('a').map((_, anchor) => text($(anchor).text())).get().filter(Boolean);
    items.push(makeItem(`announcements/${page.id}`, `announcement/${hash(`${date}|${title}`)}`, 'announcement', title || 'Ders duyurusu', {
      course, url, body: text(cells.eq(3).text()).slice(0, 5000),
      fields: { Tarih: date, ...(attachments.length ? { Ekler: attachments.join(', ') } : {}) },
    }));
  });
  return items;
}

/**
 * "Online Sınav" sekmesi: yalnızca ÜBYS üzerinden yapılan çevrimiçi sınavların adı ve tarihleri gelir.
 * Yüz yüze vize/final tarihleri bu sekmede yayımlanmaz (tabloda yalnızca sınav türünün adı vardır).
 */
export function parseUbysExams(html, url, page, course = '') {
  const exams = ubysEmbedded(html, '_jsAllOnlineExams');
  if (exams === undefined && !/id="student-class-exam"/.test(html)) throw new MonitorError('site', 'ÜBYS sınav sekmesi beklenen yapıda değil.');
  if (exams != null && !Array.isArray(exams)) throw new MonitorError('site', 'ÜBYS çevrimiçi sınav listesi beklenen yapıda değil.');
  const items = [];
  for (const entry of exams || []) {
    const exam = entry?.Exam;
    if (!exam?.Name) continue;
    const startAt = localDate(exam.StartDate), finishAt = localDate(exam.FinishDate);
    items.push(makeItem(`exams/${page.id}`, `online/${exam.Id ?? entry.Id ?? hash(`${exam.Name}|${exam.StartDate}`)}`, 'event', `${exam.Name}${entry.IsTestExam ? ' (deneme)' : ''}`, {
      course, url, dueAt: startAt, fields: { Başlangıç: istanbulTime(startAt), Bitiş: istanbulTime(finishAt), Tür: 'Çevrimiçi sınav' },
    }));
  }
  return items;
}

/** Öğreniyorum "Kaç Gün Kaldı": sınav dönemi başlıkları HTML'de, tarihleri sayfaya gömülü `examDates` nesnesinde. */
export function parseOgrenCountdown(html, url, page) {
  const $ = load(html), root = $('.content').first();
  const containers = root.find('.countdown-container');
  if (!root.length || (!containers.length && !/Kalan S[üu]re/i.test(root.text()))) throw new MonitorError('site', 'Öğreniyorum sınav sayacı bulunamadı; eski kayıtlar korundu.');
  const dates = Object.fromEntries([...html.matchAll(/\b(exam\d+)\s*:\s*new Date\("([^"]+)"\)/g)].map((match) => [match[1], match[2]]));
  const items = [];
  containers.each((_, element) => {
    const title = text($(element).find('.exam-title').first().text());
    if (!title) return;
    const key = String($(element).find('[id^="countdown"]').attr('id') || '').replace(/^countdown/, '');
    const raw = key ? dates[`exam${key}`] : null;
    const dueAt = raw ? localDate(raw) : null;
    items.push(makeItem(page.id, `exam/${key || hash(title)}`, 'event', title, {
      course: page.course_name || '', url: cleanURL(url), dueAt, fields: { Tarih: istanbulTime(dueAt) },
    }));
  });
  return items;
}

const EMPTY_TABLE = /^(?:kay[ıi]t|veri|sonu[çc]|g[öo]sterilecek kay[ıi]t)\s*(?:bulunamad[ıi]|bulunmamaktad[ıi]r|yok)\.?$|^no (?:records|data)(?: found)?\.?$/i;
export function parsePage(html, url, page) {
  const $ = load(html);
  const selected = page.content_selector ? $(page.content_selector).first() : $('body').length ? $('body') : $.root();
  if (!selected.length) throw new MonitorError('site', 'Sayfa içerik alanı değişti; seçici kontrol edilmeli.');
  selected.find('script,style,noscript,nav,header,footer,aside,.sidebar,.navbar,input,button,select,textarea').remove();
  for (const selector of page.ignore_selectors || []) selected.find(selector).remove();
  const items = [], tables = selected.find('table').add(selected.filter('table'));
  const ownCells = (row) => $(row).children('th,td').map((_, cell) => {
    const copy = $(cell).clone(); copy.find('table').remove(); return text(copy.text());
  }).get();
  if (page.track_tables !== false) tables.each((tableIndex, table) => {
    const rows = $(table).find('tr').filter((_, row) => $(row).closest('table')[0] === table).toArray();
    if (!rows.length) return;
    const firstIsHeader = $(rows[0]).children('th').length > 0 && !$(rows[0]).children('td').length;
    // ignore_columns: başlığı verilen sütunlar (ör. "Durum: Okundu/Okunmadı") kimliğe ve değişiklik algılamaya girmez.
    const ignored = new Set((page.ignore_columns || []).map((name) => text(name).toLocaleLowerCase('tr')));
    const headerCells = firstIsHeader ? ownCells(rows[0]) : [];
    const keep = (cells) => ignored.size && firstIsHeader ? cells.filter((_, i) => !ignored.has(String(headerCells[i] || '').toLocaleLowerCase('tr'))) : cells;
    // Boş tablonun "Kayıt bulunamadı" satırı içerik değildir: ödev gibi görünür ve tablo dolup boşaldıkça yeniden bildirilirdi.
    const values = rows.slice(firstIsHeader ? 1 : 0).map((row) => keep(ownCells(row))).filter((cells) => cells.some(Boolean))
      .filter((cells) => { const filled = cells.filter(Boolean); return !(filled.length === 1 && EMPTY_TABLE.test(filled[0])); });
    if (!values.length) return;
    const width = Math.max(...values.map((cells) => cells.length));
    const headers = firstIsHeader ? keep(headerCells) : Array.from({ length: width }, (_, i) => `Sütun ${i + 1}`);
    let context = '', course = page.course_name || '';
    const detailRow = $(table).closest('tr');
    if (detailRow.length) {
      const previous = detailRow.prevAll('tr').toArray().find((row) => ownCells(row).filter(Boolean).length >= 2);
      if (previous) { const cells = ownCells(previous); context = cells[0]; course = cells[1] || course; }
    }
    const sameContainerIndex = $(table).parent().children('table').index(table);
    const tableKey = $(table).attr('id') || (context ? hash(`${context}/${headers.join('|')}/${sameContainerIndex}`) : `table-${tableIndex}`);
    let keyColumns = page.key_columns;
    if (!keyColumns?.length) {
      const candidates = headers.map((_, i) => i).filter((i) => values.every((row) => row[i]) && new Set(values.map((row) => row[i])).size === values.length);
      keyColumns = [candidates.find((i) => !values.every((row) => /^\d+\.?$/.test(row[i]))) ?? candidates[0] ?? -1];
    }
    const keyCounts = new Map();
    for (const cells of values) {
      const raw = keyColumns[0] >= 0 ? keyColumns.map((i) => cells[i] || '').join('|') : cells.join('|');
      keyCounts.set(raw, (keyCounts.get(raw) || 0) + 1);
    }
    for (const cells of values) {
      const key = keyColumns[0] >= 0 ? keyColumns.map((i) => cells[i] || '').join('|') : cells.join('|');
      const fields = {};
      cells.forEach((value, i) => { fields[`${headers[i] || `Sütun ${i + 1}`}${headers.indexOf(headers[i]) < i ? ` (${i + 1})` : ''}`] = value; });
      const id = `${tableKey}/${hash(keyCounts.get(key) > 1 ? cells : key)}`;
      items.push(makeItem(page.id, id, page.kind === 'page' ? 'table_row' : page.kind || 'table_row', `${course ? `${course} — ` : ''}${cells.find(Boolean)}`, {
        course, url: cleanURL(url), fields, body: Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n'),
      }));
    }
  });
  if (page.track_links !== false) selected.find('a[href]').each((_, anchor) => {
    const href = $(anchor).attr('href');
    if (!FILE_EXT.test(href)) return;
    let fileURL;
    try { fileURL = safeURL(URI.resolve(url, href), url); } catch { return; }
    if (BLOCKED_FILE.test(URI.parse(fileURL).path || '')) return;
    const name = text($(anchor).text()) || (URI.parse(fileURL).path || '').split('/').pop();
    const clean = cleanURL(fileURL);
    items.push(makeItem(page.id, `file/${hash(clean)}`, 'file', name, {
      course: page.course_name || '', url: clean, files: [{ url: clean, name, version: hash(clean) }],
    }));
  });
  if (page.track_text !== false) {
    selected.find('table').remove();
    selected.find('p,div,li,h1,h2,h3,h4,br,tr').prepend('\n');
    const ignores = (page.ignore_patterns || []).map((pattern) => new RegExp(pattern, 'i'));
    const body = selected.text().split(/\r?\n/).map(text).filter((line) => line && !VOLATILE.test(line) && !ignores.some((rule) => rule.test(line))).join('\n').slice(0, 30000);
    if (body) items.push(makeItem(page.id, 'text', page.kind || 'page', page.title || page.course_name || text($('title').text()) || page.id, { body, url: cleanURL(url), course: page.course_name || '' }));
  }
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

/** Workers Free: bir çalışmada en fazla 50 dış istek. Depolama ve e-posta bağlantıları için pay bırakılır. */
export const SUBREQUEST_LIMIT = 50;
export const SUBREQUEST_BUDGET = 44;
/** Günlük (UTC) kullanım sayacı: yalnızca sayılar, mevcut kayıtlarla birlikte yazılır (ek depolama yazımı üretmez). */
export function recordUsage(state, now, { run = true, requests = 0, deferred = false, mails = 0 } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const usage = state.usage?.day === day ? state.usage : { day, runs: 0, requests: 0, peak: 0, deferred: 0, mails: 0 };
  if (run) usage.runs++;
  usage.requests += requests; usage.peak = Math.max(usage.peak, requests); usage.mails += mails;
  if (deferred) usage.deferred++;
  state.usage = usage;
}
/** Workers Free, Durable Object SQLite: günde 100.000 satır yazımı ve toplam 5 GB depolama. */
export const ROWS_WRITTEN_LIMIT = 100000;
export const STORAGE_LIMIT = 5 * 1024 ** 3;
/** storage: Store.usage() sonucu (ölçülen satır yazımı ve veritabanı boyutu); bilinmiyorsa değerler null kalır. */
export function usageStatus(state, now = Date.now(), storage = null) {
  const day = new Date(now).toISOString().slice(0, 10), usage = state.usage?.day === day ? state.usage : {};
  return { day, runs: usage.runs || 0, requests: usage.requests || 0, peak: usage.peak || 0, deferred: usage.deferred || 0, mails: usage.mails || 0,
    budget: SUBREQUEST_BUDGET, limit: SUBREQUEST_LIMIT, resuming: Boolean(state.fullRound),
    rowsWritten: storage?.rowsWritten ?? null, yesterdayRows: storage?.yesterdayRows ?? null, rowsLimit: ROWS_WRITTEN_LIMIT,
    databaseSize: storage?.databaseSize ?? null, storageLimit: STORAGE_LIMIT };
}

export const emptyState = () => ({ schema: 1, sequence: 0, platforms: {}, pending: {}, archive: {}, fileJobs: {}, notices: {}, lastWeekly: null });

/** Kaybolan kayıt bu süre saklanır; geri gelirse yeni sayılmaz. */
export const MISSING_KEEP = 14 * 86400000;
/** Aynı içerik (bağlantıdan bağımsız) bu süre içinde ikinci kez "yeni" diye bildirilmez. */
export const REPEAT_WINDOW = 7 * 86400000;
/**
 * İçeriğin bağlantı ve kimlikten bağımsız özeti. Site kimlik/bağlantı üretimini değiştirse ya da her
 * yüklemede yeniden şifrelese bile aynı ders, aynı başlık ve aynı içerik aynı özeti verir.
 */
const contentKey = (item) => hash([item.scope, item.kind, item.title, item.course || '', item.body || '', item.fields || {},
  item.dueAt || null, item.material?.extension || '', item.material?.size || null, (item.files || []).map((file) => [file.name, file.size || 0])]);

/**
 * Bir bölümde tek kontrolde bu kadar ya da daha çok kayıt yeni/güncellenmiş görünürse tek özet gönderilir.
 * Bu gerçek bir toplu yükleme de olabilir; yalnızca sayıdan içeriğin eski olduğu sonucu çıkarılmaz.
 * Kayıtlar sessizce işlenir, dosyaları indirilmez ve yalnızca tek bir özet uyarısı gider.
 */
export const BULK_NEW = 12;
/** Moodle dosya adresleri HTML kaçışlı (&amp;) gelebilir; istek atılırken ve tarayıcıya verilirken düzeltilir. */
export const fetchableURL = (url) => String(url || '').replace(/&amp;/g, '&');

/** Bir ara ekranın sayılması için aynı metne dönüşmesi gereken en az sayfa sayısı. */
export const GATE_MIN_PAGES = 3;
const isPageText = (item) => item?.id === `${item?.scope}/text`;
/** Ara ekran imzası: sayfa metninin en uzun satırları (seçici farkından doğan küçük baş/son farkları imzayı bozmaz). */
function gateSignature(body) {
  const lines = [...new Set(String(body || '').split('\n'))].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 5);
  return lines.join('').length >= 120 ? hash(lines) : null;
}
/**
 * Ara ekran (zorunlu anket, sözleşme onayı, duyuru duvarı…): site, form tamamlanana kadar bütün sayfalarda
 * aynı ekranı gösterir. Daha önce okunmuş farklı sayfalar aynı kontrolde aynı metne dönüşürse bu içerik
 * değişikliği değil engeldir: o sayfalar birleştirilmez, eski kayıtlar korunur ve "güncellendi" bildirimi gitmez.
 */
function gatedScopes(platform, snapshot) {
  if (!platform.gateChecked) {
    // Tek seferlik: bu koruma yokken ara ekran metni içerik diye kaydedilmiş olabilir. Öyle kayıtlar işaretlenir;
    // gerçek içerik geri geldiğinde sessizce düzeltilir.
    platform.gateChecked = true;
    const stored = new Map();
    for (const record of Object.values(platform.items)) {
      const signature = isPageText(record.item) && !record.missingSince ? gateSignature(record.item.body) : null;
      if (signature) stored.set(signature, [...(stored.get(signature) || []), record]);
    }
    for (const records of stored.values()) if (records.length >= GATE_MIN_PAGES) for (const record of records) record.gate = true;
  }
  const groups = new Map();
  for (const item of snapshot.items) {
    if (!isPageText(item) || !snapshot.complete.includes(item.scope) || !platform.scopes[item.scope]) continue;
    const old = platform.items[item.id];
    if (old && !old.gate && old.fingerprint === itemFingerprint(item)) continue; // değişmemiş sayfa ara ekran olamaz
    const signature = gateSignature(item.body);
    if (signature) groups.set(signature, [...(groups.get(signature) || []), item.scope]);
  }
  return new Set([...groups.values()].filter((scopes) => scopes.length >= GATE_MIN_PAGES).flat());
}

export function mergeSnapshot(state, name, snapshot, now, options = {}) {
  const platform = state.platforms[name] ||= { items: {}, scopes: {}, guards: {}, lastSuccess: null, error: null };
  // A confirmed survey wall establishes a baseline of what was visible, without merging an empty table.
  for (const scope of snapshot.surveyScopes || []) platform.scopes[scope] ||= now;
  const previousSurveyGrades = new Set(platform.surveyGrades || []);
  if (snapshot.surveyByGrade) {
    const hidden = new Set(previousSurveyGrades);
    for (const [id, required] of Object.entries(snapshot.surveyByGrade)) {
      if (required) hidden.add(id); else hidden.delete(id);
    }
    platform.surveyGrades = [...hidden];
  }
  let changes = 0;
  const gated = gatedScopes(platform, snapshot);
  for (const scope of gated) {
    snapshot.errors = snapshot.errors.filter((error) => error.scope !== scope);
    snapshot.errors.push({ scope, code: 'gate' });
  }
  for (const scope of snapshot.complete) {
    // Ara ekran gösteren sayfanın hiçbir bölümü (içerik listesi dahil) birleştirilmez.
    if (gated.has(scope) || gated.has(scope.replace(/^learning\//, ''))) continue;
    // Ayrıştırıcı geçişi: aynı eski ödevler topluca "yeni" diye gönderilmez; boş liste de yeni biçimi başlatır.
    const format = snapshot.formats?.[scope];
    if (format && platform.formats?.[scope] !== format) {
      for (const [id, record] of Object.entries(platform.items)) if (record.scope === scope) delete platform.items[id];
      delete platform.scopes[scope]; delete platform.guards[scope];
      (platform.formats ||= {})[scope] = format;
    }
    rebaselineLegacyLearning(platform, scope);
    const incoming = snapshot.items.filter((item) => item.scope === scope);
    const previous = Object.values(platform.items).filter((item) => item.scope === scope && !item.missingSince);
    if (previous.length >= 5 && incoming.length < previous.length * 0.5) {
      const signature = hash(incoming.map((item) => item.id).sort());
      const guard = platform.guards[scope];
      platform.guards[scope] = { signature, count: guard?.signature === signature ? guard.count + 1 : 1 };
      if (platform.guards[scope].count < 3) continue;
      queueNotice(state, `drop/${name}/${scope}`, name, 'İçerik beklenmedik şekilde azaldı', `${scope} bölümü üç ardışık kontrolde azaldı.`, now);
    } else delete platform.guards[scope];
    // Older snapshots recorded only summary IDs when access was blocked.
    const baseline = !platform.scopes[scope] && !incoming.some(item => item.summaryId && previousSurveyGrades.has(item.summaryId));
    const found = new Set();
    // Son bildirilen/kaydedilen içeriklerin özetleri: { özet: zaman }. Aynı kapsamda aynı içerikten birden çok
    // varsa sırası da özete girer; böylece gerçekten iki ayrı "Konu Özeti" ayrı sayılır.
    const recent = platform.recent ||= {};
    for (const [key, at] of Object.entries(recent)) if (now - at > REPEAT_WINDOW) delete recent[key];
    const known = new Set(Object.values(platform.items).filter((record) => record.scope === scope).map((record) => record.content).filter(Boolean));
    const seenContent = new Map(), batch = [];
    for (const item of incoming) {
      const fingerprint = itemFingerprint(item);
      const old = platform.items[item.id];
      found.add(item.id);
      const base = contentKey(item), n = (seenContent.get(base) || 0) + 1;
      seenContent.set(base, n);
      const content = n > 1 ? hash([base, n]) : base;
      if (old?.fingerprint === fingerprint) { delete old.missingSince; old.content = content; continue; }
      // Kimliği değişmiş ama içeriği aynı kayıt (ör. her yüklemede değişen bağlantı): yeniden bildirilmez.
      // Yayın tarihi eski diye içerik bastırılmaz: hoca eski tarihli ya da önceden hazırlanmış bir dosyayı
      // sonradan açabilir ve bu gerçek bir yeniliktir.
      const repeat = !old && (known.has(content) || Boolean(recent[content]));
      // Ara ekran metni diye kaydedilmiş sayfanın gerçek içeriğe dönmesi bir değişiklik değildir.
      const stale = repeat || Boolean(old?.gate);
      if (!baseline && !stale) {
        const id = `${name}/${++state.sequence}`;
        state.pending[id] = { id, platform: name, type: old ? 'updated' : 'new', item, previous: old?.item || null, detectedAt: now, attempts: 0, nextAttempt: now };
        changes++;
        batch.push({ id, item, previous: old?.item || null, type: old ? 'updated' : 'new', jobs: [] });
      }
      platform.items[item.id] = { scope, fingerprint, item, content };
      if (!old && !baseline && !repeat) recent[content] = now;
      if ((!baseline && !stale) || options.downloadExisting) for (const file of item.files || []) {
        const key = hash(`${name}/${file.url}/${file.version}`);
        if (!state.archive[key] && !state.fileJobs[key]) {
          state.fileJobs[key] = { key, platform: name, file, item, attempts: 0, nextAttempt: now, baseline: baseline || Boolean(stale) };
          if (!baseline && !stale) batch.at(-1)?.jobs.push(key);
        }
      }
    }
    if (batch.length >= BULK_NEW) {
      for (const entry of batch) { delete state.pending[entry.id]; for (const key of entry.jobs) delete state.fileJobs[key]; }
      changes -= batch.length;
      const courses = [...new Set(batch.map((entry) => entry.item.course).filter(Boolean))].slice(0, 4);
      const updated = batch.filter((entry) => entry.type === 'updated').length;
      queueNotice(state, `bulk/${name}/${scope}/${now}`, name, updated ? 'Toplu içerik değişikliği' : 'Toplu içerik göründü',
        `${courses.length ? `${courses.join(', ')}: ` : ''}${batch.length} kayıt aynı kontrolde topluca göründü.\n` +
        `${batch.length - updated} yeni kayıt, ${updated} güncellenen kayıt.\n` +
        'Bu gerçek bir toplu yükleme veya site yapısı değişikliği olabilir. ' +
        'Tek bir özet gönderildi; bütün kayıtlar panelde korunuyor.\nİlk kayıtlar:\n' +
        batch.slice(0, 10).map((entry) => `• ${entry.item.title}${entry.previous ? `: ${fieldDiff(entry.previous, entry.item).slice(0, 300)}` : ''}`).join('\n') +
        (batch.length > 10 ? `\n… ve ${batch.length - 10} kayıt daha` : ''), now);
    }
    for (const [id, record] of Object.entries(platform.items)) if (record.scope === scope && !found.has(id)) {
      // Kaybolan kayıt hemen silinmez: geri gelirse (site geçici olarak eksik döndüyse) yeniden bildirilmez.
      if (record.missingSince) { if (now - record.missingSince > MISSING_KEEP) delete platform.items[id]; continue; }
      if (!baseline && options.notifyRemoved) {
        const changeId = `${name}/${++state.sequence}`;
        state.pending[changeId] = { id: changeId, platform: name, type: 'removed', item: record.item, previous: record.item, detectedAt: now, attempts: 0, nextAttempt: now };
      }
      if (baseline) delete platform.items[id]; else record.missingSince = now;
    }
    platform.scopes[scope] = now;
  }
  if (!options.scoped) {
    if (snapshot.complete.length && !snapshot.errors.length) platform.lastSuccess = now;
    platform.error = snapshot.errors.length ? (gated.size ? 'gate' : 'partial') : null;
    platform.partial = snapshot.errors;
  }
  return changes;
}

/** once: aynı anahtar bir kez gönderildiyse bir daha gönderilmez (durum değişmedikçe hatırlatma yok). */
export function queueNotice(state, key, platform, title, body, now, { once = false } = {}) {
  if (state.notices[key] && (once || now - state.notices[key] < 86400000)) return;
  if (Object.values(state.pending).some((change) => change.noticeKey === key)) return;
  const id = `notice/${++state.sequence}`;
  state.pending[id] = { id, noticeKey: key, platform, type: 'notice', item: { title, body, kind: 'notice', url: '' }, detectedAt: now, attempts: 0, nextAttempt: now };
}

export const retryDelay = (attempts) => Math.min(60, 10 * 2 ** Math.min(3, Math.max(0, attempts - 1))) * 60000;

export function addActivity(state, entries) {
  state.activity = [...(Array.isArray(state.activity) ? state.activity : []), ...entries].slice(-200);
}
export function activityEntry(change, sentAt) {
  return { id: change.id, platform: change.platform, type: change.type,
    title: String(change.item?.title || '').slice(0, 300), course: String(change.item?.course || '').slice(0, 300),
    category: academicCategory(change.item), detail: fieldDiff(change.previous, change.item).slice(0, 1800),
    detectedAt: change.detectedAt, sentAt };
}

function* mailBatches(changes) {
  const levels = [new Map(), new Map()];
  for (const change of changes) {
    const sites = levels[change.noticeKey?.startsWith('incident/') ? 0 : 1];
    if (!sites.has(change.platform)) sites.set(change.platform, []);
    sites.get(change.platform).push(change);
  }
  for (const sites of levels) {
    const batches = [...sites].map(([site, records]) => {
      const ordinary = records.filter((record) => !(record.attempts >= 3));
      const groups = Array.from({ length: Math.ceil(ordinary.length / 30) }, (_, index) => ordinary.slice(index * 30, index * 30 + 30));
      groups.push(...records.filter((record) => record.attempts >= 3).map((record) => [record]));
      return { site, groups };
    });
    const totalRounds = Math.max(0, ...batches.map(({ groups }) => groups.length));
    for (let index = 0; index < totalRounds; index++) {
      for (const { site, groups } of batches) if (groups[index]) yield [site, groups[index]];
    }
  }
}

export async function flushQueue(state, io, now) {
  const due = Object.values(state.pending).filter((change) => change.nextAttempt <= now &&
    (!io.urgentOnly || change.noticeKey?.startsWith('incident/')) && (!io.filter || io.filter(change)));
  let sent = 0;
  for (const [name, group] of mailBatches(due)) {
    if (io.quota() < 1) return sent;
    // The pending batch is durable before attempting any external mail delivery.
    await io.save(state);
    try {
      await io.send(name, group);
    } catch {
      for (const change of group) { change.attempts = (change.attempts || 0) + 1; change.nextAttempt = now + retryDelay(change.attempts); }
      await io.save(state);
      continue;
    }
    for (const change of group) {
      if (change.noticeKey) state.notices[change.noticeKey] = now;
      delete state.pending[change.id]; sent++;
    }
    addActivity(state, group.map((change) => activityEntry(change, now)));
    // A crash between accepted delivery and this write may duplicate, never intentionally drops a queued batch.
    await io.save(state);
  }
  return sent;
}

export function fieldDiff(previous, item) {
  if (!previous) return item.body || '';
  const changes = [];
  if (previous.dueAt !== item.dueAt && (previous.dueAt || item.dueAt)) {
    changes.push(`Tarih güncellendi: ${previous.dueAt ? istanbulTime(previous.dueAt) : 'Belirtilmemiş'} → ${item.dueAt ? istanbulTime(item.dueAt) : 'Kaldırıldı'} (İstanbul)`);
  }
  const before = previous.fields || {}, after = item.fields || {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changes.push(`${key}: ${before[key] ?? '—'} → ${after[key] ?? '—'}`);
  }
  if (previous.body !== item.body && (previous.body || item.body)) {
    // Generic HTML table rows already contain all their fields in the description.
    const tableBody = Object.entries(after).map(([key, value]) => `${key}: ${value}`).join('\n');
    if (!changes.length || !item.body || (item.body !== tableBody && !Object.values(after).includes(item.body))) {
      changes.push(item.body || 'Açıklama kaldırıldı.');
    }
  }
  return changes.length ? changes.join('\n') : item.body || '';
}

export function digest(name, changes, formatDate) {
  const labels = { new: 'Yeni', updated: 'Güncellendi', removed: 'Kaldırıldı', notice: 'Uyarı', file_ready: 'Dosya hazır' };
  const lines = changes.map((change) => {
    const item = change.item;
    return `${labels[change.type]}: ${item.title}\n${item.course ? `Ders: ${item.course}\n` : ''}Tespit: ${formatDate(change.detectedAt)}${item.dueAt ? `\nSon tarih: ${formatDate(item.dueAt)}` : ''}\n${fieldDiff(change.previous, item).slice(0, 1800)}${item.url ? `\n${cleanURL(item.url)}` : ''}`;
  });
  const subject = `[UniTakip] ${name} · ${changes.length} değişiklik`;
  const body = lines.join('\n\n────────────────\n\n').slice(0, 90000);
  const html = `<div style="font:15px Arial,sans-serif;line-height:1.6"><h2>${escapeHTML(name)}</h2>${lines.map((line) => `<p>${escapeHTML(line).replace(/\n/g, '<br>')}</p>`).join('<hr>')}</div>`;
  return { subject, body, html };
}

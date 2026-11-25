import { classroomSnapshot, isClassroomURL } from './classroom.js';
import { brokerSnapshot } from './classroom-broker-client.js';
import { PUBLIC_ANNOUNCEMENTS_FORMAT } from './web-announcements.js';
import { MonitorError, safeURL, assertLoggedIn, emptyState, webSnapshot, mergeSnapshot, queueNotice, flushQueue, digest, withQuery, SUBREQUEST_BUDGET, recordUsage, usageStatus, fetchableURL } from './core.js';
import { SiteClient } from './http.js';
import { moodleSnapshot, moodleCall } from './moodle.js';
import { hash } from './hash.js';
import { address, smtp } from './smtp.js';
import { intervalMinutes, fileSource } from './panel.js';
import { queueStatusReport, reportStatus, platformFailure, platformRecovered } from './health.js';
import { ensureSites, effectiveSites, publicSiteURL, validId, credentialStatus, capabilities, panelLogin, credentialHash, sameBase, PRESETS } from './sites.js';
import { startLogin, finishLogin, LOGIN_TTL } from './relogin.js';
const date = (time) => new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' }).format(time);

export function assignmentTest(config, platformName, now = Date.now()) {
  if (!validId(platformName) || !Object.hasOwn(config.platforms || {}, platformName)) throw new MonitorError('config', 'Deneme platformu geçersiz.');
  const name = config.platforms[platformName].display_name;
  const mail = digest(name, [{ type: 'new', detectedAt: now, previous: null,
    item: { title: 'Ödeviniz var', kind: 'assignment', course: 'Deneme Dersi',
      body: 'Bu bir DENEME bildirimidir. Gerçek bir ödev duyurusu değildir. Bu sitenin bildirim gönderimi test ediliyor.', url: '' } }], date);
  mail.subject = `[DENEME] [UniTakip] ${name} — Ödeviniz var`;
  return mail;
}

export function configuration(raw, classroomOAuth = null, classroomBroker = null) {
  let config;
  try { config = JSON.parse(raw); } catch { throw new MonitorError('config', 'Bulut yapılandırması eksik.'); }
  address(config.to); address(config.smtp?.username);
  if (!/^[a-zA-Z0-9]{16}$/.test(config.smtp?.password || '') || !/@(?:gmail|googlemail)\.com$/i.test(config.smtp.username)) throw new MonitorError('config', 'Gmail uygulama şifresi eksik.');
  // Site sayısı sabit değildir (0..12). Kimlik bilgisi eksik bir site bütün kurulumu durdurmaz;
  // o site panelde "giriş gerekli" olarak görünür. Güvenlik kuralları ise kesindir.
  const entries = Object.entries(config.platforms || {});
  if (entries.length > 12) throw new MonitorError('config', 'En fazla 12 site desteklenir.');
  for (const [name, platform] of entries) {
    if (!validId(name) || !['moodle', 'webpages'].includes(platform.type)) throw new MonitorError('config', 'Desteklenmeyen site tanımı.');
    publicSiteURL(platform.base_url);
    const host = new URL(platform.base_url).hostname;
    for (const cookie of platform.cookies || []) if (!cookie.domain || cookie.domain.replace(/^\./, '') !== host) throw new MonitorError('config', 'İlgisiz site çerezi engellendi.');
    for (const page of platform.pages || []) safeURL(page.url, platform.base_url);
    if (platform.session_check_url) safeURL(platform.session_check_url, platform.base_url);
  }
  return { ...config, classroomOAuth, classroomBroker };
}

/** Kayıt ↔ Secrets birleşimi; state.sites yoksa mevcut kurulum aynı kimliklerle taşınır. */
export function siteSetup(config, state, now = Date.now()) {
  const changed = ensureSites(state, config, now);
  const { active, problems } = effectiveSites(state, config);
  for (const site of state.sites) {
    if (site.paused || problems[site.id] || !active[site.id] || active[site.id].type === 'classroom') continue;
    if (credentialStatus(site, config.platforms?.[site.id], panelLogin(state, site, config.platforms?.[site.id])) === 'missing') { delete active[site.id]; problems[site.id] = 'auth'; }
  }
  return { changed, active, problems };
}
export const siteName = (state, id) => state.sites?.find((site) => site.id === id)?.name || (id === 'system' ? 'Sistem' : id);
function recordProblem(state, id, code, now) {
  const record = state.platforms[id] ||= { items: {}, scopes: {}, guards: {}, lastSuccess: null };
  record.error = code;
  if (record.lastSuccess) platformFailure(state, id, code, now);
}

function clientFor(platform, old, deadline, options) {
  const revision = hash({ token: platform.token || '', cookies: platform.cookies || [] });
  const client = new SiteClient({ ...platform, cookies: old?.credentialRevision === revision ? old.cookies : platform.cookies }, { ...options, deadline });
  client.revision = revision;
  if (platform.type === 'webpages') {
    const ubys = new URL(platform.base_url).origin === UBYS_ORIGIN && client.cookies.length;
    // Limit recovery traffic to one verification per site visit.
    let retried = false;
    client.recoverPage = async (read, retryPage = true) => {
      let trusted = structuredClone(client.cookies);
      try { return await read(); }
      catch (error) {
        if (error.code !== 'auth') throw error;
        client.cookies = trusted;
        if (retried && !client.ubysSessionConfirmed) throw error;
      }
      if (!retried) {
        retried = true;
        if (ubys) {
          try { await checkWebSession(platform, client, true); }
          catch (error) { client.cookies = trusted; throw error; }
          client.ubysSessionConfirmed = true;
          if (!retryPage) return;
          trusted = structuredClone(client.cookies);
        }
        try { return await read(); }
        catch (error) {
          if (error.code !== 'auth') throw error;
          client.cookies = trusted;
          if (!client.ubysSessionConfirmed) throw error;
        }
      }
      throw new MonitorError('partial', 'ÜBYS oturumu açık ancak sayfa yeniden okunamadı.');
    };
  }
  if (platform.type === 'moodle') client.allowTokenCheck = true;
  return client;
}
function remember(state, name, client) {
  const record = state.platforms[name] ||= { items: {}, scopes: {}, guards: {}, lastSuccess: null };
  record.cookies = client.cookies; record.credentialRevision = client.revision;
}
async function snapshot(platform, client, now, previousFormats) {
  const data = platform.type === 'classroom' ? await (platform.connection.broker ? brokerSnapshot : classroomSnapshot)(platform, client)
    : platform.type === 'moodle' ? await moodleSnapshot(platform, client, now)
      : await webSnapshot(platform, client, null, previousFormats);
  if (!data.complete.length) throw new MonitorError(data.errors[0]?.code || 'site', 'Hiçbir bölüm okunamadı.');
  return data;
}

/** Read-only, does not persist state, send mail, or arm the scheduler. */
export async function probe(config, options = {}) {
  const result = {};
  for (const [name, platform] of Object.entries(config.platforms)) {
    try {
      const data = await snapshot(platform, clientFor(platform, null, Date.now() + 240000, options), Date.now());
      result[name] = { ok: !data.errors.length, items: data.items.length, scopes: data.complete.length, errors: data.errors };
    } catch (error) { result[name] = { ok: false, code: error.code || 'site' }; }
  }
  return result;
}

export function status(state, store = null) {
  return { ...reportStatus(state), usage: usageStatus(state, Date.now(), store?.usage?.() ?? null), armed: Boolean(state.armed), lastTick: state.lastTick || null, lastScheduledAt: state.lastScheduledAt || null, lastScheduledSource: state.lastScheduledSource || null, scheduledRuns: state.scheduledRuns || 0, pending: Object.keys(state.pending).length,
    files: Object.keys(state.archive).length, platforms: Object.fromEntries(Object.entries(state.platforms).map(([name, record]) => [name,
      { lastSuccess: record.lastSuccess || null, error: record.error || null, items: Object.keys(record.items).length, partial: record.partial || [],
        ...(record.lastGradeCheckAt ? { lastGradeCheckAt: record.lastGradeCheckAt } : {}) }])) };
}

export async function baseline(config, store, options = {}) {
  const state = await store.load();
  if (state.armed) return status(state, store);
  // Each platform's baseline is complete or absent. One expired login cannot stop the others.
  const staged = structuredClone(state), now = Date.now(), deadline = now + 240000;
  const budget = { used: 0, limit: SUBREQUEST_BUDGET };
  const { active, problems } = siteSetup(config, staged, now);
  let successful = 0;
  for (const [name, code] of Object.entries(problems)) recordProblem(staged, name, code, now);
  for (const [name, platform] of Object.entries(active)) {
    const client = clientFor(platform, staged.platforms[name], deadline, { ...options, budget }), startedWith = budget.used;
    try {
      const data = await snapshot(platform, client, now);
      if (data.errors.length) throw new MonitorError('partial', 'Bu platformun başlangıcı eksik.');
      mergeSnapshot(staged, name, data, now, { downloadExisting: Boolean(platform.download_existing_files && platform.download_files) });
      successful++;
    } catch (error) {
      remember(staged, name, client);
      // Payı önceki siteler tükettiyse bu sitenin suçu yok: ilk takip kontrolünde sessizce başlatılır.
      if (error.code !== 'quota' || startedWith === 0) platformFailure(staged, name, error.code || 'site', now);
      else successful++;
    }
    remember(staged, name, client);
  }
  // Hiç site yoksa (yeni kurulum; siteler panelden eklenecek) takip boş başlatılır. Panelden eklenen
  // her yeni site ilk kontrolde sessiz başlangıç yapar. Site varsa ama hiçbiri okunamadıysa başlatılmaz.
  const attempted = Object.keys(active).length + Object.keys(problems).length;
  if (!successful && attempted) throw new MonitorError('auth', 'Hiçbir site başlatılamadı; eski durum korundu.');
  staged.armed = true; staged.startedAt ||= now; staged.lastTick = now; staged.nextFullAt = now + 3600000;
  await store.save(staged);
  return status(staged, store);
}

async function files(state, sites, clients, store, now, deadline, budget = null) {
  let count = 0;
  for (const job of Object.values(state.fileJobs)) {
    if (count >= 2 || Date.now() > deadline - 60000 || (budget && budget.used >= budget.limit)) break;
    if (job.failed || job.nextAttempt > now) continue;
    const platform = sites[job.platform];
    if (!platform || !clients[job.platform]) continue; // duraklatılmış site: iş korunur
    if (!platform.download_files) { delete state.fileJobs[job.key]; continue; }
    count++;
    try {
      if (job.file.size > 20 * 1024 * 1024) throw new MonitorError('size', 'Dosya 20 MB sınırını aşıyor.');
      const url = platform.type === 'moodle' ? withQuery(fetchableURL(job.file.url), { token: platform.token }) : job.file.url;
      const response = await clients[job.platform].request(url, { binary: true });
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) throw new MonitorError('file', 'Dosya yerine giriş sayfası geldi.');
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', response.bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
      const existing = Object.values(state.archive).some((entry) => entry.sha === sha);
      if (!existing) await store.archive(sha, response.bytes);
      state.archive[job.key] = { sha, name: job.file.name, size: response.bytes.length };
      delete state.fileJobs[job.key];
      if (!job.baseline && !Object.values(state.pending).some((change) => change.platform === job.platform && change.item.id === job.item.id)) {
        const id = `${job.platform}/${++state.sequence}`;
        state.pending[id] = { id, platform: job.platform, type: 'file_ready', item: job.item, previous: null, detectedAt: now, attempts: 0, nextAttempt: now };
      }
      await store.save(state);
    } catch (error) {
      if (error.code === 'quota') break; // dosya sonraki kontrolde indirilir
      job.attempts++; job.nextAttempt = now + 3600000;
      if (job.attempts >= 3 || ['size', 'storage'].includes(error.code)) {
        job.failed = true;
        queueNotice(state, `file/${job.key}`, job.platform, 'Dosya arşivlenemedi', 'Dosya sınırı, depolama kotası veya indirme sorunu var. Bildirimdeki özgün site bağlantısını kullanabilirsin.', now);
      }
    }
  }
}

export async function sendGroup(connect, config, state, store, name, group) {
  const mail = digest(siteName(state, name), group, date);
  mail.id = group.map((change) => change.id).sort().join('/');
  if (group.every((change) => change.noticeKey?.startsWith('status/'))) mail.subject = `[UniTakip] ${group[0].item.title}`;
  else {
    // Konu sorunun kendisini söyler: yalnızca gerçekten oturum düştüğünde "Yeniden giriş gerekiyor" yazar.
    const incident = group.find((change) => change.noticeKey?.startsWith('incident/'));
    if (incident) mail.subject = `[UniTakip] ${siteName(state, name)} · ${incident.item.title}`;
  }
  const attachments = [], seen = new Set(); let total = 0;
  for (const change of group) for (const file of change.item.files || []) {
    const saved = state.archive[hash(`${name}/${file.url}/${file.version}`)];
    if (!saved || seen.has(saved.sha)) continue;
    seen.add(saved.sha);
    if (total + saved.size > 15 * 1024 * 1024) { mail.body += `\nEk sınırını aşan dosya: ${saved.name}. Özgün site bağlantısını kullan.`; continue; }
    let bytes;
    try { bytes = await store.read(`file/${saved.sha}`); } catch { /* Fall back to the source link in the notification. */ }
    if (bytes) { attachments.push({ bytes, name: saved.name }); total += bytes.length; }
    else mail.body += `\n${saved.name} arşivden okunamadı. Dosyaya kaynak site bağlantısından erişebilirsin.`;
  }
  try { await smtp(connect, config, mail, attachments); }
  catch (error) {
    if (!attachments.length || !error.contentRejected) throw error;
    mail.body += '\nEkli gönderim başarısız oldu. Dosyalar arşivde korundu; özgün site bağlantısından erişebilirsin.';
    await smtp(connect, config, mail);
  }
}

/** Bu sorunlar sürerken tam tarama RETRY_MINUTES'ta bir yinelenir (kendiliğinden ya da sahibinin sitede yaptığı işlemle düzelebilir). */
const RETRY_SOON = new Set(['gate', 'partial', 'network', 'maintenance', 'deadline', 'site']);
const RETRY_MINUTES = 20;
/** Elle başlatılan kontrolün zamanlayıcıyı beklemeden sürdürülebileceği en uzun süre. */
const MANUAL_CHAIN = 10 * 60 * 1000;
/** Tam okunmayan çerezli bir sitenin oturum yoklaması için ayrılan dış istek (yoklama + olası bir yönlendirme). */
const PING_COST = 2;
const UBYS_ORIGIN = 'https://ubys.bartin.edu.tr';

async function checkWebSession(platform, client, forceProtected = false) {
  const configuredCheck = platform.session_check_url;
  const needsProtectedCheck = new URL(platform.base_url).origin === UBYS_ORIGIN &&
    (forceProtected || !configuredCheck || new URL(configuredCheck, platform.base_url).href === `${UBYS_ORIGIN}/`);
  // The public ÜBYS homepage can return 200 without a student session. This read-only endpoint requires it.
  const protectedCheck = `${UBYS_ORIGIN}/conversation/GetMyNewMessagesCount`;
  const response = await client.request(needsProtectedCheck ? protectedCheck : configuredCheck || platform.pages[0].url);
  assertLoggedIn(response.text, platform);
  if (needsProtectedCheck && (response.url !== protectedCheck || !/^application\/json\b/i.test(response.headers.get('content-type') || ''))) {
    throw new MonitorError('site', 'ÜBYS oturumu beklenen yanıtla doğrulanamadı.');
  }
}

/** ÜBYS notlarını olağan tam taramalar arasında kontrol eder. Not sayfası yoksa oturumu yoklar. */
export async function keepUbysSession(config, store, options = {}) {
  const state = await store.load();
  const site = state.sites?.find(({ id, preset, paused }) => id === 'ubys' && preset === 'bartin-ubys' && !paused);
  if (!state.armed || !site) return;
  const platform = effectiveSites({ ...state, sites: [site] }, config).active.ubys;
  if (!platform?.cookies?.length) return;

  const record = state.platforms.ubys;
  const now = Date.now();
  const gradeGap = intervalMinutes(state) === 10 ? 9 : 4;
  const readGrades = record?.lastSuccess && !state.manualRequestedAt && !state.fullRound &&
    now - Math.max(record.lastSuccess, record.lastGradeCheckAt || 0) >= gradeGap * 60000 &&
    platform.features?.grades !== false && platform.pages.some(({ kind }) => kind === 'grade');
  const budget = { used: 0, limit: readGrades ? SUBREQUEST_BUDGET - PING_COST : PING_COST };
  const client = clientFor(platform, record, now + (readGrades ? 90000 : 30000), { ...options, budget });
  try {
    if (readGrades) {
      const data = await webSnapshot({ ...platform, features: { ...platform.features, assignments: false } },
        client, (page) => page.kind === 'grade', record.formats);
      if (data.complete.length && !data.errors.length) {
        mergeSnapshot(state, 'ubys', data, now, { scoped: true });
        record.lastGradeCheckAt = now;
      } else if (!client.ubysSessionConfirmed) {
        budget.limit = SUBREQUEST_BUDGET;
        await checkWebSession(platform, client);
      }
    } else await checkWebSession(platform, client);
    remember(state, 'ubys', client);
    platformRecovered(state, 'ubys', now);
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    // Hatalı yanıt oturumu değiştirmez. Olağan kontrol hatayı doğrulayıp uyarıları yönetir.
  }
  recordUsage(state, now, { requests: budget.used });
  await store.save(state);
  if (readGrades && options.connect) {
    let sent = 0;
    await flushQueue(state, {
      save: (value) => store.save(value),
      filter: (change) => change.platform === 'ubys' && change.item.kind === 'grade',
      quota: () => sent < 2 && Date.now() < now + 60000 ? 1 : 0,
      send: async (name, group) => {
        sent++;
        await sendGroup(options.connect, config, state, store, name, group);
        recordUsage(state, now, { run: false, mails: 1 });
      },
    }, now);
  }
}

export async function tick(config, store, connect, { force = false, scheduled = false, ...options } = {}) {
  const state = await store.load();
  if (!state.armed) return status(state, store);
  if (options.panelURL && /^https:\/\/[^/]+$/.test(options.panelURL)) state.panelURL = options.panelURL;
  const now = Date.now(), deadline = now + 240000;
  if (state.lastTick && now < state.lastTick - 300000) state.nextFullAt = now;
  // Yarım kalan tam tarama (süre veya dış istek payı doldu) en fazla iki saat boyunca kaldığı yerden sürdürülür.
  const resumed = state.fullRound && now - state.fullRound.startedAt < 7200000 && now >= state.fullRound.startedAt ? state.fullRound : null;
  const interval = intervalMinutes(state);
  // The main cron runs every ten minutes. Allow a faster arrival than the previous
  // invocation by a few seconds without re-reading after a recent manual check.
  const fastCron = scheduled === 'cron' && interval === 10 && now - (state.lastFullAt || 0) >= 5 * 60000;
  const full = force || Boolean(state.manualRequestedAt) || !state.nextFullAt || now >= state.nextFullAt || Boolean(resumed) || fastCron;
  const manual = force || Boolean(state.manualRequestedAt);
  const round = { startedAt: resumed?.startedAt || now, done: [...(resumed?.done || [])] };
  const budget = { used: 0, limit: SUBREQUEST_BUDGET };
  let mails = 0, deferred = false;
  const flush = (urgentOnly = false) => flushQueue(state, { save: (value) => store.save(value), urgentOnly,
    quota: () => Date.now() < deadline - 35000 && mails < 6 ? 1 : 0,
    send: async (name, group) => { mails++; await sendGroup(connect, config, state, store, name, group); recordUsage(state, now, { run: false, mails: 1 }); } }, now);
  const { active, problems } = siteSetup(config, state, now);
  for (const [name, code] of Object.entries(problems)) recordProblem(state, name, code, now);
  if (Object.keys(problems).length) { await store.save(state); await flush(true); }
  const clients = {}, entries = Object.entries(active), contacted = new Set(); let completedLoop = true, reads = 0;
  // İlerleme yalnızca Worker belleğinde tutulur; panelin mevcut yoklamalarıyla gelir, kayıt yazımı eklemez.
  const checked = new Set(round.done.filter((id) => Object.hasOwn(active, id)));
  const progress = (current) => options.onProgress?.({ startedAt: now, full, completed: checked.size, total: entries.length, current });
  const postpone = () => { completedLoop = false; deferred = true; };
  // Oturumu boşta kalınca düşen siteler çerezle bağlananlardır; Moodle anahtarı boşta kalmakla düşmez.
  const needsPing = (name) => active[name].type === 'webpages' && !contacted.has(name);
  const reserve = (except) => PING_COST * entries.filter(([name]) => name !== except && needsPing(name)).length;
  /** Bir sitenin bu kontroldeki tek ziyareti: tam okuma (read) ya da tek istekli oturum yoklaması. 'defer': pay yetmedi. */
  const visit = async (name, platform, read) => {
    const startedWith = budget.used;
    const previousCookies = JSON.stringify(state.platforms[name]?.cookies || platform.cookies || []);
    const hadError = Boolean(state.platforms[name]?.error || state.platforms[name]?.healthIncident);
    const client = clients[name] ||= clientFor(platform, state.platforms[name], deadline, { ...options, budget, minIntervalMs: manual ? 1000 : 1500 });
    progress(name);
    const trusted = structuredClone(client.cookies);
    contacted.add(name);
    try {
      if (read) {
        const data = await snapshot(platform, client, now, state.platforms[name]?.formats);
        mergeSnapshot(state, name, data, now, { notifyRemoved: platform.notify_removed, downloadExisting: false });
        // Sonraki turlarda, kalan paya sığmayacak okuma hiç başlatılmasın diye sitenin istek maliyeti hatırlanır.
        state.platforms[name].readCost = budget.used - startedWith;
        state.platforms[name].lastConnectivityAt = now; // içerik okunabildiyse oturum açıktır (anket ekranı olsa bile)
        if (data.errors.length) {
          platformFailure(state, name, data.errors.some((error) => error.code === 'gate') ? 'gate' : 'partial', now);
          await store.save(state); await flush(true);
        } else platformRecovered(state, name, now, { full: true });
      } else if (platform.type !== 'moodle') {
        const ping = () => checkWebSession(platform, client);
        if (client.recoverPage) await client.recoverPage(ping, false);
        else await ping();
        platformRecovered(state, name, now);
      } else {
        const info = await moodleCall(client, 'core_webservice_get_site_info');
        if (!info?.userid) throw new MonitorError('site', 'Moodle bağlantısı doğrulanamadı.');
        platformRecovered(state, name, now);
      }
    } catch (error) {
      // Giriş sayfası yanıtıyla gelen anonim çerezler saklı oturumun üzerine yazılmaz: yanıt tek seferlik bir
      // aksaklıksa (site yeniden başladı, güvenlik duvarı araya girdi) oturum bir sonraki kontrolde aynen sürer.
      if (error.code === 'auth') client.cookies = trusted;
      remember(state, name, client);
      // Pay başka siteler ya da yoklama ayrımı yüzünden yetmediyse bu site hatalı değildir: uyarı üretmeden sonraki
      // kontrole bırakılır. Site payın tamamını tek başına tüketiyorsa hiçbir zaman okunamaz; o zaman sahibine bildirilir.
      if (error.code === 'quota' && (startedWith > 0 || budget.limit < SUBREQUEST_BUDGET || !read)) {
        if (read) state.platforms[name].readCost = startedWith > 0 ? Math.max(state.platforms[name].readCost || 0, budget.used - startedWith + 1) : SUBREQUEST_BUDGET;
        await store.save(state);
        progress(null);
        return 'defer';
      }
      platformFailure(state, name, error.code || 'site', now);
      await store.save(state); await flush(true);
    }
    remember(state, name, client);
    if (read) round.done.push(name);
    const last = state.platforms[name].lastSuccess || state.startedAt;
    // Kesinti başına bir kez: site düzelmeden aynı uyarı her gün yinelenmez.
    if (last && now - last >= 86400000) queueNotice(state, `stale/${name}/${last}`, name, '24 saattir başarılı kontrol yok', siteName(state, name), now, { once: true });
    if (read || hadError || JSON.stringify(client.cookies) !== previousCookies) await store.save(state);
    checked.add(name); progress(null);
    return 'ok';
  };
  if (full) {
    // 1) Tam okumalar. Tur birkaç kontrole yayılabilir; her kontrolde sığdığı kadar site okunur.
    for (const [name, platform] of entries) {
      if (round.done.includes(name)) continue; // bu turda zaten okundu
      if (Date.now() > deadline - 30000 || budget.used >= SUBREQUEST_BUDGET) { postpone(); break; }
      const cost = state.platforms[name]?.readCost || 0, spare = reserve(name);
      if (reads === 0) {
        // Kontrolün ilk okuması: ihtiyacı biliniyor ve sığıyorsa öteki sitelerin yoklamasına pay bırakır.
        budget.limit = cost && cost <= SUBREQUEST_BUDGET - spare ? SUBREQUEST_BUDGET - spare : SUBREQUEST_BUDGET;
      } else {
        // Kalan paya sığmayacağı bilinen okuma başlatılmaz: yarım okuma hem payı hem siteyi boşuna yorar.
        if (cost > SUBREQUEST_BUDGET - spare - budget.used) { postpone(); continue; }
        budget.limit = SUBREQUEST_BUDGET - spare;
      }
      reads++;
      if (await visit(name, platform, true) === 'defer') { postpone(); break; }
    }
    budget.limit = SUBREQUEST_BUDGET;
    // 2) Oturum yoklamaları. Bu kontrolde okunmayan çerezli siteler tek istekle yoklanır; böylece hiçbir sitenin
    // oturumu tam tarama boyunca (30-40 dk) dokunulmadan kalıp boşta düşmez.
    for (const [name, platform] of entries) {
      if (!needsPing(name)) continue;
      if (Date.now() > deadline - 45000 || budget.used >= budget.limit) break;
      await visit(name, platform, false);
    }
  } else for (const [name, platform] of entries) {
    if (platform.type === 'classroom') continue;
    if (Date.now() > deadline - 30000 || budget.used >= budget.limit) { postpone(); break; }
    if (await visit(name, platform, false) === 'defer') { postpone(); break; }
  }
  if (full && completedLoop) {
    // Okuma sorunu (anket ekranı, eksik bölüm, ulaşılamayan site) sürerken tam tarama sıklaşır: sorun giderildiğinde
    // panel ve e-posta bir saat beklemeden haberdar olur. Sahibinin çözmesi gereken kalıcı durumlarda sıklaşmaz.
    const troubled = entries.some(([name]) => RETRY_SOON.has(state.platforms[name]?.healthIncident?.code));
    state.nextFullAt = now + Math.min(interval, troubled ? RETRY_MINUTES : Infinity) * 60000;
    state.lastFullAt = now; state.manualRequestedAt = null; delete state.fullRound;
  }
  else if (full) state.fullRound = round;
  if (Object.keys(clients).length === Object.keys(active).length) await files(state, active, clients, store, now, deadline, budget);
  queueStatusReport(state, config, now);
  if (scheduled) { state.lastScheduledAt = now; state.lastScheduledSource = typeof scheduled === 'string' ? scheduled : 'cron'; state.scheduledRuns = (state.scheduledRuns || 0) + 1; }
  recordUsage(state, now, { requests: budget.used, deferred });
  state.lastTick = now; await store.save(state);
  await flush();
  // Bütçeye sığmayan hızlı tur ilerleme kaydettiyse bir sonraki cron'u beklemeden devam eder.
  const manualPending = Boolean(state.manualRequestedAt && state.fullRound && now - state.manualRequestedAt < MANUAL_CHAIN);
  const fastPending = interval === 10 && Boolean(state.fullRound) && round.done.length > (resumed?.done.length || 0) &&
    now - round.startedAt < MANUAL_CHAIN;
  return { ...status(state, store), manualPending, fastPending };
}

/**
 * Paneldeki "indir": takip edilen bir Moodle dosyasını bulutun kendi anahtarıyla getirir; kullanıcının siteye
 * girmesi gerekmez. Yalnızca kayıtlı dosya kimliği kabul edilir; adres sitenin kendi alan adına sabittir ve
 * anahtar yanıtta ya da yönlendirmede asla dışarı çıkmaz.
 */
export async function fileDownload(config, state, id, fetcher = (...args) => fetch(...args)) {
  ensureSites(state, config);
  const source = fileSource(state, String(id || '').slice(0, 600));
  if (!source) throw new MonitorError('not_found', 'Dosya bulunamadı.');
  const site = state.sites.find((entry) => entry.id === source.site);
  const platform = effectiveSites({ ...state, sites: [{ ...site, paused: false }] }, config).active[source.site];
  if (!platform || platform.type !== 'moodle' || !platform.token) throw new MonitorError('auth', 'Bu dosya için bulut bağlantısı yok.');
  const target = withQuery(safeURL(fetchableURL(source.url), platform.base_url), { token: platform.token });
  let response;
  try { response = await fetcher(target, { redirect: 'manual', headers: { 'User-Agent': platform.user_agent || 'UniTakip/0.1 (personal read-only monitor)', Accept: '*/*' } }); }
  catch { throw new MonitorError('network', 'Siteye ulaşılamadı.'); }
  const type = response.headers.get('content-type') || '';
  if (response.status !== 200 || /text\/html|application\/json/i.test(type)) {
    await response.body?.cancel().catch(() => {});
    throw new MonitorError([401, 403].includes(response.status) || /json/i.test(type) ? 'auth' : response.status === 404 ? 'not_found' : 'site', 'Dosya alınamadı.');
  }
  return { body: response.body, type, length: response.headers.get('content-length'), name: source.name };
}

const TEST_KINDS = { announcement: 'announcements', forum_post: 'announcements', file: 'files', material: 'files', assignment: 'assignments', quiz: 'exams', event: 'exams', grade: 'grades', page: 'pageChanges', table_row: 'pageChanges', module: 'files', section: 'pageChanges', course: 'pageChanges' };
/**
 * Tek bir sitenin bağlantı testi: okur, hiçbir kaydı birleştirmez ve e-posta göndermez.
 * Yalnızca özet (sayılar ve ilk birkaç başlık) döndürür; ham HTML, çerez veya token dönmez.
 */
export async function testSite(config, state, id, options = {}) {
  const site = (state.sites || []).find((entry) => entry.id === id);
  if (!site) throw new MonitorError('config', 'Site bulunamadı.');
  const bridge = isClassroomURL(site.base_url) ? state.classroomBridges?.[id] : null;
  if (bridge?.receivedAt) {
    const { problems } = effectiveSites({ ...state, sites: [{ ...site, paused: false }] }, config);
    const code = problems[id] || null;
    return { id, ok: !code, code, at: bridge.receivedAt, items: Object.values(state.platforms[id]?.items || {}).filter((item) => !item.missingSince).length };
  }
  const now = Date.now(), result = { id, at: now, ok: false, code: null, items: 0, counts: {}, preview: [], scopes: { complete: 0, failed: 0 } };
  const { active, problems } = effectiveSites({ ...state, sites: [{ ...site, paused: false }] }, config);
  let code = problems[id] || null;
  if (!code && !isClassroomURL(site.base_url) && credentialStatus(site, config.platforms?.[id], panelLogin(state, site, config.platforms?.[id])) === 'missing') code = 'auth';
  if (!code) {
    try {
      const platform = active[id];
      const data = await snapshot(platform, clientFor(platform, null, now + 90000, { ...options, budget: { used: 0, limit: SUBREQUEST_BUDGET } }), now, state.platforms[id]?.formats);
      const counts = {};
      for (const item of data.items) { const key = TEST_KINDS[item.kind] || 'pageChanges'; counts[key] = (counts[key] || 0) + 1; }
      const [firstError] = data.errors;
      const failure = firstError && !data.complete.length && data.errors.every((entry) => entry.code === firstError.code) ? firstError.code : 'partial';
      Object.assign(result, { ok: !data.errors.length, code: firstError ? failure : null, items: data.items.length, counts,
        preview: data.items.filter((item) => item.kind !== 'page').slice(0, 8).concat(data.items.filter((item) => item.kind === 'page').slice(0, 1))
          .slice(0, 8).map((item) => ({ kind: TEST_KINDS[item.kind] || 'pageChanges', title: String(item.title || '').slice(0, 140), course: String(item.course || '').slice(0, 100) })),
        detectedAnnouncements: Object.values(data.formats || {}).some((format) => format.startsWith(PUBLIC_ANNOUNCEMENTS_FORMAT)),
        scopes: { complete: data.complete.length, failed: data.errors.length } });
    } catch (error) { code = ['auth', 'network', 'site', 'maintenance', 'size', 'deadline', 'unsafe', 'config', 'quota', 'classroom_policy', 'classroom_setup'].includes(error.code) ? error.code : 'site'; }
  }
  if (code) result.code = code;
  state.siteTests ||= {};
  state.siteTests[id] = { at: result.at, ok: result.ok, code: result.code, items: result.items, counts: result.counts, preview: result.preview, scopes: result.scopes,
    ...(result.detectedAnnouncements ? { detectedAnnouncements: true } : {}) };
  return result;
}
export { capabilities };

/**
 * Panelden yeniden giriş. pending, SMS bekleyen ve süresi sınırlı girişlerin çerezlerini tutar.
 * Şifre ve kod saklanmaz. Başarılı girişte yeni oturum şifreli durumda
 * state.platforms[id].login altında saklanır; bilgisayardan yeni paket yüklenirse o paket önceliklidir.
 */
export async function siteLogin(config, state, id, payload, pending, now = Date.now(), fetcher = undefined) {
  const site = (state.sites || []).find((entry) => entry.id === id);
  if (!site) throw new MonitorError('config', 'Site bulunamadı.');
  if (isClassroomURL(site.base_url)) throw new MonitorError('unsupported', 'Google Classroom için Google hesabını bağla.');
  const local = config.platforms?.[id];
  const platform = {
    base_url: site.base_url, type: site.type, pages: site.pages || [], session_check_url: site.session_check_url,
    logged_out_markers: site.logged_out_markers || PRESETS[site.preset]?.logged_out_markers || [],
  };
  for (const [key, entry] of pending) if (now - entry.at > LOGIN_TTL) pending.delete(key);
  let result;
  if (payload.code !== undefined) {
    const entry = pending.get(id);
    if (!entry) throw new MonitorError('expired', 'Giriş süresi doldu; baştan başla.');
    try { result = await finishLogin(platform, entry.pending, payload.code, fetcher); }
    catch (error) { if (error.code !== 'code') pending.delete(id); throw error; }
  } else result = await startLogin(platform, { username: payload.username, password: payload.password }, fetcher);
  if (result.status === 'code') { pending.set(id, { pending: result.pending, at: now }); return { ok: true, step: 'code' }; }
  pending.delete(id);
  const record = state.platforms[id] ||= { items: {}, scopes: {}, guards: {}, lastSuccess: null, error: null };
  record.login = { base_url: site.base_url, revision: credentialHash(local && sameBase(local.base_url, site.base_url) ? local : null), at: now,
    ...(result.token ? { token: result.token } : { cookies: result.cookies }) };
  // Eski (düşmüş) oturum çerezleri bırakılır; sonraki kontrol panel girişinin çerezleriyle başlar.
  delete record.cookies; delete record.credentialRevision;
  const incident = record.healthIncident;
  if (incident?.code === 'auth') {
    for (const [key, change] of Object.entries(state.pending)) {
      if (change.noticeKey === incident.key) delete state.pending[key];
    }
  }
  if (state.siteTests?.[id]?.code === 'auth') delete state.siteTests[id];
  platformRecovered(state, id, now, { full: false });
  if (record.error === 'auth') record.error = null;
  return { ok: true, step: 'done' };
}

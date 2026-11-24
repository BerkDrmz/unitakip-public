/* global Utilities, PropertiesService, UrlFetchApp, ScriptApp, LockService, MailApp */
import { Cipher, hash } from './cipher.js';
import { SiteClient, MonitorError, assertLoggedIn, emptyState, mergeSnapshot, queueNotice, flushQueue, digest, safeURL, withQuery } from './core.js';
import { moodleSnapshot } from './moodle.js';
import { webSnapshot } from './core.js';

const ALLOWED = { sanal: 'https://sanalogrenme.bartin.edu.tr', ogreniyorum: 'https://ogreniyorum.net/mooc/', ubys: 'https://ubys.bartin.edu.tr/' };
const props = () => PropertiesService.getScriptProperties();
const date = (time) => Utilities.formatDate(new Date(time), 'Europe/Istanbul', 'dd.MM.yyyy HH:mm');
const nonce = () => `${Date.now()}/${Utilities.getUuid()}`;

function configuration() {
  const properties = props();
  const count = Number(properties.getProperty('UNITAKIP_CONFIG_PARTS'));
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new MonitorError('config', 'Önce şifreli bulut yapılandırmasını içe aktar.');
  const key = properties.getProperty('UNITAKIP_CLOUD_KEY');
  const cipher = new Cipher(key || '');
  let config;
  try { config = JSON.parse(cipher.open(Array.from({ length: count }, (_, i) => properties.getProperty(`UNITAKIP_CONFIG_${i}`) || '').join(''))); }
  catch { throw new MonitorError('config', 'Bulut yapılandırması çözülemedi; mevcut takip durumu korunuyor.'); }
  if (!/^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/.test(config.to)) throw new MonitorError('config', 'Tek bir geçerli bildirim adresi gerekli.');
  for (const [name, platform] of Object.entries(config.platforms || {})) {
    if (!ALLOWED[name] || platform.base_url !== ALLOWED[name]) throw new MonitorError('config', 'Yapılandırmada desteklenmeyen site var.');
    for (const page of platform.pages || []) safeURL(page.url, platform.base_url);
  }
  return { config, cipher };
}

function transport(url, options) {
  const response = UrlFetchApp.fetch(url, {
    method: options.method || 'get', payload: options.payload,
    headers: options.headers, muteHttpExceptions: true, followRedirects: false,
    validateHttpsCertificates: true, timeoutSeconds: 25,
  });
  const blob = options.binary ? response.getBlob() : null;
  return { status: response.getResponseCode(), headers: response.getAllHeaders(), text: options.binary ? '' : response.getContentText(), blob };
}

/** Uses drive.file, granting access only to files created/opened by this script. */
class DriveStore {
  constructor(cipher) { this.cipher = cipher; this.properties = props(); }

  request(path, options = {}, upload = false) {
    let response;
    try {
      response = UrlFetchApp.fetch(`https://www.googleapis.com/${upload ? 'upload/' : ''}drive/v3/${path}`, {
        ...options, headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
        muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true,
      });
    } catch { throw new MonitorError('storage', 'Google Drive bağlantısı kurulamadı; bekleyen bildirimler gönderilmedi.'); }
    if (response.getResponseCode() >= 300) throw new MonitorError('storage', 'Google Drive durum kaydı başarısız; izin veya depolama kotasını kontrol et.');
    return response;
  }

  create(name, mimeType, parent) {
    const response = this.request('files?fields=id', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ name, mimeType, ...(parent ? { parents: [parent] } : {}) }) });
    return JSON.parse(response.getContentText()).id;
  }

  initialize() {
    if (this.properties.getProperty('UNITAKIP_STATE_FILE')) return;
    let folder = this.properties.getProperty('UNITAKIP_FOLDER');
    if (!folder) { folder = this.create('UniTakip — Özel Bulut Takibi', 'application/vnd.google-apps.folder'); this.properties.setProperty('UNITAKIP_FOLDER', folder); }
    const id = this.create('takip-durumu.enc', 'text/plain', folder);
    this.write(id, this.cipher.seal(JSON.stringify(emptyState()), nonce()));
    // Publish the pointer only after the initial state has been saved successfully.
    this.properties.setProperty('UNITAKIP_STATE_FILE', id);
  }

  read() {
    const id = this.properties.getProperty('UNITAKIP_STATE_FILE');
    if (!id) throw new MonitorError('config', 'Takip henüz kurulmadı; installTracking çalıştırılmalı.');
    let state;
    try { state = JSON.parse(this.cipher.open(this.request(`files/${encodeURIComponent(id)}?alt=media`).getContentText())); }
    catch { throw new MonitorError('storage', 'Kalıcı takip durumu okunamadı; başlangıç durumu sıfırlanmadı.'); }
    if (state.schema !== 1 || !state.platforms || !state.pending || !state.archive) throw new MonitorError('storage', 'Takip durumu şeması geçersiz; eski kayıt korunuyor.');
    return state;
  }

  write(id, content, contentType = 'text/plain') {
    this.request(`files/${encodeURIComponent(id)}?uploadType=media`, { method: 'patch', contentType, payload: content }, true);
  }

  save(state) {
    const id = this.properties.getProperty('UNITAKIP_STATE_FILE');
    if (!id) throw new MonitorError('storage', 'Durum dosyası eksik; yeniden başlangıç oluşturulmadı.');
    this.write(id, this.cipher.seal(JSON.stringify(state), nonce()));
  }

  archive(name, blob) {
    const folder = this.properties.getProperty('UNITAKIP_FOLDER');
    const safeName = String(name).replace(/[\x00-\x1f/\\]/g, '_').slice(0, 100);
    const id = this.create(safeName, blob.getContentType() || 'application/octet-stream', folder);
    this.write(id, blob, blob.getContentType() || 'application/octet-stream');
    return id;
  }

  blob(id, name) { return this.request(`files/${encodeURIComponent(id)}?alt=media`).getBlob().setName(name); }
}

function clients(config, state, deadline) {
  const result = {};
  for (const [name, platform] of Object.entries(config.platforms)) {
    const old = state.platforms[name];
    const revision = hash({ token: platform.token || '', cookies: platform.cookies || [] });
    result[name] = new SiteClient({ ...platform, cookies: old?.credentialRevision === revision ? old.cookies : platform.cookies }, transport, Date.now, Utilities.sleep, deadline);
    result[name].revision = revision;
  }
  return result;
}

function snapshot(name, platform, client, now) {
  const result = platform.type === 'moodle' ? moodleSnapshot(platform, client, now) : webSnapshot(platform, client);
  if (!result.complete.length) throw new MonitorError('network', 'Hiçbir izleme bölümü okunamadı.');
  return result;
}

function rememberClient(state, name, client) {
  const platform = state.platforms[name] ||= { items: {}, scopes: {}, guards: {}, lastSuccess: null };
  platform.cookies = client.cookies;
  platform.credentialRevision = client.revision;
}

function processFiles(state, config, siteClients, store, deadline, now) {
  let processed = 0;
  for (const job of Object.values(state.fileJobs)) {
    if (processed >= 3 || Date.now() > deadline - 45000) break;
    if (job.attempts >= 3 || job.nextAttempt > now || job.failed) continue;
    processed++;
    try {
      if ((job.file.size || 0) > 20 * 1024 * 1024) throw new MonitorError('size', 'Dosya bulut sürümünün 20 MB sınırını aşıyor.');
      const client = siteClients[job.platform];
      const platform = config.platforms[job.platform];
      const downloadURL = platform.type === 'moodle' ? withQuery(job.file.url, { token: platform.token }) : job.file.url;
      const response = client.request(downloadURL, { binary: true });
      const contentType = String(Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/json')) throw new MonitorError('file', 'Dosya yerine giriş veya hata sayfası geldi.');
      const bytes = response.blob.getBytes();
      if (bytes.length > 20 * 1024 * 1024) throw new MonitorError('size', 'Dosya bulut sürümünün 20 MB sınırını aşıyor.');
      const sha = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map((n) => ((n + 256) % 256).toString(16).padStart(2, '0')).join('');
      const existing = Object.values(state.archive).find((entry) => entry.sha === sha);
      const driveId = existing?.driveId || store.archive(job.file.name, response.blob);
      state.archive[job.key] = { driveId, name: job.file.name, size: bytes.length, sha };
      delete state.fileJobs[job.key];
      const waiting = Object.values(state.pending).some((change) => change.platform === job.platform && change.item.id === job.item.id);
      if (!job.baseline && !waiting) {
        const id = `${job.platform}/${++state.sequence}`;
        state.pending[id] = { id, platform: job.platform, type: 'file_ready', item: job.item, previous: null, detectedAt: now, attempts: 0, nextAttempt: now };
      }
      store.save(state);
    } catch (error) {
      job.attempts++; job.nextAttempt = now + 3600000;
      if (job.attempts >= 3 || error.code === 'size') {
        job.failed = true;
        queueNotice(state, `file/${job.key}`, job.platform, 'Dosya arşivlenemedi', `${job.file.name}: ${error.code === 'size' ? '20 MB bulut sınırını aşıyor.' : 'Üç denemede indirilemedi; özgün site bağlantısını kullan.'}`, now);
      }
    }
  }
}

function sendDigest(config, state, store, platformName, group) {
  const mail = digest(config.platforms[platformName]?.display_name || 'Sistem', group, date);
  const attachments = [], files = new Set();
  let total = 0;
  for (const change of group) for (const file of change.item.files || []) {
    const saved = state.archive[hash(`${platformName}/${file.url}/${file.version}`)];
    if (!saved || files.has(saved.driveId)) continue;
    files.add(saved.driveId);
    if (total + saved.size <= 15 * 1024 * 1024) {
      attachments.push(store.blob(saved.driveId, saved.name)); total += saved.size;
    } else mail.body += `\nArşiv: https://drive.google.com/file/d/${saved.driveId}/view`;
  }
  try { MailApp.sendEmail({ to: config.to, subject: mail.subject, body: mail.body, htmlBody: mail.html, attachments, name: 'UniTakip' }); }
  catch {
    if (!attachments.length) throw new MonitorError('mail', 'E-posta gönderilemedi; bildirim kuyrukta kaldı.');
    // An oversized/rejected attachment must not block all other changes.
    const links = [...files].map((id) => `https://drive.google.com/file/d/${id}/view`).join('\n');
    MailApp.sendEmail({ to: config.to, subject: mail.subject, body: `${mail.body}\n\nDosyalar özel Drive arşivinde:\n${links}`, name: 'UniTakip' });
  }
}

function run(config, cipher) {
  const started = Date.now(), deadline = started + 270000;
  const store = new DriveStore(cipher);
  const state = store.read();
  if (state.lastTick && started < state.lastTick - 300000) state.nextFullAt = started;
  const full = !state.nextFullAt || started >= state.nextFullAt;
  const siteClients = clients(config, state, deadline);
  for (const [name, platform] of Object.entries(config.platforms)) {
    if (Date.now() > deadline - 30000) break;
    const client = siteClients[name];
    try {
      if (full) {
        const data = snapshot(name, platform, client, started);
        mergeSnapshot(state, name, data, started, { downloadExisting: Boolean(platform.download_existing_files), notifyRemoved: Boolean(platform.notify_removed) });
        if (data.errors.length) queueNotice(state, `partial/${name}`, name, 'Bazı bölümler okunamadı', 'Eski bölüm verileri korundu. Site değişikliği veya geçici erişim sorunu olabilir.', started);
        console.log(JSON.stringify({ platform: name, items: data.items.length, complete: data.complete.length, partial: data.errors.length }));
      } else if (platform.type !== 'moodle') {
        const response = client.request(platform.session_check_url || platform.base_url);
        assertLoggedIn(response.text, platform);
      }
      rememberClient(state, name, client);
    } catch (error) {
      rememberClient(state, name, client);
      state.platforms[name].error = error.code || 'site';
      if (error.code === 'auth') queueNotice(state, `auth/${name}`, name, 'Yeniden giriş gerekli', `${platform.display_name}: oturum kapandı. Mac'te yeniden giriş yapıp bulut kimlik bilgilerini güncelle.`, started);
      else if (error.code !== 'deadline') queueNotice(state, `error/${name}`, name, 'Platform kontrolü başarısız', error.code === 'network' ? 'Siteye ağ bağlantısı kurulamadı. Sonraki kontrolde yeniden denenecek.' : 'Bakım veya site yapısı değişikliği olabilir. Önceki takip kayıtları korundu.', started);
    }
    const last = state.platforms[name]?.lastSuccess;
    if (last && started - last > 86400000) queueNotice(state, `stale/${name}`, name, '24 saattir başarılı kontrol yok', platform.display_name, started);
    store.save(state);
  }
  if (full) state.nextFullAt = started + 3600000;
  processFiles(state, config, siteClients, store, deadline, started);
  const weeklyKey = Utilities.formatDate(new Date(started), 'Europe/Istanbul', 'yyyy-ww');
  if (Utilities.formatDate(new Date(started), 'Europe/Istanbul', 'u') === '1' && Number(Utilities.formatDate(new Date(started), 'Europe/Istanbul', 'H')) >= 9 && state.lastWeekly !== weeklyKey) {
    queueNotice(state, `weekly/${weeklyKey}`, 'system', 'Haftalık durum raporu', Object.entries(state.platforms).map(([name, platform]) => `${name}: ${platform.error || 'ok'}, son başarı: ${platform.lastSuccess ? date(platform.lastSuccess) : 'henüz yok'}`).join('\n'), started);
    state.lastWeekly = weeklyKey;
  }
  state.lastTick = started;
  store.save(state);
  flushQueue(state, {
    save: (value) => store.save(value),
    quota: () => Date.now() < deadline - 15000 ? MailApp.getRemainingDailyQuota() : 0,
    send: (name, group) => sendDigest(config, state, store, name, group),
  }, started);
}

export function importCredentials() {
  const { config } = configuration();
  console.log(`Şifreli yapılandırma geçerli: ${Object.keys(config.platforms).length} platform. Otomatik takip başlatılmadı.`);
}

/** Read-only Google-IP test; no Drive state writes, no mail, no trigger installation. */
export function testConnection() {
  const { config } = configuration();
  const started = Date.now(), deadline = started + 270000;
  const report = {};
  for (const [name, platform] of Object.entries(config.platforms)) {
    const client = new SiteClient(platform, transport, Date.now, Utilities.sleep, deadline);
    try {
      const data = snapshot(name, platform, client, started);
      report[name] = { ok: true, items: data.items.length, complete: data.complete.length, partial: data.errors.length };
    } catch (error) { report[name] = { ok: false, error: error.code || 'site' }; }
  }
  props().setProperty('UNITAKIP_LAST_PROBE', JSON.stringify(report));
  console.log(JSON.stringify(report));
  return report;
}

export function installTracking() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new MonitorError('lock', 'Başka bir kontrol çalışıyor.');
  try {
    const report = testConnection();
    if (Object.values(report).some((result) => !result.ok || result.partial)) throw new MonitorError('site', 'Google üzerinden tüm bölümler doğrulanmadı; takip başlatılmadı.');
    const { config, cipher } = configuration();
    new DriveStore(cipher).initialize();
    // Installation only establishes the baseline; the timed job starts later.
    const store = new DriveStore(cipher), state = store.read();
    const deadline = Date.now() + 240000;
    for (const [name, platform] of Object.entries(config.platforms)) {
      if (Object.keys(state.platforms[name]?.scopes || {}).length) continue;
      const client = new SiteClient(platform, transport, Date.now, Utilities.sleep, deadline);
      const data = snapshot(name, platform, client, Date.now());
      mergeSnapshot(state, name, data, Date.now(), { downloadExisting: Boolean(platform.download_existing_files) });
      rememberClient(state, name, client);
      store.save(state);
    }
    state.nextFullAt = Date.now() + 3600000;
    store.save(state);
    if (!ScriptApp.getProjectTriggers().some((trigger) => trigger.getHandlerFunction() === 'scheduledCheck')) ScriptApp.newTrigger('scheduledCheck').timeBased().everyMinutes(10).create();
    console.log('Bulut takibi kuruldu: saatlik tam tarama, aralarda hafif oturum kontrolü. Kurulum e-posta göndermedi.');
  } finally { lock.releaseLock(); }
}

export function scheduledCheck() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { const { config, cipher } = configuration(); run(config, cipher); }
  catch (error) {
    const day = Utilities.formatDate(new Date(), 'Europe/Istanbul', 'yyyy-MM-dd');
    if (props().getProperty('UNITAKIP_FATAL_DAY') !== day) {
      try {
        const { config } = configuration();
        if (MailApp.getRemainingDailyQuota() > 0) {
          MailApp.sendEmail(config.to, '[UniTakip] Bulut kontrolü tamamlanamadı', `Kontrol kodu: ${error.code || 'runtime'}. Önceki kayıtlar sıfırlanmadı. Apps Script izinlerini, çalışma kaydını ve Drive kotasını kontrol et.`);
          props().setProperty('UNITAKIP_FATAL_DAY', day);
        }
      } catch { /* Google also reports failed clock-trigger executions to the owner. */ }
    }
    throw new Error(`UniTakip kontrolü tamamlanamadı (${error.code || 'runtime'}); gizli değerler loglanmadı.`);
  } finally { lock.releaseLock(); }
}

export function stopTracking() {
  for (const trigger of ScriptApp.getProjectTriggers()) if (trigger.getHandlerFunction() === 'scheduledCheck') ScriptApp.deleteTrigger(trigger);
  console.log('Yalnızca UniTakip tetikleyicisi durduruldu; kayıtlar ve arşiv korundu.');
}

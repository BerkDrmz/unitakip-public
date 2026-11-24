import { load } from 'cheerio/slim';
import * as URI from 'uri-js';
import { hash } from './cipher.js';

export class MonitorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const VOLATILE = /(?:\d+\s*(?:saniye|sn|dakika|dk|saat|gün|hafta)\s*önce|son\s+(?:görülme|giriş|erişim|oturum|ziyaret|güncelleme)|last\s+(?:login|seen|access|updated)|\d+\s*(?:kişi|kullanıcı|ziyaretçi|user)s?\s*(?:çevrimiçi|online)|çevrimiçi\s+kullanıcılar|online\s+users|sunucu\s+saati|ziyaretçi\s+sayısı|copyright|©|^\d{1,2}:\d{2}(?::\d{2})?$|^\d{1,2}[./]\d{1,2}[./]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$)/i;
const SECRET_QUERY = /^(?:token|wstoken|privatetoken|sesskey|password|sifre|code|access_token)$/i;
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

export class SiteClient {
  constructor(platform, transport, clock, sleep, deadline) {
    this.platform = platform; this.transport = transport; this.clock = clock; this.sleep = sleep; this.deadline = deadline;
    this.cookies = platform.cookies || []; this.last = 0;
  }

  request(url, options = {}) {
    let target = safeURL(url, this.platform.base_url);
    const method = options.method || 'get';
    if (method !== 'get' && !options.moodle) throw new MonitorError('unsafe', 'Yazma işlemi engellendi.');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.clock() > this.deadline - 15000) throw new MonitorError('deadline', 'Kontrol sonraki çalıştırmada devam edecek.');
      const wait = 1500 - (this.clock() - this.last);
      if (wait > 0) this.sleep(wait);
      this.last = this.clock();
      let response;
      try {
        response = this.transport(target, { ...options, headers: { Accept: options.moodle ? 'application/json' : 'text/html,*/*', Cookie: cookieHeader(this.cookies, target, this.clock()) } });
      } catch { if (attempt < 2) { this.sleep(1000 * 2 ** attempt); continue; } throw new MonitorError('network', 'Siteye ağ bağlantısı kurulamadı.'); }
      this.cookies = updateCookies(this.cookies, response.headers || {}, target, this.clock());
      if ([401, 403].includes(response.status)) throw new MonitorError('auth', 'Oturum geçersiz; yeniden giriş gerekiyor.');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'location')?.[1];
        if (!location || method !== 'get' || attempt === 2) throw new MonitorError('auth', 'Giriş veya yönlendirme kontrolü gerekiyor.');
        target = safeURL(URI.resolve(target, location), this.platform.base_url);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 2) { this.sleep(1000 * 2 ** attempt); continue; }
        throw new MonitorError('network', 'Site geçici olarak yanıt vermiyor.');
      }
      if (response.status >= 400) throw new MonitorError('site', 'İzleme sayfası artık erişilebilir değil.');
      return { ...response, url: target };
    }
    throw new MonitorError('network', 'Site yanıtı alınamadı.');
  }
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

/** Parse existing configured read-only pages. No forms are submitted and no links are crawled. */
export function webSnapshot(platform, client, pageFilter = null) {
  const items = [], complete = [], errors = [];
  for (const page of platform.pages) {
    if (pageFilter && !pageFilter(page)) continue;
    try {
      const response = client.request(page.url);
      assertLoggedIn(response.text, platform);
      items.push(...parsePage(response.text, response.url, page));
      complete.push(page.id);
    } catch (error) {
      if (error.code === 'auth' || error.code === 'deadline') throw error;
      errors.push({ scope: page.id, code: error.code || 'site' });
    }
  }
  return { items, complete, errors };
}

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
    const values = rows.slice(firstIsHeader ? 1 : 0).map(ownCells).filter((cells) => cells.some(Boolean));
    if (!values.length) return;
    const width = Math.max(...values.map((cells) => cells.length));
    const headers = firstIsHeader ? ownCells(rows[0]) : Array.from({ length: width }, (_, i) => `Sütun ${i + 1}`);
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
    if (body) items.push(makeItem(page.id, 'text', page.kind || 'page', page.course_name || text($('title').text()) || page.id, { body, url: cleanURL(url), course: page.course_name || '' }));
  }
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export const emptyState = () => ({ schema: 1, sequence: 0, platforms: {}, pending: {}, archive: {}, fileJobs: {}, notices: {}, lastWeekly: null });

export function mergeSnapshot(state, name, snapshot, now, options = {}) {
  const platform = state.platforms[name] ||= { items: {}, scopes: {}, guards: {}, lastSuccess: null, error: null };
  let changes = 0;
  for (const scope of snapshot.complete) {
    const incoming = snapshot.items.filter((item) => item.scope === scope);
    const previous = Object.values(platform.items).filter((item) => item.scope === scope);
    if (previous.length >= 5 && incoming.length < previous.length * 0.5) {
      const signature = hash(incoming.map((item) => item.id).sort());
      const guard = platform.guards[scope];
      platform.guards[scope] = { signature, count: guard?.signature === signature ? guard.count + 1 : 1 };
      if (platform.guards[scope].count < 3) continue;
      queueNotice(state, `drop/${name}/${scope}`, name, 'İçerik beklenmedik şekilde azaldı', `${scope} bölümü üç ardışık kontrolde azaldı.`, now);
    } else delete platform.guards[scope];
    const baseline = !platform.scopes[scope];
    const found = new Set();
    for (const item of incoming) {
      const fingerprint = hash(item);
      const old = platform.items[item.id];
      found.add(item.id);
      if (old?.fingerprint === fingerprint) continue;
      if (!baseline) {
        const id = `${name}/${++state.sequence}`;
        state.pending[id] = { id, platform: name, type: old ? 'updated' : 'new', item, previous: old?.item || null, detectedAt: now, attempts: 0, nextAttempt: now };
        changes++;
      }
      platform.items[item.id] = { scope, fingerprint, item };
      if (!baseline || options.downloadExisting) for (const file of item.files || []) {
        const key = hash(`${name}/${file.url}/${file.version}`);
        if (!state.archive[key] && !state.fileJobs[key]) state.fileJobs[key] = { key, platform: name, file, item, attempts: 0, nextAttempt: now, baseline };
      }
    }
    for (const [id, record] of Object.entries(platform.items)) if (record.scope === scope && !found.has(id)) {
      if (!baseline && options.notifyRemoved) {
        const changeId = `${name}/${++state.sequence}`;
        state.pending[changeId] = { id: changeId, platform: name, type: 'removed', item: record.item, previous: record.item, detectedAt: now, attempts: 0, nextAttempt: now };
      }
      delete platform.items[id];
    }
    platform.scopes[scope] = now;
  }
  platform.lastSuccess = now;
  platform.error = snapshot.errors.length ? 'partial' : null;
  platform.partial = snapshot.errors;
  return changes;
}

export function queueNotice(state, key, platform, title, body, now) {
  if (state.notices[key] && now - state.notices[key] < 86400000) return;
  if (Object.values(state.pending).some((change) => change.noticeKey === key)) return;
  const id = `notice/${++state.sequence}`;
  state.pending[id] = { id, noticeKey: key, platform, type: 'notice', item: { title, body, kind: 'notice', url: '' }, detectedAt: now, attempts: 0, nextAttempt: now };
}

export const retryDelay = (attempts) => Math.min(60, 10 * 2 ** Math.min(3, Math.max(0, attempts - 1))) * 60000;

export function flushQueue(state, io, now) {
  const names = [...new Set(Object.values(state.pending).filter((change) => change.nextAttempt <= now).map((change) => change.platform))];
  let sent = 0;
  for (const name of names) {
    const all = Object.values(state.pending).filter((change) => change.platform === name && change.nextAttempt <= now);
    const groups = all.some((change) => change.attempts >= 3) ? all.map((change) => [change]) : Array.from({ length: Math.ceil(all.length / 30) }, (_, i) => all.slice(i * 30, i * 30 + 30));
    for (const group of groups) {
      if (io.quota() < 1) return sent;
      // The pending batch is durable before attempting any external mail delivery.
      io.save(state);
      try {
        io.send(name, group);
      } catch {
        for (const change of group) { change.attempts++; change.nextAttempt = now + retryDelay(change.attempts); }
        io.save(state);
        continue;
      }
      for (const change of group) {
        if (change.noticeKey) state.notices[change.noticeKey] = now;
        delete state.pending[change.id]; sent++;
      }
      // A crash between accepted delivery and this write may duplicate, never intentionally drops a queued batch.
      io.save(state);
    }
  }
  return sent;
}

export function fieldDiff(previous, item) {
  if (previous?.fields && item.fields) return Object.entries(item.fields).filter(([key, value]) => previous.fields[key] !== value).map(([key, value]) => `${key}: ${previous.fields[key] ?? '—'} → ${value}`).join('\n');
  if (previous?.dueAt !== item.dueAt && item.dueAt) return `Teslim tarihi güncellendi: ${new Date(item.dueAt).toISOString()}`;
  return item.body || '';
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

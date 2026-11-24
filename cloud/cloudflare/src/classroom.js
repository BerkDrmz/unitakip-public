import { MonitorError, makeItem } from './core.js';

export const CLASSROOM_HOME = 'https://classroom.google.com/';
export const CLASSROOM_CALLBACK = '/oauth/classroom/callback';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const API_URL = 'https://classroom.googleapis.com/v1/';
const SCOPES = ['openid', ...['courses', 'coursework.me', 'announcements'].map((scope) =>
  `https://www.googleapis.com/auth/classroom.${scope}.readonly`)];
const COOKIE = '__Host-unitakip-classroom';
const OAUTH_TTL = 600;
const MAX_RESPONSE = 3 * 1024 * 1024;

export function isClassroomURL(value) {
  try { return new URL(value).origin === new URL(CLASSROOM_HOME).origin; } catch { return false; }
}

export function classroomOAuth(env) {
  return env.CLASSROOM_CLIENT_ID && env.CLASSROOM_CLIENT_SECRET
    ? { id: env.CLASSROOM_CLIENT_ID, secret: env.CLASSROOM_CLIENT_SECRET } : null;
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const classroomRandomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export function classroomCookie(value, maxAge = OAUTH_TTL, suffix = '') {
  return `${COOKIE}${suffix}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function classroomConsent(oauth, origin, site, session, now = Date.now(), state = classroomRandomToken()) {
  const verifier = classroomRandomToken();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const redirect = new URL(CLASSROOM_CALLBACK, origin).href;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({ client_id: oauth.id, redirect_uri: redirect,
    response_type: 'code', scope: SCOPES.join(' '), state, access_type: 'offline',
    prompt: 'consent select_account', code_challenge_method: 'S256', code_challenge: base64url(new Uint8Array(digest)) });
  return {
    url: url.href, cookie: classroomCookie(state),
    pending: { state, verifier, redirect, site, session: session.id, expiresAt: Math.min(session.expiry, now + OAUTH_TTL * 1000) },
  };
}

export function validClassroomCallback(request, pending, now = Date.now(), suffix = '') {
  if (!pending || pending.expiresAt <= now) return false;
  const url = new URL(request.url);
  const name = COOKIE + suffix + '=';
  const browserState = (request.headers.get('Cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(name))?.slice(name.length);
  return Boolean(browserState && browserState === pending.state && url.searchParams.get('state') === pending.state &&
    new URL(CLASSROOM_CALLBACK, url.origin).href === pending.redirect);
}

export async function classroomJSON(url, init, { fetcher = (...args) => fetch(...args), budget, deadline, timeout = 15000 } = {}) {
  if (deadline && Date.now() > deadline - 20000) throw new MonitorError('deadline', 'Classroom okuma süresi doldu.');
  if (budget) {
    if (budget.used >= budget.limit) throw new MonitorError('quota', 'Classroom için dış istek payı doldu.');
    budget.used++;
  }
  let response, payload;
  try {
    response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (response.status >= 300 && response.status < 400) throw new MonitorError('network', 'Classroom yönlendirmesi reddedildi.');
    if (response.status === 429 || response.status >= 500) throw new MonitorError('network', 'Google geçici olarak ulaşılamıyor.');
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new MonitorError('size', 'Classroom yanıtı çok büyük.');
    const reader = response.body?.getReader();
    const decoder = new TextDecoder(), chunks = [];
    let size = 0;
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE) throw new MonitorError('size', 'Classroom yanıtı çok büyük.');
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    payload = JSON.parse(chunks.join('') + decoder.decode());
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    if (response?.status === 401) throw new MonitorError('auth', 'Google bağlantısını yeniden kur.');
    if (response?.status === 403) throw new MonitorError('classroom_policy', 'Classroom erişim izni verilmedi.');
    throw new MonitorError('network', 'Google yanıtı okunamadı.');
  } finally { await response?.body?.cancel().catch(() => {}); }
  if (response.status === 401 || payload?.error === 'invalid_grant') throw new MonitorError('auth', 'Google bağlantısını yeniden kur.');
  if (response.status === 403 || payload?.error === 'invalid_client') throw new MonitorError('classroom_policy', 'Classroom erişim izni veya Google ayarları uygun değil.');
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new MonitorError('site', 'Classroom isteği tamamlanamadı.');
  return payload;
}

async function token(oauth, data, options) {
  return classroomJSON(TOKEN_URL, { method: 'POST',
    body: new URLSearchParams({ client_id: oauth.id, client_secret: oauth.secret, ...data }) }, options);
}

export async function exchangeClassroomCode(oauth, pending, code, options) {
  const result = await token(oauth, { grant_type: 'authorization_code', code, redirect_uri: pending.redirect, code_verifier: pending.verifier }, options);
  const granted = new Set(String(result.scope || '').split(/\s+/));
  if (!result.access_token || !result.refresh_token || SCOPES.slice(1).some((scope) => !granted.has(scope))) {
    throw new MonitorError('classroom_policy', 'Classroom takibi için Google izinleri eksik.');
  }
  const profile = await classroomJSON(USERINFO_URL, { headers: { Authorization: `Bearer ${result.access_token}` } }, options);
  if (typeof profile.sub !== 'string' || !profile.sub) throw new MonitorError('auth', 'Google hesabı doğrulanamadı.');
  return { clientId: oauth.id, account: profile.sub, refreshToken: result.refresh_token };
}

async function pages(path, field, params, accessToken, options) {
  const url = new URL(path, API_URL);
  const entries = [], visited = new Set();
  let next;
  do {
    if (next) {
      if (visited.has(next)) throw new MonitorError('site', 'Classroom sayfalaması tekrarlanıyor.');
      visited.add(next); url.searchParams.set('pageToken', next);
    } else url.search = new URLSearchParams({ pageSize: '100', ...params });
    const data = await classroomJSON(url.href, { headers: { Authorization: `Bearer ${accessToken}` } }, options);
    if (data[field] !== undefined && !Array.isArray(data[field])) throw new MonitorError('site', 'Classroom liste biçimi tanınmadı.');
    entries.push(...(data[field] || []));
    next = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
  } while (next);
  return entries;
}

function classroomDue(entry) {
  if (!entry.dueDate) return null;
  const { year, month, day } = entry.dueDate;
  const { hours = 0, minutes = 0, seconds = 0 } = entry.dueTime || { hours: 23, minutes: 59 };
  const value = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  return Number.isFinite(value) ? value : null;
}

function classroomLink(value, course) {
  if (!isClassroomURL(value)) return isClassroomURL(course) ? course : CLASSROOM_HOME;
  const url = new URL(value);
  if (url.username || url.password) return CLASSROOM_HOME;
  return url.origin + url.pathname;
}

// Use identical record identities and presentation for both Classroom transports.
export function classroomItem(course, kind, scope, entry) {
  const body = String(entry.description || entry.text || '').slice(0, 12000);
  const date = String(entry.creationTime || '').slice(0, 10);
  return makeItem(scope, String(entry.id), kind, entry.title || body.slice(0, 110) || 'Classroom duyurusu', {
    course: course.name, body, url: classroomLink(entry.alternateLink, course.alternateLink),
    ...(kind === 'assignment' ? { dueAt: classroomDue(entry) } : { fields: date ? { Tarih: date } : {} }),
  });
}

export async function classroomSnapshot(platform, options) {
  const { oauth, connection } = platform;
  const credentials = await token(oauth, { grant_type: 'refresh_token', refresh_token: connection.refreshToken }, options);
  const access = credentials.access_token;
  if (!access) throw new MonitorError('auth', 'Google bağlantısını yeniden kur.');
  if (typeof credentials.refresh_token === 'string' && credentials.refresh_token) connection.refreshToken = credentials.refresh_token;
  const courses = await pages('courses', 'courses', { studentId: 'me', courseStates: 'ACTIVE',
    fields: 'nextPageToken,courses(id,name,alternateLink)' }, access, options);
  const items = [], complete = ['classroom/courses'], errors = [];
  for (const course of courses) {
    if (!course.id || !course.name) continue;
    const route = `courses/${encodeURIComponent(course.id)}`;
    for (const [resource, kind, stateParam, fields] of [
      ['courseWork', 'assignment', 'courseWorkStates', 'id,title,description,alternateLink,dueDate,dueTime'],
      ['announcements', 'announcement', 'announcementStates', 'id,text,alternateLink,creationTime'],
    ]) {
      const scope = `classroom/${course.id}/${resource}`;
      try {
        const entries = await pages(`${route}/${resource}`, resource, { [stateParam]: 'PUBLISHED', fields: `nextPageToken,${resource}(${fields})` }, access, options);
        for (const entry of entries) {
          if (entry.id) items.push(classroomItem(course, kind, scope, entry));
        }
        complete.push(scope);
      } catch (error) {
        if (['auth', 'deadline', 'quota'].includes(error.code)) throw error;
        errors.push({ scope, code: error.code || 'site' });
      }
    }
  }
  return { items, complete, errors };
}

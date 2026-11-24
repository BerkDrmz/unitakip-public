import { CLASSROOM_CALLBACK, classroomConsent, classroomCookie, classroomOAuth, classroomRandomToken,
  classroomSnapshot, exchangeClassroomCode, validClassroomCallback } from './classroom.js';
import { brokerToken, httpsOrigin } from './classroom-broker-client.js';
import { Vault } from './store.js';

const FLOW_TTL = 10 * 60 * 1000;
const RETENTION = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_INTERVAL = 60 * 1000;
const HEADERS = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (data, status = 200) => Response.json(data, { status, headers: HEADERS });
const bearer = (request) => {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') && brokerToken(value.slice(7)) ? value.slice(7) : null;
};
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const matches = async (value, expected) => {
  if (!value || !expected) return false;
  const hash = await digest(value);
  return hash.reduce((diff, byte, index) => diff | (byte ^ expected[index]), 0) === 0;
};

async function body(request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let output = '';
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      size += value.length;
      if (size > 1024) throw new Error('body_limit');
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function page(title, content, { cookie, close = false, status = 200 } = {}) {
  const nonce = close ? classroomRandomToken() : '';
  return new Response(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${content}</main>${close ? `<script nonce="${nonce}">window.close()</script>` : ''}</body></html>`, {
    status, headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8',
      ...(close ? { 'Content-Security-Policy': HEADERS['Content-Security-Policy'] + `; script-src 'nonce-${nonce}'` } : {}),
      ...(cookie ? { 'Set-Cookie': cookie } : {}) },
  });
}

function privacy() {
  return page('UniTakip Classroom gizliliği', `
    <p>Bu hizmet, izin verdiğiniz Google hesabındaki aktif Classroom derslerinin adlarını, ödevlerini ve duyurularını okuyup bağlantıyı başlattığınız UniTakip paneline aktarır. Panel, ayarlarınıza göre seçtiğiniz e-posta adresine bildirim gönderebilir.</p>
    <p>Arka plan takibi için bir Google yenileme anahtarı ve hesabın Google tarafından verilen kimliği servis veritabanında şifreli tutulur. Classroom içerikleri ortak serviste kalıcı olarak saklanmaz. Panele aktarılan kayıtlar o panelin kendi veritabanında tutulur.</p>
    <p>Classroom sitesini panelden kaldırdığınızda ortak servis bağlantıyı siler. Kullanılmayan bağlantılar 30 gün içinde temizlenir. Google erişimini <a href="https://myaccount.google.com/connections">Google Hesabı bağlantılarından</a> da kaldırabilirsiniz. Veri silme veya gizlilik için Google izin ekranındaki destek adresine yazabilirsiniz.</p>
    <p>Google Workspace API’lerinden alınan bilgilerin kullanımı, Sınırlı Kullanım şartları dahil <a href="https://developers.google.com/workspace/workspace-api-user-data-developer-policy">Google Workspace kullanıcı verileri politikasına</a> tabidir.</p>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = httpsOrigin(env.BROKER_ORIGIN);
    if (url.origin !== origin) return json({ error: 'not_found' }, 404);
    const ready = Boolean(classroomOAuth(env) && env.BROKER_STATE_KEY && env.BROKER_MODE === 'enabled');
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, ready });
    if (request.method === 'GET' && url.pathname === '/privacy') return privacy();
    if (request.method === 'GET' && url.pathname === '/') return page('UniTakip Classroom bağlantı servisi',
      '<p>UniTakip, Google Classroom’daki ödev ve duyuruları takip eder. Bağlantıyı kendi UniTakip panelindeki Classroom kartından başlatabilirsiniz.</p><p><a href="/privacy">Gizlilik</a> · <a href="https://github.com/BerkDrmz/unitakip-public">UniTakip GitHub deposu</a></p>');
    if (!ready) return json({ error: 'classroom_setup' }, 503);
    try {
      if (request.method === 'POST' && url.pathname === '/v1/start') {
        const key = bearer(request);
        if (!key) return json({ error: 'unauthorized' }, 401);
        if (!(await env.FLOW_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) {
          return json({ error: 'rate_limit' }, 429);
        }
        const panelOrigin = httpsOrigin(JSON.parse(await body(request)).origin);
        if (!panelOrigin || panelOrigin === origin) return json({ error: 'bad_request' }, 400);
        const ticket = classroomRandomToken();
        const result = await env.FLOW.getByName(ticket).fetch(new Request(origin + '/start', {
          method: 'POST', body: JSON.stringify({ panelOrigin, proof: await digest(key) }),
        }));
        return result.ok ? json({ ticket }) : json({ error: 'network' }, 503);
      }
      if (request.method === 'POST' && url.pathname === '/authorize') {
        const ticket = new URLSearchParams(await body(request)).get('ticket');
        if (!brokerToken(ticket)) return json({ error: 'bad_request' }, 400);
        return env.FLOW.getByName(ticket).fetch(new Request(origin + '/authorize/' + ticket, {
          method: 'POST', redirect: 'manual', headers: { Origin: request.headers.get('Origin') || 'null' },
        }));
      }
      if (request.method === 'GET' && url.pathname === CLASSROOM_CALLBACK) {
        const state = url.searchParams.get('state') || '';
        const parts = state.split('.');
        if (parts.length !== 2 || !parts.every(brokerToken)) return json({ error: 'bad_request' }, 400);
        return env.FLOW.getByName(parts[0]).fetch(request);
      }
      const route = request.method === 'POST' && /^\/v1\/(claim|snapshot|disconnect)\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      if (route && bearer(request)) return env.FLOW.getByName(route[2]).fetch(request);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof SyntaxError || error.message === 'body_limit') return json({ error: 'bad_request' }, 400);
      return json({ error: 'network' }, 503);
    }
  },
};

export class ClassroomFlow {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.storageId = ctx.id.toString();
    this.env = env;
    this.vault = new Vault(env.BROKER_STATE_KEY);
  }

  async load(storage = this.storage) {
    const encrypted = await storage.get('flow');
    return encrypted ? JSON.parse(decoder.decode(await this.vault.open(encrypted, 'classroom-' + this.storageId))) : null;
  }

  async save(flow) {
    const encrypted = await this.vault.seal(encoder.encode(JSON.stringify(flow)), 'classroom-' + this.storageId);
    await this.storage.transaction(async (storage) => {
      await storage.put('flow', encrypted);
      await storage.setAlarm(flow.expiresAt);
    });
  }

  async alarm() {
    await this.storage.transaction(async (storage) => {
      const flow = await this.load(storage);
      if (flow?.expiresAt > Date.now()) await storage.setAlarm(flow.expiresAt);
      else await storage.delete('flow');
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (this.running) return json(url.pathname.startsWith('/v1/claim/') ? { status: 'pending' } : { error: 'network' },
      url.pathname.startsWith('/v1/claim/') ? 200 : 503);
    this.running = true;
    try {
      return await this.handle(request, url);
    } catch {
      return json({ error: 'network' }, 503);
    } finally {
      this.running = false;
    }
  }

  async handle(request, url) {
    const path = url.pathname, now = Date.now(), ticket = path === CLASSROOM_CALLBACK
      ? url.searchParams.get('state').split('.')[0] : path.split('/').at(-1);
    const flow = await this.load();
    if (path === '/start') {
      if (flow) return json({ error: 'conflict' }, 409);
      const { panelOrigin, proof } = await request.json();
      await this.save({ panelOrigin, proof, status: 'new', expiresAt: now + FLOW_TTL });
      return json({ ok: true });
    }
    if (!flow || flow.expiresAt <= now) return json({ error: 'unauthorized' }, 401);
    const suffix = '-' + ticket;
    if (path.startsWith('/authorize/')) {
      if (flow.status !== 'new' || request.headers.get('Origin') !== flow.panelOrigin) return json({ error: 'forbidden' }, 403);
      const state = ticket + '.' + classroomRandomToken();
      const consent = await classroomConsent(classroomOAuth(this.env), url.origin, ticket, { expiry: flow.expiresAt }, now, state);
      await this.save({ ...flow, status: 'pending', pending: consent.pending });
      return new Response(null, { status: 303, headers: { ...HEADERS, Location: consent.url, 'Set-Cookie': classroomCookie(state, 600, suffix) } });
    }
    if (path === CLASSROOM_CALLBACK) return this.callback(request, url, flow, suffix, now);
    if (!await matches(bearer(request), flow.proof)) return json({ error: 'unauthorized' }, 401);
    if (path.startsWith('/v1/disconnect/')) {
      await this.storage.delete('flow');
      await this.storage.deleteAlarm();
      return json({ ok: true });
    }
    if (path.startsWith('/v1/claim/')) {
      if (flow.status !== 'linked') return json({ status: flow.status === 'new' ? 'pending' : flow.status });
      if (!flow.claimed) await this.save({ ...flow, claimed: true, expiresAt: now + 86400000 });
      return json({ status: 'linked', account: flow.connection.account });
    }
    if (!flow.claimed) return json({ error: 'unauthorized' }, 401);
    if (now - (flow.lastAttempt || 0) < SNAPSHOT_INTERVAL) return json({ error: 'quota' });
    flow.lastAttempt = now;
    flow.expiresAt = now + RETENTION;
    await this.save(flow);
    const refreshToken = flow.connection.refreshToken;
    let data;
    try {
      const snapshot = await classroomSnapshot({ oauth: classroomOAuth(this.env), connection: flow.connection }, {
        budget: { used: 0, limit: 45 }, deadline: now + 55000, timeout: 8000,
      });
      data = JSON.stringify(snapshot).length > 750000 ? { error: 'size' } : snapshot;
    } catch (error) {
      if (error.code === 'auth') {
        await this.storage.delete('flow');
        await this.storage.deleteAlarm();
        return json({ error: 'unauthorized' }, 401);
      }
      data = { error: ['deadline', 'quota', 'size', 'network', 'classroom_policy'].includes(error.code) ? error.code : 'site' };
    }
    if (refreshToken !== flow.connection.refreshToken) await this.save(flow);
    return json(data);
  }

  async callback(request, url, flow, suffix, now) {
    if (flow.status !== 'pending' || !validClassroomCallback(request, flow.pending, now, suffix)) {
      return page('Classroom bağlantısı geçersiz', '<p>UniTakip panelinden bağlantıyı yeniden başlatabilirsiniz.</p>', { status: 403 });
    }
    const { pending, ...remaining } = flow;
    const code = url.searchParams.get('code');
    let status = url.searchParams.has('error') ? 'denied' : 'failed', connection;
    // The PKCE verifier is consumed before exchanging the Google authorization code.
    await this.save({ ...remaining, status: 'failed' });
    if (status !== 'denied' && code && code.length <= 2048) {
      try {
        connection = await exchangeClassroomCode(classroomOAuth(this.env), pending, code);
        status = 'linked';
      } catch (error) { if (error.code === 'classroom_policy') status = 'policy'; }
    }
    await this.save({ ...remaining, status, ...(connection ? { connection } : {}) });
    const urlBack = flow.panelOrigin + '/#/siteler?classroom=shared';
    return page(status === 'linked' ? 'Classroom izni alındı' : 'Classroom bağlantısı tamamlanamadı',
      `<p><a href="${urlBack}">UniTakip paneline dön</a></p>`, { cookie: classroomCookie('', 0, suffix), close: true });
  }
}

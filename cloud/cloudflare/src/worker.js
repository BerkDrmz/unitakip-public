import { CLASSROOM_SCRIPT_LIMIT, CLASSROOM_SCRIPT_PATH, importClassroomScriptSnapshot, issueClassroomScriptKey, matchesClassroomScriptKey, readClassroomScriptSnapshot, validClassroomScriptKey, verifyClassroomScriptKey } from './classroom-script.js';
import { hash } from './hash.js';
import { CLASSROOM_CALLBACK, classroomConsent, classroomCookie, classroomOAuth, classroomRandomToken, exchangeClassroomCode, isClassroomURL, validClassroomCallback } from './classroom.js';
import { brokerConnectionStatus, classroomBroker, removeBrokerConnection, startBrokerConnection } from './classroom-broker-client.js';
import { platformRecovered } from './health.js';
import { connect } from 'cloudflare:sockets';
import { Store } from './store.js';
import { configuration, probe, baseline, tick, status, assignmentTest, testSite, siteLogin, fileDownload, keepUbysSession } from './runtime.js';
import { clearSiteRecords, ensureSites, validId } from './sites.js';
import { smtp } from './smtp.js';
import { PanelAuth, AuthError, sameOrigin, readPanelSession, renewable, issueSession, cookie } from './panel-auth.js';
import { dashboard, panelAction, siteAction, addActivity } from './panel.js';

const json = (data, code = 200) => Response.json(data, { status: code, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function authorized(request, env) {
  const expected = `Bearer ${env.ADMIN_TOKEN || ''}`, actual = request.headers.get('Authorization') || '';
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || expected.length !== actual.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}
const object = (env) => env.MONITOR.get(env.MONITOR.idFromName('personal-monitor-v1'));
const UBYS_KEEPALIVE_CRON = '2,12,22,32,42,52 * * * *';
const LOGIN_FAILURE_CODES = new Set(['credentials', 'code', 'expired', 'unsupported', 'network', 'site', 'bad_request', 'config', 'unsafe']);
async function readJSON(request, limit = 2048) {
  if (!request.body) return {};
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) { await reader.cancel(); throw new AuthError('bad_request', 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const parsed = JSON.parse(new TextDecoder().decode(bytes) || '{}'); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed; }
  catch { throw new AuthError('bad_request', 400); }
}
export function configText(env) {
  if (env.CONFIG_JSON) return env.CONFIG_JSON; // Local synthetic test bindings.
  const count = Number(env.CONFIG_PARTS);
  if (!Number.isInteger(count) || count < 1 || count > 20) return '';
  const parts = Array.from({ length: count }, (_, i) => env[`CONFIG_${i}`]);
  if (parts.some((part) => typeof part !== 'string' || !part.length)) return '';
  return parts.join('');
}

function scriptToken(request) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return validClassroomScriptKey(token) ? token : '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/health') return json({ ok: true, service: 'UniTakip' });
    if (path === CLASSROOM_CALLBACK && request.method === 'GET') return object(env).fetch(request);
    if (path === '/oauth/classroom/start' && request.method === 'GET') {
      if (!classroomBroker(env)) return json({ error: 'not_found' }, 404);
      if (!await readPanelSession(request, env.STATE_KEY)) return json({ error: 'unauthorized' }, 401);
      return object(env).fetch(request);
    }
    if (path.startsWith(CLASSROOM_SCRIPT_PATH)) {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const site = path.slice(CLASSROOM_SCRIPT_PATH.length);
      if (!validId(site)) return json({ error: 'not_found' }, 404);
      if (!await verifyClassroomScriptKey(scriptToken(request), site, env.STATE_KEY)) return json({ error: 'unauthorized' }, 401);
      return object(env).fetch(request);
    }
    const admin = authorized(request, env);
    if (path.startsWith('/auth/')) {
      if (request.method !== 'POST' || !sameOrigin(request)) return json({ error: 'forbidden' }, 403);
      if (!['/auth/code', '/auth/verify', '/auth/logout'].includes(path)) return json({ error: 'not_found' }, 404);
      return object(env).fetch(request);
    }
    if (path.startsWith('/api/')) {
      const requestedAt = Date.now();
      const session = admin ? null : await readPanelSession(request, env.STATE_KEY, requestedAt);
      if (!admin && !session) return json({ error: 'unauthorized' }, 401);
      if (request.method !== 'GET' && !admin && !sameOrigin(request)) return json({ error: 'forbidden' }, 403);
      const routes = { '/api/dashboard': '/panel/dashboard', '/api/check': '/panel/check', '/api/pause': '/panel/pause', '/api/resume': '/panel/resume', '/api/settings': '/panel/settings', '/api/test-email': '/test-email',
        '/api/sites/classroom-script': '/panel/sites/classroom-script', '/api/sites/google': '/panel/sites/google', '/api/sites/google/status': '/panel/sites/google/status', '/api/sites/save': '/panel/sites/save', '/api/sites/pause': '/panel/sites/pause', '/api/sites/resume': '/panel/sites/resume', '/api/sites/remove': '/panel/sites/remove', '/api/sites/test': '/panel/sites/test', '/api/sites/login': '/panel/sites/login', '/api/file': '/panel/file' };
      if (!routes[path]) return json({ error: 'not_found' }, 404);
      url.pathname = routes[path];
      const response = await object(env).fetch(new Request(url, request));
      // Panel kullanıldıkça oturum uzar: en fazla günde bir, panel açılışında yeni çerez verilir.
      if (path !== '/api/dashboard' || !response.ok || !session || !renewable(session.expiry, requestedAt)) return response;
      const renewed = new Response(response.body, response);
      // Çıkışla yarışan bir yanıt aynı oturumu yeniden açamaz. Kimlik sabit, süre istek başlangıcına bağlıdır.
      renewed.headers.append('Set-Cookie', cookie(await issueSession(env.STATE_KEY, requestedAt, session.id)));
      return renewed;
    }
    if (['/status', '/probe', '/smtp-check', '/test-email', '/start', '/stop', '/tick', '/run'].includes(path)) {
      if (!admin) return json({ error: 'unauthorized' }, 401);
      return object(env).fetch(request);
    }
    if (request.method === 'GET' && env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: 'not_found' }, 404);
  },
  async scheduled(event, env, ctx) {
    if (env.LIVE_ENABLED !== 'true') return;
    const keepalive = event.cron === UBYS_KEEPALIVE_CRON;
    const path = keepalive ? '/ubys-keepalive' : '/tick';
    ctx.waitUntil((async () => {
      const response = await object(env).fetch(new Request(`https://monitor.internal${path}`, { method: 'POST' }));
      if (!response.ok && !(keepalive && response.status === 409)) throw new Error('UniTakip scheduled check failed; inspect authenticated status.');
    })());
  },
};

/** Panel giriş denemelerinin sonucu (son 20). Şifre, SMS kodu, e-Devlet kodu ya da çerez yazılmaz; yalnızca adım ve hata türü. */
function recordLogin(state, site, payload, result, failure, now) {
  const mode = payload.code !== undefined ? 'sms' : 'password';
  const code = LOGIN_FAILURE_CODES.has(failure?.code) ? failure.code : 'internal';
  const entry = { at: now, site, mode, result: result?.step || code };
  state.loginLog = [...(Array.isArray(state.loginLog) ? state.loginLog : []), entry].slice(-20);
}

export class Monitor {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.running = false; this.authService = null; this.checkProgress = null; }
  configuration() { return configuration(configText(this.env), classroomOAuth(this.env), classroomBroker(this.env)); }
  async exchangeGoogleCode(oauth, pending, code) { return exchangeClassroomCode(oauth, pending, code); }
  async deliverLoginMail(mail) { return smtp(connect, this.configuration(), mail); }
  panelAuth() {
    return this.authService ||= new PanelAuth(this.ctx.storage, this.env.STATE_KEY, (mail) => this.deliverLoginMail(mail));
  }
  /** Panelden yeniden giriş. Şifre/kod yalnızca bu istekte kullanılır; yanıtta yalnızca adım veya hata kodu döner. */
  async siteLogin(request) {
    const payload = await readJSON(request, 4096).catch(() => null);
    if (!payload || typeof payload.id !== 'string' || !validId(payload.id)) return json({ error: 'bad_request' }, 400);
    const id = payload.id;
    // Bir kontrol sürüyorsa kısa süre beklenir (SMS kodunun süresi dolmasın diye hata vermek yerine).
    for (let waited = 0; this.running && waited < 60000; waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.running) return json({ error: 'busy' }, 409);
    this.running = true;
    try {
      const now = Date.now();
      const config = this.configuration(), store = new Store(this.ctx.storage, this.env.STATE_KEY);
      const state = await store.load();
      ensureSites(state, config, now);
      const siteIds = new Set(state.sites.map((site) => site.id));
      if (!siteIds.has(id)) return json({ error: 'config' }, 400);
      // İşlem kesilse veya Worker yeniden başlasa da deneme, dış isteğe çıkmadan sayılır.
      state.loginAttempts ||= {};
      for (const key of Object.keys(state.loginAttempts)) if (!siteIds.has(key)) delete state.loginAttempts[key];
      const recent = Object.hasOwn(state.loginAttempts, id) ? state.loginAttempts[id] : [];
      const attempts = recent.filter((at) => now - at < 15 * 60000);
      if (attempts.length >= 6) return json({ error: 'rate_limit' }, 429);
      state.loginAttempts[id] = [...attempts, now];
      await store.save(state);
      // SMS bekleyen yarım giriş şifreli durumda saklanır: kullanıcı SMS'i beklerken panel sekmesi arka planda kalabilir ve
      // Durable Object bellekten çıkarılabilir; bellekteki bekleyen giriş kaybolmasın.
      const pending = new Map(Object.entries(state.loginPending || {}));
      let result, failure;
      try { result = await siteLogin(config, state, id, payload, pending, now); } catch (error) { failure = error; }
      state.loginPending = Object.fromEntries(pending);
      if (!pending.size) delete state.loginPending;
      recordLogin(state, id, payload, result, failure, now);
      if (result?.step === 'done') {
        delete state.loginAttempts[id];
        if (!Object.keys(state.loginAttempts).length) delete state.loginAttempts;
        // Yeni oturumla hemen tam kontrol yapılır (takip açıksa).
        if (state.armed && this.env.LIVE_ENABLED === 'true') state.manualRequestedAt = now;
      }
      await store.save(state);
      if (failure) throw failure;
      if (result.step === 'done' && state.armed && this.env.LIVE_ENABLED === 'true') await this.ctx.storage.setAlarm(Date.now() + 2000);
      const { detail, ...reply } = result;
      return json(reply);
    } catch (error) {
      return json({ error: LOGIN_FAILURE_CODES.has(error.code) ? error.code : 'internal' }, error.code === 'network' ? 503 : 400);
    } finally { this.running = false; }
  }

  async connectClassroom(request) {
    if (request.method !== 'POST' || !sameOrigin(request)) return json({ error: 'forbidden' }, 403);
    const session = await readPanelSession(request, this.env.STATE_KEY);
    if (!session || this.panelAuth().isSessionRevoked(session.id)) return json({ error: 'unauthorized' }, 401);
    const origin = new URL(request.url).origin;
    if (!origin.startsWith('https://')) return json({ error: 'config' }, 400);
    const oauth = classroomOAuth(this.env), broker = classroomBroker(this.env);
    if (!oauth && !broker) return json({ error: 'classroom_setup' }, 409);
    if (this.running) return json({ error: 'busy' }, 409);
    this.running = true;
    try {
      const payload = await readJSON(request);
      const store = new Store(this.ctx.storage, this.env.STATE_KEY), state = await store.load();
      ensureSites(state, this.configuration());
      const site = state.sites.find((entry) => entry.id === payload.id && isClassroomURL(entry.base_url));
      if (!site) return json({ error: 'config' }, 400);
      if (!oauth) {
        const key = classroomRandomToken();
        const ticket = await startBrokerConnection(broker, origin, key);
        if (this.panelAuth().isSessionRevoked(session.id)) return json({ error: 'unauthorized' }, 401);
        state.classroomPending = { broker, ticket, key, site: site.id, session: session.id, origin,
          expiresAt: Math.min(session.expiry, Date.now() + 590000) };
        await store.save(state);
        return json({ shared: true });
      }
      const consent = await classroomConsent(oauth, origin, site.id, session);
      state.classroomPending = consent.pending;
      await store.save(state);
      const response = json({ url: consent.url });
      response.headers.set('Set-Cookie', consent.cookie);
      return response;
    } catch (error) {
      return json({ error: error instanceof AuthError ? error.code : 'internal' }, error instanceof AuthError ? error.status : 503);
    } finally { this.running = false; }
  }

  async openSharedClassroom(request) {
    const incoming = request.headers.get('Sec-Fetch-Site');
    if (incoming && incoming !== 'same-origin') return json({ error: 'forbidden' }, 403);
    const session = await readPanelSession(request, this.env.STATE_KEY);
    if (!session || this.panelAuth().isSessionRevoked(session.id)) return json({ error: 'unauthorized' }, 401);
    const broker = classroomBroker(this.env), origin = new URL(request.url).origin;
    const state = await new Store(this.ctx.storage, this.env.STATE_KEY).load();
    const pending = state.classroomPending;
    if (!pending || !broker || pending.broker !== broker || pending.session !== session.id || pending.origin !== origin ||
        pending.expiresAt <= Date.now() || this.panelAuth().isSessionRevoked(session.id)) return json({ error: 'forbidden' }, 403);
    const nonce = classroomRandomToken();
    return new Response(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Google Classroom’a bağlan</title>
      <form method="post" action="${broker}/authorize"><input type="hidden" name="ticket" value="${pending.ticket}">
      <button type="submit">Google’a devam et</button></form><script nonce="${nonce}">document.forms[0].submit()</script></html>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'origin',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
        'Content-Security-Policy': `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'; form-action ${broker} https://accounts.google.com`,
      },
    });
  }

  async finishSharedClassroom(request) {
    if (request.method !== 'POST' || !sameOrigin(request)) return json({ error: 'forbidden' }, 403);
    const session = await readPanelSession(request, this.env.STATE_KEY);
    if (!session || this.panelAuth().isSessionRevoked(session.id)) return json({ error: 'unauthorized' }, 401);
    if (this.running) return json({ status: 'pending' });
    this.running = true;
    try {
      const { id } = await readJSON(request);
      const store = new Store(this.ctx.storage, this.env.STATE_KEY), state = await store.load();
      const pending = state.classroomPending, broker = classroomBroker(this.env);
      if (!pending || !broker || pending.broker !== broker || pending.site !== id || pending.session !== session.id ||
          pending.origin !== new URL(request.url).origin || pending.expiresAt <= Date.now()) return json({ status: 'expired' });
      const site = state.sites?.find((entry) => entry.id === id && isClassroomURL(entry.base_url));
      if (!site) return json({ status: 'expired' });
      const { status, connection } = await brokerConnectionStatus(broker, pending);
      if (this.panelAuth().isSessionRevoked(session.id)) {
        await removeBrokerConnection(broker, pending).catch(() => {});
        return json({ error: 'unauthorized' }, 401);
      }
      if (status === 'pending') return json({ status });
      delete state.classroomPending;
      if (connection) await this.saveClassroomConnection(state, store, site, connection);
      else await store.save(state);
      return json({ status });
    } catch (error) {
      if (error.code === 'auth') return json({ status: 'expired' });
      return json({ error: 'network' }, 503);
    } finally { this.running = false; }
  }

  async finishClassroom(request) {
    const url = new URL(request.url);
    const redirect = (result) => new Response(null, { status: 303, headers: {
      Location: `/#/siteler?classroom=${result}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Set-Cookie': classroomCookie('', 0),
    } });
    const oauth = classroomOAuth(this.env);
    if (!oauth) return redirect('setup');
    for (let waited = 0; this.running && waited < 45000; waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.running) return redirect('busy');
    this.running = true;
    try {
      const store = new Store(this.ctx.storage, this.env.STATE_KEY), state = await store.load();
      const pending = state.classroomPending;
      if (!validClassroomCallback(request, pending) || this.panelAuth().isSessionRevoked(pending.session)) return redirect('expired');
      delete state.classroomPending;
      await store.save(state); // consume the state before making any Google request
      if (url.searchParams.has('error')) return redirect('denied');
      const code = url.searchParams.get('code');
      const site = state.sites?.find((entry) => entry.id === pending.site && isClassroomURL(entry.base_url));
      if (!site || !code || code.length > 2048) return redirect('failed');
      const connection = await this.exchangeGoogleCode(oauth, pending, code);
      if (this.panelAuth().isSessionRevoked(pending.session)) return redirect('expired');
      await this.saveClassroomConnection(state, store, site, connection);
      return redirect('linked');
    } catch (error) {
      return redirect(error.code === 'classroom_policy' ? 'policy' : 'failed');
    } finally { this.running = false; }
  }

  async saveClassroomConnection(state, store, site, connection) {
    const previous = state.platforms[site.id]?.classroom;
    const now = Date.now();
    if (previous?.account !== connection.account) clearSiteRecords(state, site.id);
    const record = state.platforms[site.id] ||= { items: {}, scopes: {}, guards: {}, lastSuccess: null };
    record.classroom = connection;
    if (record.healthIncident?.code === 'auth') {
      for (const [key, change] of Object.entries(state.pending)) {
        if (change.noticeKey === record.healthIncident.key) delete state.pending[key];
      }
    }
    if (state.siteTests) delete state.siteTests[site.id];
    platformRecovered(state, site.id, now);
    if (['auth', 'classroom_setup', 'classroom_policy', 'unsafe'].includes(record.error)) {
      delete record.error;
      delete record.healthIncident;
    }
    const check = state.armed && !site.paused && this.env.LIVE_ENABLED === 'true';
    if (check) state.manualRequestedAt = now;
    await store.save(state);
    if (previous?.broker && previous.ticket !== connection.ticket) {
      await removeBrokerConnection(classroomBroker(this.env), previous).catch(() => {});
    }
    if (check) await this.ctx.storage.setAlarm(Date.now() + 2000);
  }

  async pairClassroomScript(request) {
    const admin = authorized(request, this.env);
    if (request.method !== 'POST' || (!admin && !sameOrigin(request))) return json({ error: 'forbidden' }, 403);
    if (!admin) {
      const session = await readPanelSession(request, this.env.STATE_KEY);
      if (!session || this.panelAuth().isSessionRevoked(session.id)) return json({ error: 'unauthorized' }, 401);
    }
    const origin = new URL(request.url).origin;
    if (!origin.startsWith('https://')) return json({ error: 'config' }, 400);
    if (this.running) return json({ error: 'busy' }, 409);
    this.running = true;
    try {
      const { id, replace } = await readJSON(request);
      const store = new Store(this.ctx.storage, this.env.STATE_KEY);
      const state = await store.load();
      ensureSites(state, this.configuration());
      const site = state.sites.find((entry) => entry.id === id && isClassroomURL(entry.base_url));
      if (!site) return json({ error: 'config' }, 400);
      const bridges = state.classroomBridges ||= {};
      if (admin && bridges[site.id]?.digest && replace !== true) return json({ error: 'classroom_already_paired' }, 409);
      const token = await issueClassroomScriptKey(site.id, this.env.STATE_KEY);
      bridges[site.id] = { ...bridges[site.id], digest: hash(token), allowNewSource: true };
      if (state.siteTests) delete state.siteTests[site.id];
      await store.save(state);
      return json({ url: new URL(CLASSROOM_SCRIPT_PATH + site.id, origin).href, token });
    } catch (error) {
      return json({ error: error instanceof AuthError ? error.code : 'internal' }, error instanceof AuthError ? error.status : 503);
    } finally { this.running = false; }
  }

  async receiveClassroomScript(request, id) {
    const token = scriptToken(request);
    if (!token || !validId(id)) return json({ error: 'unauthorized' }, 401);
    if (this.running) return json({ error: 'busy' }, 409);
    this.running = true;
    try {
      const store = new Store(this.ctx.storage, this.env.STATE_KEY);
      const state = await store.load();
      ensureSites(state, this.configuration());
      const site = state.sites.find((entry) => entry.id === id && isClassroomURL(entry.base_url));
      const bridge = state.classroomBridges?.[id];
      if (!site || !matchesClassroomScriptKey(token, bridge?.digest)) return json({ error: 'unauthorized' }, 401);
      if (site.paused || !state.armed || this.env.LIVE_ENABLED !== 'true') return json({ ok: true, paused: true });
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'bad_request' }, 400);
      const now = Date.now();
      const payload = await readJSON(request, CLASSROOM_SCRIPT_LIMIT);
      const snapshot = readClassroomScriptSnapshot(payload, now);
      const result = importClassroomScriptSnapshot(state, site, bridge, snapshot, now);
      if (!result.duplicate) await store.save(state);
      return json(result);
    } catch (error) {
      if (error instanceof AuthError || error.code === 'bad_request') return json({ error: 'bad_request' }, error.status || 400);
      if (error.code === 'classroom_source') return json({ error: error.code }, 409);
      return json({ error: 'internal' }, 503);
    } finally { this.running = false; }
  }

  async alarm() {
    if (this.env.LIVE_ENABLED !== 'true') return;
    const response = await this.fetch(new Request('https://monitor.internal/tick?source=alarm', { method: 'POST' }));
    if (!response.ok) throw new Error('Startup background check failed; retry alarm.');
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === CLASSROOM_CALLBACK && request.method === 'GET') return this.finishClassroom(request);
    if (path === '/oauth/classroom/start' && request.method === 'GET') return this.openSharedClassroom(request);
    if (path === '/panel/sites/google') return this.connectClassroom(request);
    if (path === '/panel/sites/google/status') return this.finishSharedClassroom(request);
    if (path === '/panel/sites/classroom-script') return this.pairClassroomScript(request);
    if (path.startsWith(CLASSROOM_SCRIPT_PATH) && request.method === 'POST') return this.receiveClassroomScript(request, path.slice(CLASSROOM_SCRIPT_PATH.length));
    if (path === '/auth/code' || path === '/auth/verify' || path === '/auth/logout') {
      if (request.method !== 'POST' || !sameOrigin(request)) return json({ error: 'forbidden' }, 403);
      try {
        const auth = this.panelAuth();
        if (path === '/auth/logout') {
          const session = await readPanelSession(request, this.env.STATE_KEY);
          if (session) auth.revokeSession(session.id);
          const response = json({ ok: true });
          response.headers.set('Set-Cookie', cookie('', 0));
          return response;
        }
        if (path === '/auth/code') return json(await auth.requestCode());
        const body = await readJSON(request), session = await auth.verify(body.code);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': cookie(session) } });
      } catch (error) { return json({ error: error instanceof AuthError ? error.code : 'internal', retryAfter: error.retryAfter || 0 }, error instanceof AuthError ? error.status : 503); }
    }
    if ((path.startsWith('/panel/') || path === '/test-email') && !authorized(request, this.env)) {
      const session = await readPanelSession(request, this.env.STATE_KEY);
      try {
        if (!session || this.panelAuth().isSessionRevoked(session.id)) return json({ error: 'unauthorized' }, 401);
      } catch { return json({ error: 'storage' }, 503); }
    }
    if (path === '/panel/dashboard') {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      try {
        const config = this.configuration(), store = new Store(this.ctx.storage, this.env.STATE_KEY);
        return json(dashboard(config, await store.load(), {
          liveEnabled: this.env.LIVE_ENABLED === 'true', checking: this.running, checkProgress: this.checkProgress,
          storage: store.usage(), macProjectDirectory: this.env.MAC_PROJECT_DIRECTORY || null,
        }));
      } catch { return json({ error: 'storage' }, 503); }
    }
    if (path === '/panel/file') {
      // Takip edilen bir Moodle dosyasını panel oturumuyla indirir. İçerik her zaman ek olarak verilir; panel alan adında çalıştırılamaz.
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      try {
        const config = this.configuration(), store = new Store(this.ctx.storage, this.env.STATE_KEY);
        const file = await fileDownload(config, await store.load(), new URL(request.url).searchParams.get('id'));
        const safeType = /^(?:application\/(?:pdf|zip|msword|octet-stream|vnd\.[\w.+-]+)|text\/plain|image\/(?:png|jpeg|gif))\b/i.test(file.type) ? file.type : 'application/octet-stream';
        const name = file.name.replace(/[\r\n"\\/]/g, '_').slice(0, 180) || 'dosya';
        return new Response(file.body, { headers: {
          'Content-Type': safeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          ...(file.length ? { 'Content-Length': file.length } : {}) } });
      } catch (error) {
        const code = ['not_found', 'auth', 'network', 'site', 'config', 'unsafe'].includes(error.code) ? error.code : 'internal';
        return json({ error: code }, code === 'not_found' ? 404 : code === 'network' ? 503 : 502);
      }
    }
    if (path.startsWith('/panel/sites/')) {
      // Site kaydı: takip kapalıyken de yönetilebilir. Bağlantı testi yalnızca okur ve e-posta göndermez.
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const action = path.slice('/panel/sites/'.length);
      if (action === 'login') return this.siteLogin(request);
      if (this.running) return json({ error: 'busy' }, 409);
      this.running = true;
      try {
        const config = this.configuration(), store = new Store(this.ctx.storage, this.env.STATE_KEY);
        const state = await store.load(), payload = await readJSON(request, 8192);
        const previous = state.platforms[payload.id]?.classroom;
        let result;
        if (action === 'test') { ensureSites(state, config); result = await testSite(config, state, String(payload.id || '')); }
        else result = siteAction(action, payload, state, config);
        if (previous?.broker && !state.platforms[payload.id]?.classroom) {
          await removeBrokerConnection(config.classroomBroker, previous);
        }
        await store.save(state);
        return json(result);
      } catch (error) {
        // Yalnızca kendi doğrulama mesajlarımız döner; site yanıtı, adres veya kimlik bilgisi asla dönmez.
        if (error instanceof AuthError) return json({ error: 'bad_request' }, error.status);
        if (error.code === 'network') return json({ error: 'network' }, 503);
        return json({ error: error.code === 'config' ? 'config' : error.code === 'storage' ? 'storage' : 'internal', ...(error.code === 'config' ? { message: String(error.message).slice(0, 200) } : {}) }, 400);
      } finally { this.running = false; }
    }
    if (path.startsWith('/panel/')) {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      if (this.running) return json({ error: 'busy' }, 409);
      this.running = true;
      try {
        const store = new Store(this.ctx.storage, this.env.STATE_KEY), state = await store.load(), payload = await readJSON(request);
        if (this.env.LIVE_ENABLED !== 'true') return json({ error: 'disabled' }, 409);
        return json(await panelAction(path.slice('/panel/'.length), payload, state, store, this.ctx.storage));
      } catch (error) { return json({ error: ['paused', 'setup', 'config'].includes(error.code) ? error.code : 'internal' }, 400); }
      finally { this.running = false; }
    }
    const allowed = ['/status', '/probe', '/smtp-check', '/test-email', '/start', '/stop', '/tick', '/run', '/ubys-keepalive'];
    if (!allowed.includes(path)) return json({ error: 'not_found' }, 404);
    if (request.method !== (path === '/status' ? 'GET' : 'POST')) return json({ error: 'method' }, 405);
    if (this.running) return json({ error: 'busy' }, 409);
    // A DO is a single instance, but requests may interleave at await boundaries.
    this.running = true;
    try {
      const config = this.configuration();
      const store = new Store(this.ctx.storage, this.env.STATE_KEY);
      if (path === '/status') return json({ liveEnabled: this.env.LIVE_ENABLED === 'true', ...status(await store.load(), store) });
      if (path === '/stop') { const state = await store.load(); state.armed = false; await store.save(state); return json(status(state, store)); }
      if (path === '/probe') return json(await probe(config));
      if (path === '/smtp-check') { await smtp(connect, config); return json({ smtp: 'ok', sent: false }); }
      if (path === '/test-email') {
        const platform = new URL(request.url).searchParams.get('platform');
        let mail = { subject: '[UniTakip] Bulut bağlantı testi', body: 'Bu e-posta Cloudflare üzerinden gönderildi. Zamanlanmış takip durumu ayrı olarak doğrulanmalıdır.' };
        if (platform !== null) {
          const registry = await store.load(); ensureSites(registry, config);
          mail = assignmentTest({ platforms: Object.fromEntries(registry.sites.map((site) => [site.id, { display_name: site.name }])) }, platform);
        }
        await smtp(connect, config, mail);
        let historySaved = false;
        try { const state = await store.load(); addActivity(state, [{ id: `test/${crypto.randomUUID()}`, platform: platform || 'system', type: 'test', title: platform ? 'Ödev bildirimi denemesi gönderildi' : 'Bağlantı denemesi gönderildi', sentAt: Date.now() }]); await store.save(state); historySaved = true; } catch {}
        return json({ sent: true, historySaved, ...(platform !== null ? { platform, test: 'assignment' } : {}) });
      }
      if (path === '/start') {
        const result = await baseline(config, store);
        if (this.env.LIVE_ENABLED === 'true') await this.ctx.storage.setAlarm(Date.now() + 30000);
        return json(result);
      }
      if (this.env.LIVE_ENABLED !== 'true') return json({ disabled: true }, 409);
      if (path === '/ubys-keepalive') { await keepUbysSession(config, store); return json({ ok: true }); }
      const { manualPending, ...result } = await tick(config, store, connect, { panelURL: this.env.PANEL_URL, force: path === '/run', scheduled: path === '/tick' ? (new URL(request.url).searchParams.get('source') === 'alarm' ? 'alarm' : 'cron') : false, onProgress: (value) => { this.checkProgress = value; } });
      // Elle başlatılan tam kontrol tek çalışmaya sığmadıysa birkaç saniye sonra kaldığı yerden sürer.
      if (manualPending) await this.ctx.storage.setAlarm(Date.now() + 3000);
      return json(result);
    } catch (error) {
      // Never return upstream error bodies, URLs, cookies, email addresses or stack traces.
      const code = ['config', 'storage', 'mail', 'auth', 'partial', 'network', 'site', 'maintenance', 'size', 'deadline'].includes(error.code) ? error.code : 'internal';
      return json({ error: code }, 503);
    } finally { this.running = false; this.checkProgress = null; }
  }
}

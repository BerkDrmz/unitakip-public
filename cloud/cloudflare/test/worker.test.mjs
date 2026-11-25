import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { issueSession, SESSION_COOKIE } from '../src/panel-auth.js';

const fakeConfig = {
  to: 'student@example.com', smtp: { username: 'student@gmail.com', password: 'abcdefghijklmnop' }, platforms: {
    sanal: { base_url: 'https://sanalogrenme.bartin.edu.tr', type: 'moodle', token: 'fake' },
    ogreniyorum: { base_url: 'https://ogreniyorum.net/mooc/', type: 'webpages', cookies: [{ domain: 'ogreniyorum.net' }], pages: [{ id: 'p', url: 'https://ogreniyorum.net/mooc/' }] },
    ubys: { base_url: 'https://ubys.bartin.edu.tr/', type: 'webpages', cookies: [{ domain: 'ubys.bartin.edu.tr' }], pages: [{ id: 'p', url: 'https://ubys.bartin.edu.tr/read' }] },
  },
};
const bindings = { CONFIG_JSON: JSON.stringify(fakeConfig), STATE_KEY: btoa('k'.repeat(32)), ADMIN_TOKEN: 'test-token-'.repeat(5), LIVE_ENABLED: 'false' };
const auth = { Authorization: `Bearer ${bindings.ADMIN_TOKEN}` };
const bundle = async (options) => (await build({ ...options, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] })).outputFiles[0].text;

test('actual Worker runtime protects routes and retains SQLite state across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'unitakip-worker-'));
  let mf;
  try {
    const script = await bundle({ entryPoints: [new URL('../src/worker.js', import.meta.url).pathname] });
    const serialized = bindings.CONFIG_JSON;
    const chunkedBindings = { ...bindings, CONFIG_JSON: undefined, CONFIG_PARTS: '2', CONFIG_0: serialized.slice(0, 200), CONFIG_1: serialized.slice(200) };
    delete chunkedBindings.CONFIG_JSON;
    const options = { modules: true, script, compatibilityDate: '2026-11-01', bindings: chunkedBindings,
      durableObjects: { MONITOR: { className: 'Monitor', useSQLite: true } }, durableObjectsPersist: directory };
    mf = new Miniflare(convertV4MiniflareOptions(options));
    assert.equal((await mf.dispatchFetch('https://test/health')).status, 200);
    assert.equal((await mf.dispatchFetch('https://test/status')).status, 401);
    assert.equal((await mf.dispatchFetch('https://test/api/dashboard')).status, 401);
    assert.equal((await mf.dispatchFetch('https://test/auth/code', { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
    const session = await issueSession(bindings.STATE_KEY);
    const panel = await mf.dispatchFetch('https://test/api/dashboard', { headers: { Cookie: `${SESSION_COOKIE}=${session}` } });
    assert.equal(panel.status, 200);
    // Dosya indirme de panel oturumu ister; bilinmeyen dosya kimliği hiçbir adrese istek atmadan reddedilir.
    assert.equal((await mf.dispatchFetch('https://test/api/file?id=x')).status, 401);
    const missing = await mf.dispatchFetch('https://test/api/file?id=https%3A%2F%2Fevil.test%2Fx', { headers: { Cookie: `${SESSION_COOKIE}=${session}` } });
    assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: 'not_found' });
    // Yeni oturum yenilenmez; bir günden eski oturum panel açılışında sessizce uzatılır.
    assert.equal(panel.headers.get('Set-Cookie'), null);
    const aged = await issueSession(bindings.STATE_KEY, Date.now() - 2 * 86400000);
    const renewed = await mf.dispatchFetch('https://test/api/dashboard', { headers: { Cookie: `${SESSION_COOKIE}=${aged}` } });
    assert.equal(renewed.status, 200); assert.match(renewed.headers.get('Set-Cookie') || '', new RegExp(`^${SESSION_COOKIE}=[^;]+; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$`));
    assert.ok(!(renewed.headers.get('Set-Cookie') || '').includes(aged));
    const projection = await panel.json(); assert.equal(projection.profile.email, fakeConfig.to);
    assert.ok(!JSON.stringify(projection).includes(fakeConfig.smtp.password));
    assert.equal((await mf.dispatchFetch('https://test/api/pause', { method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=${session}`, Origin: 'https://evil.test' } })).status, 403);
    const before = await (await mf.dispatchFetch('https://test/status', { headers: auth })).json();
    assert.equal(before.armed, false); assert.equal(before.pending, 0);
    assert.equal((await mf.dispatchFetch('https://test/start', { headers: auth })).status, 405);
    assert.equal((await mf.dispatchFetch('https://test/run', { method: 'POST', headers: auth })).status, 409);
    assert.equal((await mf.dispatchFetch('https://test/stop', { method: 'POST', headers: auth })).status, 200);
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    const after = await (await mf.dispatchFetch('https://test/status', { headers: auth })).json();
    assert.deepEqual(after, before);
  } finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('native SQLite encrypts chunked state and rolls back failed replacement', async () => {
  const source = `
    import { Store } from './src/store.js';
    export class TestStore {
      constructor(ctx,env) { this.ctx=ctx; this.env=env; }
      async fetch(request) {
        const store=new Store(this.ctx.storage,this.env.STATE_KEY);
        const url=new URL(request.url);
        if(url.pathname==='/write') { await store.write('test',new TextEncoder().encode('private-value-'.repeat(100000))); return new Response('ok'); }
        if(url.pathname==='/raw') return Response.json(this.ctx.storage.sql.exec('SELECT part,data FROM records ORDER BY part').toArray());
        if(url.pathname==='/rollback') {
          try { this.ctx.storage.transactionSync(()=> {this.ctx.storage.sql.exec('DELETE FROM records'); throw new Error('disk failure');}); } catch {}
        }
        return new Response(await store.read('test'));
      }
    }
    export default {fetch(request,env) {return env.TEST.getByName('one').fetch(request)}};
  `;
  const script = await bundle({ stdin: { contents: source, resolveDir: path.resolve('.'), sourcefile: 'sqlite-test.js' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-01', bindings,
    durableObjects: { TEST: { className: 'TestStore', useSQLite: true } } }));
  try {
    assert.equal((await mf.dispatchFetch('https://test/write')).status, 200);
    const raw = await (await mf.dispatchFetch('https://test/raw')).json();
    assert.ok(raw.length > 1); assert.ok(raw.every((row) => !row.data.includes('private-value')));
    assert.equal((await (await mf.dispatchFetch('https://test/read')).text()).length, 1400000);
    assert.equal((await (await mf.dispatchFetch('https://test/rollback')).text()).length, 1400000);
  } finally { await mf.dispose(); }
});

test('native Worker fetch succeeds through SiteClient and renews cookies', async () => {
  const script = await bundle({ stdin: { contents: `
    import { SiteClient } from './src/http.js';
    export default {async fetch() {
      const client=new SiteClient({base_url:'https://example.com/',cookies:[]},{pause:async()=>{}});
      try {const result=await client.request('https://example.com/'); return Response.json({text:result.text,cookies:client.cookies.length});}
      catch(error) {return Response.json({code:error.code},{status:503});}
    }};
  `, resolveDir: path.resolve('.'), sourcefile: 'fetch-test.js' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-01',
    outboundService: async () => new Response('checked', { headers: { 'Set-Cookie': 'session=renewed; Path=/' } }) }));
  try {
    const response = await mf.dispatchFetch('https://test/');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'checked', cookies: 1 });
  } finally { await mf.dispose(); }
});

test('the extra scheduled check visits only ÜBYS and retains its session after an anonymous response', async () => {
  const script = await bundle({ stdin: { contents: `
    import worker, { Monitor } from './src/worker.js';
    import { Store } from './src/store.js';
    import { emptyState } from './src/core.js';
    import { ensureSites } from './src/sites.js';
    export class TestMonitor extends Monitor {
      async fetch(request) {
        if (new URL(request.url).pathname !== '/test-seed') return super.fetch(request);
        const state = emptyState(); state.armed = true; state.lastFullAt = 1234;
        ensureSites(state, JSON.parse(this.env.CONFIG_JSON));
        await new Store(this.ctx.storage, this.env.STATE_KEY).save(state);
        return new Response('ok');
      }
    }
    export default { async fetch(request, env) {
      if (new URL(request.url).pathname !== '/test-schedule') return worker.fetch(request, env);
      const checks = [];
      await worker.scheduled({ cron: '2,12,22,32,42,52 * * * *' }, env, { waitUntil: (check) => checks.push(check) });
      await Promise.all(checks);
      return new Response('ok');
    } };
  `, resolveDir: path.resolve('.'), sourcefile: 'ubys-keepalive-test.js' } });
  const config = structuredClone(fakeConfig), seen = [];
  config.platforms.ubys.session_check_url = 'https://ubys.bartin.edu.tr/check';
  config.platforms.ubys.cookies = [{ name: 'session', value: 'original', domain: 'ubys.bartin.edu.tr', path: '/', expires: -1 }];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-01',
    bindings: { ...bindings, LIVE_ENABLED: 'true', CONFIG_JSON: JSON.stringify(config) },
    durableObjects: { MONITOR: { className: 'TestMonitor', useSQLite: true } },
    outboundService: async (request) => {
      seen.push([request.method, request.url, request.headers.get('Cookie')]);
      const denied = seen.length === 2;
      return new Response(denied ? '<form id="loginForm"></form>' : '<main>Öğrenci ekranı</main>',
        { headers: { 'Set-Cookie': 'session=' + (denied ? 'anonymous' : 'renewed') + '; Path=/' } });
    },
  }));
  try {
    const ns = await mf.getDurableObjectNamespace('MONITOR');
    assert.equal((await ns.get(ns.idFromName('personal-monitor-v1')).fetch('https://test/test-seed')).status, 200);
    assert.equal((await mf.dispatchFetch('https://test/ubys-keepalive', { method: 'POST' })).status, 404);
    const dashboard = async () => (await mf.dispatchFetch('https://test/api/dashboard', { headers: auth })).json();
    const schedule = async () => assert.equal((await mf.dispatchFetch('https://test/test-schedule')).status, 200);
    await schedule();
    const success = (await dashboard()).platforms.find(({ id }) => id === 'ubys');
    assert.ok(success.lastSessionCheck);
    await schedule();
    const denied = await dashboard();
    assert.equal(denied.platforms.find(({ id }) => id === 'ubys').lastSessionCheck, success.lastSessionCheck);
    assert.equal(denied.lastFullAt, 1234);
    await schedule();
    assert.deepEqual(seen, ['original', 'renewed', 'renewed'].map((cookie) => ['GET', 'https://ubys.bartin.edu.tr/check', `session=${cookie}`]));
    assert.equal((await dashboard()).pending, 0);
  } finally { await mf.dispose(); }
});

test('owner OTP login works end to end in native Worker, with origin, replay and body limits', async () => {
  const script = await bundle({ stdin: { contents: `
    import worker, { Monitor } from './src/worker.js';
    export default worker;
    export class TestMonitor extends Monitor {
      async deliverLoginMail(mail) { await this.ctx.storage.put('test-only-code',mail.body.match(/\\d{6}/)[0]); }
      async fetch(request) {
        const route = new URL(request.url).pathname;
        if (route === '/test-only-code') return Response.json(await this.ctx.storage.get('test-only-code'));
        if (route === '/test-new-auth-instance') {
          this.restarted = new Monitor(this.ctx, this.env);
          return new Response('ok');
        }
        return this.restarted ? this.restarted.fetch(request) : super.fetch(request);
      }
    }
  `, resolveDir: path.resolve('.'), sourcefile: 'auth-test.js' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-01', bindings: { ...bindings, LIVE_ENABLED: 'true' },
    durableObjects: { MONITOR: { className: 'TestMonitor', useSQLite: true } } }));
  try {
    const origin = { Origin: 'https://test', 'Content-Type': 'application/json' };
    assert.equal((await mf.dispatchFetch('https://test/auth/code', { method: 'POST', headers: origin })).status, 200);
    const ns = await mf.getDurableObjectNamespace('MONITOR');
    const stub = ns.get(ns.idFromName('personal-monitor-v1'));
    const code = await (await stub.fetch('https://test/test-only-code')).json();
    assert.match(code, /^\d{6}$/);
    assert.equal((await mf.dispatchFetch('https://test/auth/verify', { method: 'POST', headers: origin, body: 'x'.repeat(3000) })).status, 413);
    const verified = await mf.dispatchFetch('https://test/auth/verify', { method: 'POST', headers: origin, body: JSON.stringify({ code }) });
    assert.equal(verified.status, 200);
    const signedCookie = verified.headers.get('set-cookie'); assert.match(signedCookie, /HttpOnly; Secure; SameSite=Strict/);
    const user = { Cookie: signedCookie.split(';')[0] };
    assert.equal((await mf.dispatchFetch('https://test/api/dashboard', { headers: user })).status, 200);
    assert.equal((await mf.dispatchFetch('https://test/api/pause', { method: 'POST', headers: user })).status, 403);
    assert.equal((await mf.dispatchFetch('https://test/api/pause', { method: 'POST', headers: { ...user, ...origin } })).status, 200);
    assert.equal((await mf.dispatchFetch('https://test/auth/verify', { method: 'POST', headers: origin, body: JSON.stringify({ code }) })).status, 400);

    const olderToken = await issueSession(bindings.STATE_KEY, Date.now() - 2 * 86400000);
    const older = { Cookie: `${SESSION_COOKIE}=${olderToken}` };
    const refreshed = await mf.dispatchFetch('https://test/api/dashboard', { headers: older });
    const refreshedCookie = refreshed.headers.get('set-cookie').split(';')[0];
    assert.notEqual(refreshedCookie, older.Cookie);
    const otherOrigin = await mf.dispatchFetch('https://test/auth/logout', { method: 'POST', headers: { ...older, Origin: 'https://other.test' } });
    assert.equal(otherOrigin.status, 403);
    assert.equal((await mf.dispatchFetch('https://test/api/dashboard', { headers: older })).status, 200);
    const loggedOut = await mf.dispatchFetch('https://test/auth/logout', { method: 'POST', headers: { ...origin, Cookie: refreshedCookie } });
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await stub.fetch('https://test/test-new-auth-instance')).status, 200);
    for (const value of [older.Cookie, refreshedCookie, loggedOut.headers.get('set-cookie').split(';')[0]]) {
      const closed = await mf.dispatchFetch('https://test/api/dashboard', { headers: { Cookie: value } });
      assert.equal(closed.status, 401);
      assert.equal(closed.headers.get('Set-Cookie'), null);
    }
    assert.equal((await mf.dispatchFetch('https://test/api/test-email', { headers: older })).status, 401);
    assert.equal((await mf.dispatchFetch('https://test/api/dashboard', { headers: user })).status, 200);
    assert.equal((await mf.dispatchFetch('https://test/status', { headers: auth })).status, 200);
  } finally { await mf.dispose(); }
});

test('site management API requires a panel session and same origin, persists sites and never echoes credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'unitakip-sites-'));
  let mf;
  try {
    const script = await bundle({ stdin: { contents: `
      import worker, { Monitor } from './src/worker.js';
      export default worker;
      export class TestMonitor extends Monitor {
        async fetch(request) {
          if (new URL(request.url).pathname === '/test-new-instance') {
            this.restarted = new Monitor(this.ctx, this.env);
            return new Response('ok');
          }
          return this.restarted ? this.restarted.fetch(request) : super.fetch(request);
        }
      }
    `, resolveDir: path.resolve('.'), sourcefile: 'site-management-test.js' } });
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-01', bindings,
      durableObjects: { MONITOR: { className: 'TestMonitor', useSQLite: true } }, durableObjectsPersist: directory }));
    const session = await issueSession(bindings.STATE_KEY);
    const post = (route, body, headers = {}) => mf.dispatchFetch(`https://test${route}`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${session}`, Origin: 'https://test', ...headers } });
    const site = { name: 'Bölüm Duyuruları', base_url: 'https://www.uni.edu.tr/duyurular', type: 'webpages', wants: ['announcements'] };
    assert.equal((await mf.dispatchFetch('https://test/api/sites/save', { method: 'POST', body: JSON.stringify(site) })).status, 401);
    assert.equal((await post('/api/sites/save', site, { Origin: 'https://evil.test' })).status, 403);
    const bad = await post('/api/sites/save', { ...site, base_url: 'http://127.0.0.1/' });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, 'config');
    const saved = await post('/api/sites/save', site);
    assert.equal(saved.status, 200); assert.equal((await saved.json()).site, 'bolum-duyurulari');
    const view = await (await mf.dispatchFetch('https://test/api/dashboard', { headers: { Cookie: `${SESSION_COOKIE}=${session}` } })).json();
    assert.deepEqual(view.sites.map((s) => s.id), ['sanal', 'ogreniyorum', 'ubys', 'bolum-duyurulari']);
    assert.ok(!JSON.stringify(view).includes('"fake"')); // Moodle tokenı yansıtılmaz
    assert.equal((await post('/api/sites/pause', { id: 'bolum-duyurulari' })).status, 200);
    assert.equal((await post('/api/sites/remove', { id: 'yok' })).status, 400);
    assert.equal((await post('/api/sites/remove', { id: 'bolum-duyurulari' })).status, 200);
    const after = await (await mf.dispatchFetch('https://test/api/dashboard', { headers: { Cookie: `${SESSION_COOKIE}=${session}` } })).json();
    assert.deepEqual(after.sites.map((s) => s.id), ['sanal', 'ogreniyorum', 'ubys']);
    // Bekleyen SMS adımı olmayan yerel denemeler herhangi bir üniversiteye istek göndermez.
    for (let i = 0; i < 6; i++) {
      const attempt = await post('/api/sites/login', { id: 'ubys', code: '000000' });
      assert.equal((await attempt.json()).error, 'expired');
    }
    assert.equal((await post('/api/sites/login', { id: 'ubys', code: '000000' })).status, 429);
    const ns = await mf.getDurableObjectNamespace('MONITOR');
    assert.equal((await ns.get(ns.idFromName('personal-monitor-v1')).fetch('https://test/test-new-instance')).status, 200);
    const throttled = await post('/api/sites/login', { id: 'ubys', code: '000000' });
    assert.equal(throttled.status, 429);
    assert.equal((await throttled.json()).error, 'rate_limit');
  } finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('Classroom OAuth callback requires the initiating browser, rejects revocation and cannot be replayed', async () => {
  const script = await bundle({ stdin: { contents: `
    import worker, { Monitor } from './src/worker.js';
    export default worker;
    export class TestMonitor extends Monitor {
      async exchangeGoogleCode(oauth, pending, code) {
        if (code !== 'mock-code') throw new Error('unexpected');
        return { clientId: oauth.id, account: 'example-user', refreshToken: 'example-offline-credential' };
      }
    }
  `, resolveDir: path.resolve('.'), sourcefile: 'classroom-oauth-test.js' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-01',
    bindings: { ...bindings, CLASSROOM_CLIENT_ID: 'synthetic-client', CLASSROOM_CLIENT_SECRET: 'synthetic-secret' },
    durableObjects: { MONITOR: { className: 'TestMonitor', useSQLite: true } } }));
  try {
    const base = 'https://panel.test';
    const call = (route, init) => mf.dispatchFetch(base + route, { redirect: 'manual', ...init });
    const session = await issueSession(bindings.STATE_KEY);
    const headers = { Origin: base, Cookie: `${SESSION_COOKIE}=${session}`, 'Content-Type': 'application/json' };
    const post = (route, body) => call(route, { headers, method: 'POST', body: JSON.stringify(body) });
    const created = await (await post('/api/sites/save', { base_url: 'classroom.google.com' })).json();
    assert.equal(created.site, 'google-classroom');
    const start = () => post('/api/sites/google', { id: created.site });
    const begin = async () => {
      const response = await start();
      assert.equal(response.status, 200);
      const url = new URL((await response.json()).url);
      return { route: '/oauth/classroom/callback?code=mock-code&state=' + url.searchParams.get('state'),
        cookie: response.headers.get('set-cookie').split(';')[0] };
    };
    const outcome = async (route, cookie) => (await call(route, { headers: { Cookie: cookie } })).headers.get('location');
    const first = await begin();
    assert.equal(await outcome(first.route, ''), '/#/siteler?classroom=expired');
    assert.equal(await outcome(first.route, first.cookie), '/#/siteler?classroom=linked');
    assert.equal(await outcome(first.route, first.cookie), '/#/siteler?classroom=expired');
    const response = await call('/api/dashboard', { headers });
    const data = await response.json();
    assert.equal(data.sites.find((site) => site.id === created.site).login, 'ok');
    assert.doesNotMatch(JSON.stringify(data), /example-offline-credential|example-user|synthetic-secret/);
    const next = await begin();
    assert.equal((await post('/auth/logout', {})).status, 200);
    assert.equal(await outcome(next.route, next.cookie), '/#/siteler?classroom=expired');
    assert.equal((await start()).status, 401);
  } finally { await mf.dispose(); }
});

test('Classroom Apps Script pairing, import, replay and rotation are scoped to the recorded site', async () => {
  const script = await bundle({ stdin: { contents: `
    import worker, { Monitor } from './src/worker.js';
    export default worker;
    export class TestMonitor extends Monitor {
      async fetch(request) {
        if (new URL(request.url).pathname === '/test-alarm') {
          return Response.json(await this.ctx.storage.getAlarm());
        }
        return super.fetch(request);
      }
    }
  `, resolveDir: path.resolve('.'), sourcefile: 'classroom-notification-test.js' } });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-01',
    bindings: { ...bindings, CONFIG_JSON: JSON.stringify({ ...fakeConfig, platforms: {} }), LIVE_ENABLED: 'true' },
    durableObjects: { MONITOR: { className: 'TestMonitor', useSQLite: true } } }));
  try {
    const base = 'https://panel.test';
    const session = await issueSession(bindings.STATE_KEY);
    const owner = { Origin: base, Cookie: `${SESSION_COOKIE}=${session}`, 'Content-Type': 'application/json' };
    const call = (path, options) => mf.dispatchFetch(base + path, options);
    const post = (path, payload, headers = owner) => call(path, { method: 'POST', headers, body: JSON.stringify(payload) });
    const dashboard = async () => (await call('/api/dashboard', { headers: owner })).json();
    const namespace = await mf.getDurableObjectNamespace('MONITOR');
    const object = namespace.get(namespace.idFromName('personal-monitor-v1'));
    const alarm = async () => (await object.fetch(base + '/test-alarm')).json();

    assert.equal((await post('/start', {}, { ...auth, 'Content-Type': 'application/json' })).status, 200);
    const site = (await (await post('/api/sites/save', { base_url: 'classroom.google.com' })).json()).site;
    assert.equal((await post('/api/sites/classroom-script', { id: site }, { Origin: 'https://untrusted.test', Cookie: owner.Cookie })).status, 403);
    const pair = async () => {
      const res = await post('/api/sites/classroom-script', { id: site });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      return res.json();
    };
    const { url, token } = await pair();
    const path = new URL(url).pathname;
    assert.equal(path, `/sync/classroom/${site}`);
    assert.equal((await dashboard()).sites[0].error, 'classroom_waiting');
    const t = Date.now();
    const shape = (capturedAt, extra = [], source = '11111111-1111-4111-8111-111111111111') => ({
      source, capturedAt, courses: [{ id: '42', name: 'Örnek Dersi', courseWork: [
        { id: '1', title: 'Mevcut ödev', alternateLink: 'https://classroom.google.com/c/42/a/1' },
        ...extra,
      ], announcements: [] }],
    });
    const upload = (key, body) => post(path, body, { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
    assert.equal((await upload('x'.repeat(43) + '.' + 'x'.repeat(43), shape(t))).status, 401);
    assert.equal((await post('/sync/classroom/another', shape(t), { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await upload(token, shape(t - 16 * 60000))).status, 400);
    assert.equal((await upload(token, { source: 'invalid', capturedAt: t, courses: [] })).status, 400);
    assert.equal((await upload(token, shape(t))).status, 200);
    let view = await dashboard();
    assert.equal(view.sites[0].login, 'ok');
    assert.equal(view.tasks.length, 1);
    assert.equal(view.pending, 0);
    assert.ok(view.sites[0].classroomSyncAt);
    assert.ok(!JSON.stringify(view).includes(token));
    const startupAlarm = await alarm();

    const newWork = [{ id: '2', title: 'Yeni ödev' }];
    assert.equal(await (await upload(token, shape(t + 1, newWork))).json().then((value) => value.items), 2);
    assert.equal((await dashboard()).pending, 1);
    assert.ok(await alarm() < startupAlarm - 10000);
    assert.equal((await (await upload(token, shape(t))).json()).duplicate, true);
    assert.equal((await upload(token, shape(t + 2, newWork, '22222222-2222-4222-8222-222222222222'))).status, 409);
    assert.equal((await dashboard()).tasks.length, 2);

    const admin = { ...auth, 'Content-Type': 'application/json' };
    const refused = await post('/api/sites/classroom-script', { id: site }, admin);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, 'classroom_already_paired');
    const rotation = await post('/api/sites/classroom-script', { id: site, replace: true }, admin);
    assert.equal(rotation.status, 200);
    const rotated = await rotation.json();
    assert.equal((await upload(token, shape(t + 2))).status, 401);
    assert.equal((await upload(rotated.token, shape(t + 2, [], '22222222-2222-4222-8222-222222222222'))).status, 200);
    view = await dashboard();
    assert.equal(view.pending, 0);
    assert.equal(view.tasks.length, 1);
    assert.equal((await post('/api/sites/remove', { id: site })).status, 200);
    assert.equal((await upload(rotated.token, shape(t + 3))).status, 401);
  } finally { await mf.dispose(); }
});

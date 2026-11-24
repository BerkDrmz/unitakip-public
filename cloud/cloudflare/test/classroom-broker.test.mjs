import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { classroomRandomToken, CLASSROOM_CALLBACK } from '../src/classroom.js';
import { issueSession, SESSION_COOKIE } from '../src/panel-auth.js';

const brokerOrigin = 'https://classroom.example.com';
const panelOrigin = 'https://panel.example.net';
const stateKey = btoa('u'.repeat(32));
const adminToken = 'synthetic-admin-token'.repeat(3);
const scopes = ['openid', ...['courses', 'coursework.me', 'announcements'].map((value) =>
  'https://www.googleapis.com/auth/classroom.' + value + '.readonly')].join(' ');
const bundle = async (name) => (await build({
  entryPoints: [new URL('../src/' + name, import.meta.url).pathname], bundle: true, write: false,
  format: 'esm', platform: 'browser', external: ['cloudflare:*'],
})).outputFiles[0].text;

async function fixture(t, enabled = true) {
  const calls = [];
  const broker = new Miniflare(convertV4MiniflareOptions({
    script: await bundle('classroom-broker-worker.js'), modules: true, compatibilityDate: '2026-11-01',
    bindings: { BROKER_ORIGIN: brokerOrigin, BROKER_STATE_KEY: btoa('s'.repeat(32)),
      BROKER_MODE: enabled ? 'enabled' : 'disabled', CLASSROOM_CLIENT_ID: 'fixture-client', CLASSROOM_CLIENT_SECRET: 'fixture-secret' },
    durableObjects: { FLOW: { className: 'ClassroomFlow', useSQLite: true } },
    ratelimits: { FLOW_LIMIT: { namespace_id: '31', simple: { limit: 30, period: 60 } } },
    outboundService: async (request) => {
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.hostname === 'oauth2.googleapis.com') {
        const data = new URLSearchParams(await request.text());
        assert.equal(data.get('client_secret'), 'fixture-secret');
        if (data.get('grant_type') === 'authorization_code') {
          assert.equal(data.get('redirect_uri'), brokerOrigin + CLASSROOM_CALLBACK);
          assert.equal(data.get('code'), 'fixture-code');
          assert.match(data.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
          return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-offline', scope: scopes });
        }
        assert.equal(data.get('refresh_token'), 'fixture-offline');
        return Response.json({ access_token: 'fixture-access' });
      }
      if (url.hostname === 'openidconnect.googleapis.com') return Response.json({ sub: 'fixture-account' });
      assert.equal(url.hostname, 'classroom.googleapis.com');
      assert.equal(request.headers.get('Authorization'), 'Bearer fixture-access');
      if (url.pathname === '/v1/courses') return Response.json({ courses: [{ id: 'c1', name: 'Örnek ders' }] });
      if (url.pathname.endsWith('courseWork')) return Response.json({ courseWork: [{ id: 'a1', title: 'Örnek ödev' }] });
      return Response.json({ announcements: [] });
    },
  }));
  t.after(() => broker.dispose());
  return { broker, calls };
}

const call = (broker, route, init = {}) => broker.dispatchFetch(brokerOrigin + route, { redirect: 'manual', ...init });
const post = (broker, route, key, content, origin) => call(broker, route, {
  method: 'POST', headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(origin ? { Origin: origin } : {}) },
  ...(content ? { body: content } : {}),
});
const activate = (broker, ticket, origin = panelOrigin) => post(broker, '/authorize', null, new URLSearchParams({ ticket }), origin);
function googleReturn(response) {
  const authorization = new URL(response.headers.get('Location'));
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  return {
    path: CLASSROOM_CALLBACK + '?' + new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'fixture-code' }),
    cookie: response.headers.get('Set-Cookie').split(';')[0],
  };
}

test('the shared broker stays disabled without a release switch and serves the privacy notice', async (t) => {
  const { broker } = await fixture(t, false);
  assert.deepEqual(await (await call(broker, '/health')).json(), { ok: true, ready: false });
  assert.equal((await call(broker, '/privacy')).status, 200);
  assert.equal((await post(broker, '/v1/start', classroomRandomToken(), JSON.stringify({ origin: panelOrigin }))).status, 503);
});

test('shared consent is bound to the initiating panel and browser, single-use, and private to the connection holder', async (t) => {
  const { broker, calls } = await fixture(t);
  const key = classroomRandomToken(), otherKey = classroomRandomToken();
  const start = () => post(broker, '/v1/start', key, JSON.stringify({ origin: panelOrigin }));
  assert.equal((await post(broker, '/v1/start', key, JSON.stringify({ origin: 'https://panel.example.net@evil.test' }))).status, 400);
  const first = await (await start()).json(), other = await (await post(broker, '/v1/start', otherKey, JSON.stringify({ origin: panelOrigin }))).json();
  const ticket = first.ticket;
  assert.notEqual(ticket, other.ticket);
  assert.equal((await activate(broker, ticket, 'https://other.example.net')).status, 403);
  assert.equal((await call(broker, '/authorize?ticket=' + ticket)).status, 404);
  const authorize = await activate(broker, ticket);
  assert.equal(authorize.status, 303, await authorize.clone().text());
  assert.equal((await activate(broker, ticket)).status, 403);
  const { path, cookie } = googleReturn(authorize);
  const otherCookie = googleReturn(await activate(broker, other.ticket)).cookie;
  assert.equal((await call(broker, path)).status, 403);
  assert.equal((await call(broker, path, { headers: { Cookie: otherCookie } })).status, 403);
  assert.equal((await post(broker, '/v1/snapshot/' + ticket, key)).status, 401);
  assert.deepEqual(calls, []);
  const completed = await call(broker, path, { headers: { Cookie: cookie } });
  assert.equal(completed.status, 200);
  assert.match(completed.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(completed.headers.get('Location'), null);
  assert.match(await completed.text(), /https:\/\/panel\.example\.net\/#\/siteler/);
  assert.equal((await call(broker, path, { headers: { Cookie: cookie } })).status, 403);
  assert.equal(calls.filter((item) => item === '/token').length, 1);
  assert.equal((await post(broker, '/v1/claim/' + ticket, otherKey)).status, 401);
  assert.equal((await post(broker, '/v1/snapshot/' + ticket, otherKey)).status, 401);
  assert.deepEqual(await (await post(broker, '/v1/claim/' + ticket, key)).json(), { status: 'linked', account: 'fixture-account' });
  const data = await (await post(broker, '/v1/snapshot/' + ticket, key)).json();
  assert.equal(data.items[0].title, 'Örnek ödev');
  assert.doesNotMatch(JSON.stringify(data), /fixture-(?:secret|offline|access)/);
  assert.deepEqual(await (await post(broker, '/v1/snapshot/' + ticket, key)).json(), { error: 'quota' });
  assert.equal((await post(broker, '/v1/disconnect/' + ticket, otherKey)).status, 401);
  assert.equal((await post(broker, '/v1/disconnect/' + ticket, key)).status, 200);
  assert.equal((await post(broker, '/v1/snapshot/' + ticket, key)).status, 401);
});

test('the panel completes only its initiating session and the normal monitor imports through the shared broker', async (t) => {
  const { broker } = await fixture(t);
  const panel = new Miniflare(convertV4MiniflareOptions({
    script: await bundle('worker.js'), modules: true, compatibilityDate: '2026-11-01',
    bindings: { CLASSROOM_BROKER_URL: brokerOrigin, STATE_KEY: stateKey, LIVE_ENABLED: 'false', ADMIN_TOKEN: adminToken,
      CONFIG_JSON: JSON.stringify({ to: 'student@example.com', smtp: { username: 'student@gmail.com', password: 'abcdefghijklmnop' } }) },
    durableObjects: { MONITOR: { className: 'Monitor', useSQLite: true } },
    outboundService: (request) => broker.dispatchFetch(request.url, {
      method: request.method, headers: request.headers, body: request.body, duplex: 'half',
    }),
  }));
  t.after(() => panel.dispose());
  const session = await issueSession(stateKey);
  const owner = { Cookie: SESSION_COOKIE + '=' + session };
  const different = { Cookie: SESSION_COOKIE + '=' + await issueSession(stateKey) };
  const panelRequest = (path, init = {}) => panel.dispatchFetch(panelOrigin + path, init);
  const panelPost = (path, data, headers = owner) => panelRequest(path, {
    method: 'POST', body: JSON.stringify(data), headers: { Origin: panelOrigin, ...headers },
  });
  assert.equal((await panelPost('/api/sites/google', {}, {})).status, 401);
  const registered = await panelPost('/api/sites/save', { base_url: 'classroom.google.com' });
  assert.equal(registered.status, 200);
  const site = (await (await panelRequest('/api/dashboard', { headers: owner })).json()).sites[0];
  assert.equal(site.googleReady, true);
  assert.deepEqual(await (await panelPost('/api/sites/google', { id: site.id })).json(), { shared: true });
  assert.equal((await panelRequest('/oauth/classroom/start', { headers: { ...owner, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await panelRequest('/oauth/classroom/start', { headers: different })).status, 403);
  const page = await panelRequest('/oauth/classroom/start', { headers: owner });
  assert.equal(page.status, 200);
  const [, ticket] = /name="ticket" value="([^"]+)"/.exec(await page.text());
  const { path, cookie } = googleReturn(await activate(broker, ticket));
  assert.equal((await call(broker, path, { headers: { Cookie: cookie } })).status, 200);
  assert.deepEqual(await (await panelPost('/api/sites/google/status', { id: site.id }, different)).json(), { status: 'expired' });
  assert.equal((await panelPost('/api/sites/google/status', { id: site.id }, { ...owner, Origin: 'https://evil.test' })).status, 403);
  assert.deepEqual(await (await panelPost('/api/sites/google/status', { id: site.id })).json(), { status: 'linked' });
  const scan = await panelRequest('/start', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken } });
  assert.equal(scan.status, 200);
  const dashboard = await (await panelRequest('/api/dashboard', { headers: owner })).json();
  const linked = dashboard.sites.find((entry) => entry.id === site.id);
  assert.equal(linked.login, 'ok');
  assert.match(JSON.stringify(dashboard), /Örnek ödev/);
  assert.doesNotMatch(JSON.stringify(dashboard), new RegExp(ticket));
  assert.doesNotMatch(JSON.stringify(dashboard), /fixture-(?:secret|offline|access)/);
  assert.equal((await panelPost('/auth/logout', {})).status, 200);
  assert.equal((await panelPost('/api/sites/google/status', { id: site.id })).status, 401);
});

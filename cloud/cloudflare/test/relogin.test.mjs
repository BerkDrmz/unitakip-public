import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLogin, finishLogin } from '../src/relogin.js';
import { siteLogin } from '../src/runtime.js';
import { emptyState } from '../src/core.js';
import { effectiveSites, credentialStatus, panelLogin } from '../src/sites.js';
import { platformFailure } from '../src/health.js';

const PASSWORD = 'Gizli-Parola-123';
const html = (body, headers = {}) => new Response(body, { headers: { 'Content-Type': 'text/html', ...headers } });
const jsonResponse = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...headers } });
const body = (init) => Object.fromEntries(new URLSearchParams(init.body || ''));

const UBYS_HOME = `<form id="loginForm" data-ajax-url="/Account/Login" method="post"><input name="__RequestVerificationToken" type="hidden" value="login-token" />
  <input name="username" type="text"><input type="password" name="password"></form>
  <form id="__AjaxAntiForgeryForm" action="#" method="post"><input name="__RequestVerificationToken" type="hidden" value="ajax-token" /></form>
  <form id="loginCodeForm" data-ajax-url="/Account/LoginCode" method="post"><input name="__RequestVerificationToken" type="hidden" value="code-token" /><input type="password" name="code"></form>`;
const ubys = { base_url: 'https://ubys.uni.edu.tr/', type: 'webpages', session_check_url: 'https://ubys.uni.edu.tr/', pages: [], logged_out_markers: ['id="loginForm"'] };

function ubysSite({ twoFactor = true, wrongPassword = false, wrongCode = false, groups = null } = {}) {
  const calls = [];
  let loggedIn = false;
  const fetcher = async (url, init) => {
    const u = new URL(url), cookie = init.headers.Cookie || '';
    calls.push({ path: u.pathname, method: init.method, form: body(init), cookie });
    if (u.pathname === '/' && init.method === 'GET') return loggedIn && cookie.includes('auth=ok') ? html('<h1>Hoş geldin</h1>') : html(UBYS_HOME, { 'Set-Cookie': 'ASP.NET_SessionId=s1; Path=/; Secure' });
    if (u.pathname === '/Account/Login') {
      if (wrongPassword) return jsonResponse({ errorMessage: 'Kullanıcı adı veya parola hatalı' });
      if (twoFactor) return jsonResponse({ twoFactorAuthenticationIsActive: true });
      loggedIn = true; return jsonResponse({ direct: true }, { 'Set-Cookie': 'auth=ok; Path=/; Secure' });
    }
    if (u.pathname === '/Account/LoginCode') {
      if (wrongCode) return new Response('hata', { status: 500 });
      loggedIn = true;
      return jsonResponse(groups ? { direct: false, userGroups: groups } : { direct: true }, { 'Set-Cookie': 'auth=ok; Path=/; Secure' });
    }
    if (u.pathname === '/Account/SetCurrentUsersGroup') return jsonResponse({});
    throw new Error(`beklenmeyen istek ${u.pathname}`);
  };
  return { fetcher, calls };
}

test('ÜBYS: password then SMS code yields a verified session; secrets are never kept in the pending step', async () => {
  const site = ubysSite({ groups: [{ id: 5001, name: 'Sistem' }, { id: 7, name: 'Personel' }, { id: 3, name: 'Öğrenci' }] });
  const first = await startLogin(ubys, { username: 'ogr', password: PASSWORD }, site.fetcher);
  assert.equal(first.status, 'code');
  assert.ok(!JSON.stringify(first).includes(PASSWORD));
  assert.deepEqual(site.calls[1].form, { __RequestVerificationToken: 'login-token', username: 'ogr', password: PASSWORD });
  assert.match(site.calls[1].cookie, /ASP\.NET_SessionId=s1/);
  const done = await finishLogin(ubys, first.pending, ' 123456 ', site.fetcher);
  assert.equal(done.status, 'ok');
  assert.deepEqual(site.calls[2].form, { __RequestVerificationToken: 'code-token', code: '123456' });
  assert.deepEqual(site.calls[3].form, { __RequestVerificationToken: 'ajax-token', userGroupId: '3' });
  assert.ok(done.cookies.some((cookie) => cookie.name === 'auth' && cookie.domain === 'ubys.uni.edu.tr'));
});

test('ÜBYS without SMS step, wrong password and wrong code are reported without leaking the password', async () => {
  const direct = ubysSite({ twoFactor: false });
  assert.equal((await startLogin(ubys, { username: 'ogr', password: PASSWORD }, direct.fetcher)).status, 'ok');
  const wrong = ubysSite({ wrongPassword: true });
  await assert.rejects(startLogin(ubys, { username: 'ogr', password: PASSWORD }, wrong.fetcher), (error) => error.code === 'credentials' && !error.message.includes(PASSWORD));
  const badCode = ubysSite({ wrongCode: true });
  const first = await startLogin(ubys, { username: 'ogr', password: PASSWORD }, badCode.fetcher);
  await assert.rejects(finishLogin(ubys, first.pending, '000000', badCode.fetcher), (error) => ['code', 'network'].includes(error.code));
  await assert.rejects(finishLogin(ubys, first.pending, 'drop table', badCode.fetcher), (error) => error.code === 'code');
  await assert.rejects(startLogin(ubys, { username: '', password: PASSWORD }, badCode.fetcher), (error) => error.code === 'bad_request');
});

test('simple password form (Öğreniyorum): posts only to the form address on the same site and verifies the session', async () => {
  const og = { base_url: 'https://ogreniyorum.net/mooc/', type: 'webpages', session_check_url: 'https://ogreniyorum.net/mooc/index.php?do=derskayitol', pages: [], logged_out_markers: ['name="sifre"'] };
  const posts = []; let loggedIn = false;
  const fetcher = async (url, init) => {
    if (init.method === 'POST') { posts.push({ url, form: body(init) }); loggedIn = true; return new Response(null, { status: 302, headers: { Location: '/mooc/index.php?do=anasayfa', 'Set-Cookie': 'PHPSESSID=new; Path=/; Secure' } }); }
    if (loggedIn && (init.headers.Cookie || '').includes('PHPSESSID=new')) return html('<div class="content">Derslerim</div>');
    return html('<form method="post" class="login-form"><input type="text" name="kullaniciadi"><input type="password" name="sifre"><input type="checkbox" name="remember"></form>', { 'Set-Cookie': 'PHPSESSID=old; Path=/; Secure' });
  };
  const result = await startLogin(og, { username: 'ogr@uni.edu.tr', password: PASSWORD }, fetcher);
  assert.equal(result.status, 'ok');
  assert.deepEqual(posts, [{ url: 'https://ogreniyorum.net/mooc/index.php?do=derskayitol', form: { kullaniciadi: 'ogr@uni.edu.tr', sifre: PASSWORD, remember: 'on' } }]);
  assert.deepEqual(result.cookies.map((cookie) => `${cookie.name}=${cookie.value}`), ['PHPSESSID=new']);
  // Giriş sonrası hâlâ form görünüyorsa (yanlış şifre) oturum kaydedilmez.
  const stuck = async (url, init) => html('<form method="post"><input type="text" name="kullaniciadi"><input type="password" name="sifre"></form>');
  await assert.rejects(startLogin(og, { username: 'x', password: PASSWORD }, stuck), (error) => error.code === 'credentials');
  // CAPTCHA'lı form atlanmaya çalışılmaz.
  const captcha = async () => html('<form method="post"><input type="text" name="u"><input type="password" name="p"><div class="g-recaptcha" data-sitekey="k"></div></form>');
  await assert.rejects(startLogin(og, { username: 'x', password: PASSWORD }, captcha), (error) => error.code === 'unsupported');
  // Başka siteye yönlendirme engellenir.
  const offsite = async () => new Response(null, { status: 302, headers: { Location: 'https://kotu.example.com/login' } });
  await assert.rejects(startLogin(og, { username: 'x', password: PASSWORD }, offsite), (error) => error.code === 'unsafe');
});

test('Moodle: the official mobile app token method is used and a wrong password is reported', async () => {
  const moodle = { base_url: 'https://sanal.uni.edu.tr', type: 'moodle' };
  const seen = [];
  const ok = async (url, init) => { seen.push([url, body(init)]); return jsonResponse({ token: 'a'.repeat(32) }); };
  assert.deepEqual(await startLogin(moodle, { username: 'ogr', password: PASSWORD }, ok), { status: 'ok', token: 'a'.repeat(32) });
  assert.deepEqual(seen, [['https://sanal.uni.edu.tr/login/token.php', { username: 'ogr', password: PASSWORD, service: 'moodle_mobile_app' }]]);
  const bad = async () => jsonResponse({ error: 'Geçersiz giriş', errorcode: 'invalidlogin' });
  await assert.rejects(startLogin(moodle, { username: 'ogr', password: PASSWORD }, bad), (error) => error.code === 'credentials');
});

test('panel login stores only the new session in encrypted state, clears the auth error and is overridden by a newer local package', async () => {
  const state = emptyState(), pending = new Map(), now = Date.now();
  state.sites = [{ id: 'ubys', name: 'ÜBYS', base_url: 'https://ubys.uni.edu.tr/', type: 'webpages', preset: null, session_check_url: 'https://ubys.uni.edu.tr/', logged_out_markers: ['id="loginForm"'],
    pages: [{ id: 'p', url: 'https://ubys.uni.edu.tr/AIS/Student/Class/Index' }] }];
  state.platforms.ubys = { items: {}, scopes: {}, guards: {}, lastSuccess: now - 3600000, error: null, cookies: [{ name: 'old', value: 'x', domain: 'ubys.uni.edu.tr', path: '/' }], credentialRevision: 'r' };
  platformFailure(state, 'ubys', 'auth', now - 1000);
  state.siteTests = { ubys: { at: now - 1000, ok: false, code: 'auth' } };
  const incident = state.platforms.ubys.healthIncident.key;
  assert.ok(Object.values(state.pending).some((change) => change.noticeKey === incident));
  const config = { platforms: { ubys: { type: 'webpages', base_url: 'https://ubys.uni.edu.tr/', cookies: [{ name: 'old', value: 'x', domain: 'ubys.uni.edu.tr', path: '/' }] } } };
  const site = ubysSite();
  const step = await siteLogin(config, state, 'ubys', { username: 'ogr', password: PASSWORD }, pending, now, site.fetcher);
  assert.deepEqual(step, { ok: true, step: 'code' });
  assert.ok(!JSON.stringify(state).includes(PASSWORD));
  const done = await siteLogin(config, state, 'ubys', { code: '123456' }, pending, now + 30000, site.fetcher);
  assert.deepEqual(done, { ok: true, step: 'done' });
  assert.equal(pending.size, 0);
  assert.ok(!JSON.stringify(state).includes(PASSWORD));
  assert.equal(state.platforms.ubys.error, null);
  assert.equal(state.platforms.ubys.cookies, undefined);
  assert.equal(state.siteTests.ubys, undefined);
  assert.ok(!Object.values(state.pending).some((change) => change.noticeKey === incident));
  const active = effectiveSites(state, config).active.ubys;
  assert.ok(active.cookies.some((cookie) => cookie.name === 'auth'));
  assert.equal(credentialStatus(state.sites[0], config.platforms.ubys, panelLogin(state, state.sites[0], config.platforms.ubys)), 'ok');
  // Bilgisayardan yeni paket yüklenirse o paket geçerli olur.
  const refreshed = { platforms: { ubys: { ...config.platforms.ubys, cookies: [{ name: 'fresh', value: 'y', domain: 'ubys.uni.edu.tr', path: '/' }] } } };
  assert.deepEqual(effectiveSites(state, refreshed).active.ubys.cookies.map((cookie) => cookie.name), ['fresh']);
  // Kod adımı süre dolunca reddedilir.
  await siteLogin(config, state, 'ubys', { username: 'ogr', password: PASSWORD }, pending, now, site.fetcher);
  await assert.rejects(siteLogin(config, state, 'ubys', { code: '123456' }, pending, now + 6 * 60000, site.fetcher), (error) => error.code === 'expired');
});

test('a session alert links to the panel reconnect page when the panel address is known', () => {
  const state = emptyState(); state.panelURL = 'https://unitakip.example.workers.dev';
  state.platforms.ubys = { items: {}, lastSuccess: 1, error: null };
  platformFailure(state, 'ubys', 'auth', 2); platformFailure(state, 'ubys', 'auth', 2 + 600000);
  assert.match(Object.values(state.pending)[0].item.body, /https:\/\/unitakip\.example\.workers\.dev\/#\/baglan\/ubys/);
  const other = emptyState(); other.platforms.x = { items: {}, lastSuccess: 1, error: null };
  platformFailure(other, 'x', 'gate', 2);
  assert.doesNotMatch(Object.values(other.pending)[0].item.body, /baglan/);
});

test('a web-site session alert gives e-Devlet desktop and school-password mobile instructions', () => {
  const web = emptyState(); web.panelURL = 'https://unitakip.example.workers.dev';
  web.sites = [{ id: 'ubys', type: 'webpages', url: 'https://ubys.bartin.edu.tr/' }]; web.platforms.ubys = { items: {} };
  platformFailure(web, 'ubys', 'auth', 1000);
  const body = Object.values(web.pending)[0].item.body;
  assert.match(body, /e-Devlet ile giriyorsan yeniden bağlanma ekranındaki bilgisayar komutunu kullan/);
  assert.match(body, /Telefonda bağlanmak için okul hesabının kullanıcı adı ve şifresini kullan/);
  assert.match(body, /Giriş sayfası: https:\/\/ubys\.bartin\.edu\.tr\//);
  assert.doesNotMatch(body, /python3|refresh-session/);
  const moodle = emptyState(); moodle.sites = [{ id: 'sanal', type: 'moodle' }]; moodle.platforms.sanal = { items: {} };
  platformFailure(moodle, 'sanal', 'auth', 1000);
  assert.doesNotMatch(Object.values(moodle.pending)[0].item.body, /e-Devlet/);
});

test('ÜBYS: the real login page is ~4.6 MB with the forms at the end; it is read without hitting the size limit', async () => {
  const site = ubysSite();
  const padding = '<div>menü</div>'.repeat(330000); // ≈ 5 MB, formlar en sonda (canlı sayfadaki gibi)
  const fetcher = async (url, init) => {
    const response = await site.fetcher(url, init);
    if (new URL(url).pathname !== '/' || init.method !== 'GET') return response;
    return new Response(padding + await response.text(), { headers: response.headers });
  };
  const first = await startLogin(ubys, { username: 'ogr', password: PASSWORD }, fetcher);
  assert.equal(first.status, 'code');
  assert.equal(site.calls[1].form.__RequestVerificationToken, 'login-token');
});

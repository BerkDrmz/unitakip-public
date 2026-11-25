import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { PanelAuth, SESSION_COOKIE, cookie, issueSession, validSession, sessionExpiry, renewable, sameOrigin } from '../src/panel-auth.js';
import { dashboard, panelAction, textDue } from '../src/panel.js';
import { addActivity, emptyState } from '../src/core.js';
import { daysUntil } from '../ui/src/dates.js';

const secret = btoa('s'.repeat(32));
const storage = () => { const map = new Map(); return { get: async (k) => structuredClone(map.get(k)), put: async (k, v) => map.set(k, structuredClone(v)), deleteAlarm: async () => {}, setAlarm: async () => {} }; };
const sessionRequest = (token) => new Request('https://panel.test/api/dashboard', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });

test('dashboard exposes only the summary fields of historical sign-in attempts', () => {
  const state = emptyState();
  const summary = { at: 1000, site: 'ubys', mode: 'sms', result: 'code' };
  state.loginLog = [{ ...summary, detail: 'private test value' }];
  assert.deepEqual(dashboard({ to: 'student@example.com', platforms: {} }, state).loginLog, [summary]);
});

test('deadline days follow Istanbul calendar dates, including tomorrow more than 24 hours away', () => {
  const now = Date.parse('2026-11-09T16:00:00Z');
  assert.equal(daysUntil(Date.parse('2026-11-10T20:59:00Z'), now), 1);
  assert.equal(daysUntil(Date.parse('2026-11-09T20:59:00Z'), now), 0);
  assert.equal(daysUntil(Date.parse('2026-11-10T20:00:00Z'), Date.parse('2026-11-09T21:05:00Z')), 0);
});

test('OTP is delivered only through callback, stored as digest, single-use and creates signed session', async () => {
  let delivered; const db = storage(), auth = new PanelAuth(db, secret, async (mail) => { delivered = mail; });
  const response = await auth.requestCode();
  const code = delivered.body.match(/\d{6}/)[0];
  assert.equal(delivered.subject, '[UniTakip] Giriş kodun');
  assert.deepEqual(response, { ok: true, expiresIn: 600, retryAfter: 60 });
  const record = await db.get('panel-auth');
  assert.equal(record.code, undefined); assert.ok(!record.digest.includes(code));
  const token = await auth.verify(code);
  assert.equal(await validSession(sessionRequest(token), secret), true);
  await assert.rejects(auth.verify(code), (e) => e.code === 'code_expired');
  assert.match(cookie(token), /HttpOnly; Secure; SameSite=Strict/);
});

test('bad OTP, expiry, cooldown and hourly limits are enforced across service restarts', async () => {
  let now = 10000000, delivered;
  const db = storage(), send = async (m) => { delivered = m; };
  let auth = new PanelAuth(db, secret, send, () => now);
  await auth.requestCode();
  await assert.rejects(auth.requestCode(), (e) => e.status === 429 && e.retryAfter > 0);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.verify('bad'), (e) => e.code === 'invalid_code');
  await assert.rejects(auth.verify(delivered.body.match(/\d{6}/)[0]), (e) => e.code === 'code_expired');
  for (let i = 0; i < 4; i++) { now += 61000; auth = new PanelAuth(db, secret, send, () => now); await auth.requestCode(); }
  now += 61000; await assert.rejects(auth.requestCode(), (e) => e.code === 'rate_limit');
  now += 3600000; await auth.requestCode(); const code = delivered.body.match(/\d{6}/)[0];
  now += 600001; await assert.rejects(auth.verify(code), (e) => e.code === 'code_expired');
});

test('mail failure invalidates undelivered OTP and concurrent code requests cannot bypass limits', async () => {
  const db = storage(), failed = new PanelAuth(db, secret, async () => { throw new Error('private SMTP details'); });
  await assert.rejects(failed.requestCode(), (e) => e.code === 'mail' && !e.message.includes('private'));
  assert.equal((await db.get('panel-auth')).digest, null);
  let release; const pending = new PanelAuth(storage(), secret, () => new Promise((r) => { release = r; }));
  const first = pending.requestCode();
  // Sabit bekleme yerine ilk isteğin posta adımına ulaşması beklenir (yüklü makinede 10 ms yetmeyebiliyordu).
  while (!release) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(pending.requestCode(), (e) => e.code === 'busy');
  release(); await first;
});

test('tampered, expired, malformed and wrong-key cookies cannot authenticate; origin must match', async () => {
  const token = await issueSession(secret, 10000000);
  assert.equal(await validSession(sessionRequest(token), secret, 10000001), true);
  assert.equal(await validSession(sessionRequest(token), secret, 10000000 + 29 * 86400000), true);
  assert.equal(await validSession(sessionRequest(token), secret, 10000000 + 31 * 86400000), false);
  // Oturum kullanıldıkça uzar: ilk gün yenilenmez, bir günden eskiyse yenilenir, süresi dolmuşsa yenilenmez.
  const expiry = await sessionExpiry(sessionRequest(token), secret, 10000001);
  assert.equal(expiry, 10000000 + 30 * 86400000);
  assert.equal(renewable(expiry, 10000000 + 3600000), false);
  assert.equal(renewable(expiry, 10000000 + 25 * 3600000), true);
  assert.equal(renewable(expiry, expiry + 1), false);
  assert.equal(await sessionExpiry(sessionRequest('not-a-token'), secret), 0);
  assert.equal(await validSession(sessionRequest(token), 'x'.repeat(44), 10000001), false);
  assert.equal(await validSession(sessionRequest(`x${token}`), secret, 10000001), false);
  assert.equal(await validSession(sessionRequest('not-a-token'), secret), false);
  assert.equal(sameOrigin(new Request('https://panel.test/auth/code', { headers: { Origin: 'https://evil.test' } })), false);
  assert.equal(sameOrigin(new Request('https://panel.test/auth/code', { headers: { Origin: 'https://panel.test' } })), true);
});

test('the previous panel cookie version is retired even when correctly signed and unexpired', async () => {
  const now = 10000000;
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: now + 86400000, nonce: 'a'.repeat(22) })).toString('base64url');
  const key = createHash('sha256').update(`unitakip/panel/signing/v1/${secret}`).digest();
  const signature = createHmac('sha256', key).update(`session/${payload}`).digest('base64url');
  assert.equal(await validSession(sessionRequest(`${payload}.${signature}`), secret, now), false);
  const current = await issueSession(secret, now);
  assert.equal(await validSession(sessionRequest(current), secret, now), true);
});

test('dashboard projection has no credentials, constrains links and does not invent delivery state', () => {
  const state = emptyState();
  state.platforms.sanal = { error: null, cookies: [{ value: 'cookie-secret' }], credentialRevision: 'private-revision', lastSuccess: 5000,
    items: { task: { item: { id: 'x', kind: 'assignment', title: 'Project', course: 'Course', body: 'Details', dueAt: 6000, url: 'javascript:alert(1)' } } } };
  state.notices['weekly/2026-11-09'] = 5000;
  state.notices['error/sanal'] = 5000;
  const config = { to: 'owner@example.com', smtp: { password: 'smtp-secret' }, platforms: { sanal: { display_name: 'Sanal', token: 'token-secret', base_url: 'https://example.com' } } };
  const result = dashboard(config, state);
  assert.equal(result.tasks[0].url, ''); assert.equal(result.tasks[0].submitted, undefined);
  assert.equal(result.activity.length, 2); assert.equal(result.activity[0].sentAt, 5000);
  for (const value of ['cookie-secret', 'token-secret', 'smtp-secret', 'private-revision']) assert.ok(!JSON.stringify(result).includes(value));
  assert.equal(result.platforms[0].counts.assignments, 1);
});

test('panel actions persist before durable scheduling and pause cancels startup alarm', async () => {
  const state = { ...emptyState(), armed: true, startedAt: 1 }; const calls = [];
  const store = { save: async () => calls.push('save') }, db = { setAlarm: async () => calls.push('alarm'), deleteAlarm: async () => calls.push('delete') };
  await panelAction('check', {}, state, store, db, 10000);
  assert.deepEqual(calls, ['save', 'alarm']); assert.equal(state.manualRequestedAt, 10000);
  await panelAction('pause', {}, state, store, db); assert.equal(state.armed, false); assert.equal(state.manualRequestedAt, null);
  await assert.rejects(panelAction('check', {}, state, store, db), (e) => e.code === 'paused');
  await panelAction('resume', {}, state, store, db, 20000); assert.equal(state.armed, true);
  await assert.rejects(panelAction('settings', { intervalMinutes: 1 }, state, store, db));
  await panelAction('settings', { intervalMinutes: 30 }, state, store, db, 20000); assert.equal(state.intervalMinutes, 30);
  await panelAction('settings', { intervalMinutes: 10 }, state, store, db, 20000);
  assert.equal(state.intervalMinutes, 10); assert.equal(state.nextFullAt, 620000);
});

test('notification history is bounded without changing pending queue', () => {
  const state = emptyState();
  addActivity(state, Array.from({ length: 210 }, (_, i) => ({ id: i })));
  assert.equal(state.activity.length, 200); assert.equal(state.activity[0].id, 10);
  assert.equal(Object.keys(state.pending).length, 0);
});

test('records kept only to suppress repeat mails (missingSince) are hidden from the panel', () => {
  const state = emptyState();
  state.sites = [{ id: 'x', name: 'Okul', base_url: 'https://okul.example.edu.tr/', type: 'webpages', pages: [] }];
  const record = (id, extra = {}) => ({ scope: 'p', fingerprint: id, item: { id: `p/${id}`, scope: 'p', kind: 'material', title: id, course: 'Ders', url: 'https://okul.example.edu.tr/c', material: { url: 'https://okul.example.edu.tr/c', opensSource: true, extension: 'pdf' } }, ...extra });
  state.platforms.x = { items: { 'p/visible': record('visible'), 'p/gone': record('gone', { missingSince: 1 }) }, scopes: { p: 1 }, guards: {}, lastSuccess: 1, error: null };
  const data = dashboard({ platforms: { x: { cookies: [{ value: 'c' }] } } }, state);
  assert.deepEqual(data.materials.map((item) => item.title), ['visible']);
  assert.equal(data.platforms[0].counts.items, 1);
});

test('a page text summary on an assignment page is not listed as a task', () => {
  const state = emptyState();
  state.sites = [{ id: 'x', name: 'Okul', base_url: 'https://okul.example.edu.tr/', type: 'webpages', pages: [] }];
  const record = (id, extra) => ({ scope: 'odev', fingerprint: id, item: { id, scope: 'odev', kind: 'assignment', title: id, course: '', url: 'https://okul.example.edu.tr/o', ...extra } });
  state.platforms.x = { items: { 'odev/text': record('odev/text', { body: 'Sayfa metni' }), 'odev/t/1': record('odev/t/1', { dueAt: 2000000000000 }) }, scopes: { odev: 1 }, guards: {}, lastSuccess: 1, error: null };
  const data = dashboard({ platforms: { x: { cookies: [{ value: 'c' }] } } }, state);
  assert.deepEqual(data.tasks.map((task) => task.title), ['odev/t/1']);
});

test('quiz and assignment dates written only in an announcement text are shown on the panel', () => {
  const at = (iso) => Date.parse(iso);
  const quiz = { kind: 'announcement', title: 'BTS307 - Bilgisayar Ağları dersi - 2. quiz ve 2. ödev duyurusu',
    body: '"BTS307" dersimizin 2. quiz\'ini 6/11/2026 tarihinde uygulama saatinde (saat 14:00\'te) yapacağız. 2. ödev yüklenmiş, teslim zamanı 6/11/2026 günü saat 14:00 olarak belirlenmiştir.' };
  assert.deepEqual(textDue(quiz), { dueAt: at('2026-11-06T14:00:00+03:00'), fromText: true });
  const dateOnly = { kind: 'announcement', title: 'Quiz duyurusu', body: '1. quiz\'ini 30/10/2026 tarihinde yapacağız. Ödev teslimi 31.10.2026 saat 14:00.' };
  assert.deepEqual(textDue(dateOnly), { dueAt: at('2026-10-30T23:59:00+03:00'), fromText: true });
  assert.deepEqual(textDue({ kind: 'announcement', title: 'Sınav', body: 'Tarih sonra açıklanacak; sürüm 1.2.2026x' }), { dueAt: null, fromText: false });
  assert.deepEqual(textDue({ kind: 'announcement', title: 'Sınav', body: '31/02/2026 tarihinde' }), { dueAt: null, fromText: false });
  assert.deepEqual(textDue({ kind: 'assignment', title: 'Ödev', body: '6/11/2026', dueAt: 5 }), { dueAt: 5, fromText: false });
  assert.deepEqual(textDue({ kind: 'assignment', title: 'Ödev', body: '6/11/2026' }), { dueAt: null, fromText: false });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, makeItem, mergeSnapshot, fieldDiff, webSnapshot, flushQueue, BULK_NEW } from '../src/core.js';
import { startLogin, finishLogin, LOGIN_READ_LIMIT } from '../src/relogin.js';
import { tick } from '../src/runtime.js';
import { platformFailure, platformRecovered, queueStatusReport } from '../src/health.js';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const NOW = Date.UTC(2026, 10, 12, 18, 7);
const PASSWORD = 'must-never-appear-in-errors';
const web = { type: 'webpages', base_url: 'https://school.example.org/', download_files: false,
  pages: [{ id: 'p', url: 'https://school.example.org/p', content_selector: '#c' }] };

test('removing a deadline is reported explicitly in Istanbul time', () => {
  const previous = { body: 'Rapor hazırlanacak.', dueAt: Date.UTC(2026, 10, 20, 20, 59) };
  assert.equal(fieldDiff(previous, { ...previous, dueAt: null }), 'Tarih güncellendi: 20.11.2026 23:59 → Kaldırıldı (İstanbul)');
  assert.equal(fieldDiff(null, previous), previous.body);
  assert.equal(fieldDiff({ body: 'A', dueAt: null }, { body: 'B' }), 'B');
});

test('mass updates and a mixed batch produce one truthful summary and preserve all content', () => {
  for (const added of [0, 4]) {
    const state = emptyState();
    const before = Array.from({ length: 65 }, (_, id) => makeItem('scope', id, 'grade', 'Not ' + id, { fields: { Not: '-' } }));
    mergeSnapshot(state, 'site', { items: before, complete: ['scope'], errors: [] }, NOW);
    const after = before.map((item) => ({ ...item, fields: { Not: '85' } }));
    for (let i = 0; i < added; i++) after.push(makeItem('scope', 'new-' + i, 'file', 'Yeni dosya ' + i));
    mergeSnapshot(state, 'site', { items: after, complete: ['scope'], errors: [] }, NOW + 1);
    const pending = Object.values(state.pending);
    assert.equal(pending.length, 1); assert.match(pending[0].noticeKey, /^bulk\//);
    assert.match(pending[0].item.body, new RegExp(`${added} yeni kayıt, 65 güncellenen kayıt`));
    assert.match(pending[0].item.body, /Not: - → 85/);
    assert.doesNotMatch(pending[0].item.body, /genellikle yeni içerik değildir/);
    assert.equal(Object.keys(state.platforms.site.items).length, after.length);
    mergeSnapshot(state, 'site', { items: after, complete: ['scope'], errors: [] }, NOW + 2);
    assert.equal(Object.keys(state.pending).length, 1);
  }
  assert.equal(BULK_NEW, 12);
});

test('failed SMTP delivery remains queued and is not counted as a successfully sent email', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let state = emptyState();
  mergeSnapshot(state, 'web', await webSnapshot(web, { request: async (url) => ({ url, text: '<div id="c">Old notice</div>' }) }), NOW - 60000);
  Object.assign(state, { armed: true, lastDailySummary: '2026-11-12' });
  const config = { to: 'owner@example.org', smtp: { username: 'owner@gmail.com', password: 'abcdefghijklmnop' }, platforms: { web } };
  await tick(config, { load: async () => structuredClone(state), save: async (s) => { state = structuredClone(s); } },
    () => { throw Error('SMTP offline'); }, { force: true, pause: async () => {}, fetcher: async () => new Response('<div id="c">New assignment</div>') });
  assert.equal(state.usage.mails, 0);
  assert.equal(state.activity?.length || 0, 0);
  assert.ok(Object.values(state.pending).some((change) => change.attempts === 1));
});

test('unconfirmed failures are visible in the daily summary without claiming all sites are healthy', () => {
  const state = emptyState(); state.platforms.x = { items: {}, lastSuccess: NOW - 600000, error: null };
  state.platforms.x.error = 'partial';
  state.platforms.x.healthIncident = { code: 'partial', startedAt: NOW - 60000, announced: false }; // legacy state
  queueStatusReport(state, { platforms: { x: { display_name: 'Okul' } } }, NOW);
  const report = Object.values(state.pending).find((change) => change.noticeKey?.startsWith('status/'));
  assert.ok(report); assert.match(report.item.body, /kontrol sorunu yeniden doğrulanıyor/i);
  assert.doesNotMatch(report.item.body, /sitelerde sorun yok/);
});

test('a content change only queues and sends the affected site', async () => {
  const state = emptyState(), sites = ['a', 'b', 'c'];
  const snapshot = (body) => ({ items: [makeItem('p', 'one', 'assignment', 'Ödev', { body })], complete: ['p'], errors: [] });
  for (const id of sites) mergeSnapshot(state, id, snapshot('Old'), NOW);
  for (const id of sites) mergeSnapshot(state, id, snapshot(id === 'b' ? 'New PDF link' : 'Old'), NOW + 1);
  assert.deepEqual(Object.values(state.pending).map((c) => c.platform), ['b']);
  const sent = [];
  await flushQueue(state, { save: async () => {}, quota: () => 1, send: async (name, changes) => { sent.push({ name, count: changes.length }); } }, NOW + 1);
  assert.deepEqual(sent, [{ name: 'b', count: 1 }]);
});

test('a recovery report lists only recovered sites, not unchanged healthy sites', () => {
  const state = emptyState(), cfg = { platforms: { a: { display_name: 'Changed school' }, b: { display_name: 'Unchanged school' } } };
  for (const id of ['a', 'b']) state.platforms[id] = { items: {}, lastSuccess: NOW, error: null };
  state.lastDailySummary = '2026-11-12';
  platformFailure(state, 'a', 'network', NOW);
  queueStatusReport(state, cfg, NOW);
  platformRecovered(state, 'a', NOW + 1, { full: true });
  queueStatusReport(state, cfg, NOW + 1);
  const report = Object.values(state.pending).find((c) => c.noticeKey?.startsWith('status/'));
  assert.match(report.item.body, /Changed school/);
  assert.doesNotMatch(report.item.body, /Unchanged school/);
});

test('an old content backlog cannot spend the quota before all newly detected site failures are attempted', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let state = emptyState(); Object.assign(state, { armed: true, nextFullAt: NOW + 3600000, lastDailySummary: '2026-11-12', sequence: 200 });
  const config = { to: 'owner@example.org', smtp: { username: 'owner@gmail.com', password: 'abcdefghijklmnop' }, platforms: {} };
  for (const id of ['a', 'b', 'c']) {
    config.platforms[id] = { ...web, base_url: `https://${id}.school.example.org/`, pages: [{ id: 'p', url: `https://${id}.school.example.org/p` }] };
    state.platforms[id] = { items: {}, scopes: {}, lastSuccess: NOW, error: null };
  }
  for (let i = 0; i < 180; i++) state.pending['old-' + i] = { id: 'old-' + i, platform: 'a', type: 'new', item: { title: 'Old content' }, nextAttempt: NOW, attempts: 0 };
  await tick(config, { load: async () => structuredClone(state), save: async (s) => { state = structuredClone(s); } },
    () => { throw Error('offline'); }, { pause: async () => {}, fetcher: async () => new Response('<input type="password">') });
  const incidents = Object.values(state.pending).filter((c) => c.noticeKey?.startsWith('incident/'));
  assert.equal(incidents.length, 3);
  assert.ok(incidents.every((c) => c.attempts === 1));
  assert.equal(state.usage.mails, 0);
});

test('stalled web, Moodle and SMS login headers are aborted with a sanitized error', { timeout: 5000 }, async () => {
  for (const kind of ['web', 'moodle', 'sms']) {
    let signal;
    const fetcher = (_url, init) => { signal = init.signal; return new Promise(() => {}); };
    const attempt = kind === 'sms' ? finishLogin(web, { kind: 'ubys', cookies: [], codeToken: 'fake' }, '123456', fetcher, { timeoutMs: 10 }) :
      startLogin(kind === 'moodle' ? { ...web, type: 'moodle' } : web, { username: 'user', password: PASSWORD }, fetcher, { timeoutMs: 10 });
    await assert.rejects(attempt, (error) => ['network', 'code'].includes(error.code) && !error.message.includes(PASSWORD));
    assert.ok(signal?.aborted, kind);
  }
});

test('stalled login bodies are cancelled and oversized bodies are rejected', { timeout: 5000 }, async () => {
  let cancelled = false;
  const stalled = () => Promise.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await assert.rejects(startLogin(web, { username: 'user', password: PASSWORD }, stalled, { timeoutMs: 10 }), (e) => e.code === 'network');
  assert.ok(cancelled);
  for (const headers of [{}, { 'Content-Length': String(LOGIN_READ_LIMIT + 1) }]) {
    await assert.rejects(startLogin(web, { username: 'user', password: PASSWORD }, async () => new Response(new Uint8Array(LOGIN_READ_LIMIT + 1), { headers })),
      (e) => e.code === 'site' && !e.message.includes(PASSWORD));
  }
});

test('login timeout also cancels a stalled body in the native Worker runtime', { timeout: 15000 }, async () => {
  const entry = new URL('../src/relogin.js', import.meta.url).pathname;
  const source = `
    import {startLogin} from ${JSON.stringify(entry)};
    export default {async fetch() {
      let cancelled=false;
      try {
        await startLogin({type:'webpages',base_url:'https://school.example.org/'},
          {username:'test',password:'never-send-this'}, async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})), {timeoutMs:10});
        return Response.json({unexpected:true});
      } catch(error) {return Response.json({code:error.code,cancelled});}
    }};
  `;
  const result = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'audit-login-test.js' },
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-11-01' }));
  try {
    const response = await mf.dispatchFetch('https://test/');
    assert.deepEqual(await response.json(), { code: 'network', cancelled: true });
  } finally { await mf.dispose(); }
});

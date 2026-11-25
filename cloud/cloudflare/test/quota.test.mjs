import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emptyState, mergeSnapshot, webSnapshot } from '../src/core.js';
import { tick } from '../src/runtime.js';

function fixture() {
  const now = Date.now(), state = emptyState();
  const config = { platforms: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, {
    type: 'webpages', base_url: `https://${id}.uni.edu.tr/`, download_files: false,
    pages: [{ id: 'p', url: `https://${id}.uni.edu.tr/p`, content_selector: '#c' }],
  }])) };
  // Günlük özet bugün için gönderilmiş sayılır: bu testler değişiklik olmayan ara kontrolleri sınar.
  Object.assign(state, { armed: true, nextFullAt: now + 3600000, lastStatusReportAt: now, lastDailySummary: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now) });
  for (const id of Object.keys(config.platforms)) state.platforms[id] = { items: {}, scopes: {}, guards: {}, cookies: [], lastSuccess: now, error: null };
  return { state, config };
}
const noMail = () => { throw Error('SMTP must not run during an unchanged health check'); };

test('three healthy intermediate checks persist once, including scheduler metadata', async () => {
  let { state, config } = fixture(), saves = 0;
  await tick(config, { load: async () => structuredClone(state), save: async (s) => { saves++; state = structuredClone(s); } }, noMail,
    { scheduled: 'cron', pause: async () => {}, fetcher: async () => new Response('<div id="c">Coursework</div>') });
  assert.equal(saves, 1);
  assert.equal(state.scheduledRuns, 1); assert.equal(state.lastScheduledSource, 'cron');
  assert.equal(state.lastScheduledAt, state.lastTick);
  assert.ok(Object.values(state.platforms).every((p) => p.lastConnectivityAt === state.lastTick));
});

test('a ten-minute cron reads every site despite timing jitter, and skips a fresh full round', async () => {
  let { state, config } = fixture();
  const now = Date.now();
  Object.assign(state, { intervalMinutes: 10, lastFullAt: now - 9 * 60000 - 50000, nextFullAt: now + 10000 });
  const store = { load: async () => structuredClone(state), save: async (s) => { state = structuredClone(s); } };
  const options = { scheduled: 'cron', pause: async () => {},
    fetcher: async () => new Response('<div id="c">Coursework</div>') };
  await tick(config, store, noMail, options);
  const completed = state.lastFullAt;
  assert.ok(completed >= now);
  assert.ok(Object.values(state.platforms).every((platform) => platform.lastSuccess === completed));
  await tick(config, store, noMail, options);
  assert.equal(state.lastFullAt, completed);
});

test('a rotated session cookie is durable before checking the next site', async () => {
  let { state, config } = fixture(), saves = 0, nextChecked = false;
  await tick(config, { load: async () => structuredClone(state), save: async (s) => { saves++; state = structuredClone(s); } }, noMail,
    { scheduled: 'cron', pause: async () => {}, fetcher: async (url) => {
      if (url.includes('a.uni')) return new Response('<div>Coursework</div>', { headers: { 'Set-Cookie': 'session=rotated; Path=/; Secure' } });
      assert.equal(state.platforms.a.cookies[0].value, 'rotated'); nextChecked = true;
      return new Response('<div>Coursework</div>');
    } });
  assert.ok(nextChecked); assert.equal(saves, 2);
});

test('new content remains durable if a later platform checkpoint fails', async () => {
  let { state, config } = fixture(), saves = 0;
  for (const [id, p] of Object.entries(config.platforms)) mergeSnapshot(state, id,
    await webSnapshot(p, { request: async (url) => ({ url, text: '<div id="c">Old notice</div>' }) }), Date.now() - 60000);
  await assert.rejects(tick(config, { load: async () => structuredClone(state), save: async (s) => {
    if (++saves > 1) throw Error('disk unavailable'); state = structuredClone(s);
  } }, noMail, { force: true, pause: async () => {}, fetcher: async () => new Response('<div id="c">New assignment</div>') }));
  assert.ok(Object.values(state.pending).some((c) => c.platform === 'a' && c.item.body.includes('New assignment')));
});

test('native SQLite skips identical checkpoints, retries failed writes and invalidates cache on direct writes', async () => {
  const storePath = new URL('../src/store.js', import.meta.url).pathname;
  const corePath = new URL('../src/core.js', import.meta.url).pathname;
  const source = `
    import { Store } from ${JSON.stringify(storePath)};
    import { emptyState } from ${JSON.stringify(corePath)};
    export class TestStore {
      constructor(ctx,env) {this.ctx=ctx;this.env=env;}
      async fetch() {
        const store=new Store(this.ctx.storage,this.env.STATE_KEY), original=emptyState();
        const writes=()=>this.ctx.storage.sql.exec('SELECT total_changes() AS n').one().n;
        await store.save(original); const first=writes();
        await store.save(structuredClone(original)); const duplicate=writes()-first;
        const reloaded=new Store(this.ctx.storage,this.env.STATE_KEY);await reloaded.load();
        await reloaded.save(original);const reloadDuplicate=writes()-first;
        const changed={...original,sequence:1}, seal=reloaded.vault.seal.bind(reloaded.vault);
        reloaded.vault.seal=async()=>{throw Error('disk failure');};
        let rejected=false;try{await reloaded.save(changed);}catch{rejected=true;}
        reloaded.vault.seal=seal;await reloaded.save(changed);
        const retried=(await reloaded.load()).sequence;
        await reloaded.write('state',new TextEncoder().encode(JSON.stringify(original)));
        await reloaded.save(changed);const directWriteRestored=(await reloaded.load()).sequence;
        return Response.json({duplicate,reloadDuplicate,rejected,retried,directWriteRestored});
      }
    }
    export default {fetch(request,env){return env.TEST.getByName('one').fetch(request)}};
  `;
  const result = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'quota-cache-test.js' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: result.outputFiles[0].text,
    compatibilityDate: '2026-11-01', bindings: { STATE_KEY: btoa('k'.repeat(32)) },
    durableObjects: { TEST: { className: 'TestStore', useSQLite: true } } }));
  try {
    const response = await mf.dispatchFetch('https://test/'); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { duplicate: 0, reloadDuplicate: 0, rejected: true, retried: 1, directWriteRestored: 1 });
  } finally { await mf.dispose(); }
});

test('request budget: a full scan that exceeds the per-run subrequest allowance resumes where it stopped, without false alerts', async () => {
  const now = Date.now(), state = emptyState();
  // Üç site × 20 sayfa = 60 istek; tek çalışmanın payı 44.
  const config = { platforms: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { type: 'webpages', base_url: `https://${id}.uni.edu.tr/`, download_files: false,
    pages: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, url: `https://${id}.uni.edu.tr/p${i}` })) }])) };
  Object.assign(state, { armed: true, intervalMinutes: 10, nextFullAt: now - 1, lastStatusReportAt: now });
  let current = state, perRun = [];
  const store = { load: async () => structuredClone(current), save: async (s) => { current = structuredClone(s); } };
  const run = async () => { let count = 0; const result = await tick(config, store, noMail, { scheduled: 'cron', pause: async () => {},
    fetcher: async (url) => { count++; return new Response(`<main><p>İçerik ${new URL(url).pathname}</p></main>`); } }); perRun.push(count); return result; };
  assert.equal((await run()).fastPending, true);
  assert.ok(perRun[0] <= 44, `tek çalışmada ${perRun[0]} istek`);
  assert.deepEqual(current.fullRound.done, ['a', 'b']);            // c sıraya kaldı, yarım okunmadı
  assert.equal(current.platforms.c?.error ?? null, null);           // "siteye ulaşılamıyor" uyarısı yok
  assert.equal(Object.values(current.pending).filter((c) => c.noticeKey?.startsWith('incident/')).length, 0);
  assert.equal(current.lastFullAt, undefined);                      // tur bitmeden "tam kontrol yapıldı" denmez
  const usage = (await import('../src/core.js')).usageStatus(current);
  assert.equal(usage.deferred, 1); assert.equal(usage.resuming, true); assert.equal(usage.peak, perRun[0]);
  await run();
  assert.equal(perRun[1], 22);                                      // kalan site okunur; a ve b yeniden taranmaz, yalnızca oturumları yoklanır
  assert.equal(current.fullRound, undefined); assert.ok(current.lastFullAt); assert.ok(current.nextFullAt > Date.now());
  assert.equal(Object.keys(current.platforms.c.items).length, 20);
  await run();
  assert.equal(perRun[2], 3);                                       // sonraki çalışma: site başına tek oturum kontrolü
});

test('keep-alive: during a multi-run full scan every cookie site is contacted in every run, and known costs prevent half reads', async () => {
  const now = Date.now(), state = emptyState();
  const config = { platforms: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { type: 'webpages', base_url: `https://${id}.uni.edu.tr/`, download_files: false,
    pages: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, url: `https://${id}.uni.edu.tr/p${i}` })) }])) };
  Object.assign(state, { armed: true, nextFullAt: now - 1, lastStatusReportAt: now });
  let current = state; const runs = [];
  const store = { load: async () => structuredClone(current), save: async (s) => { current = structuredClone(s); } };
  const run = async () => { const hits = { a: 0, b: 0, c: 0 }; await tick(config, store, noMail, { scheduled: 'cron', pause: async () => {},
    fetcher: async (url) => { hits[new URL(url).hostname[0]]++; return new Response(`<main><p>İçerik ${new URL(url).pathname}</p></main>`); } }); runs.push(hits); };
  await run(); await run();                                         // ilk tur: maliyetler öğrenilir
  assert.deepEqual(runs[1], { a: 1, b: 1, c: 20 });                 // c okunurken a ve b'nin oturumu yoklanır
  assert.deepEqual([current.platforms.a.readCost, current.platforms.b.readCost, current.platforms.c.readCost], [20, 20, 20]);
  current.nextFullAt = Date.now() - 1;                              // ikinci tur
  await run();
  assert.deepEqual(runs[2], { a: 20, b: 20, c: 1 });                // c sığmayacağı bilindiği için yarım okunmaz, yalnızca yoklanır
  assert.deepEqual(current.fullRound.done, ['a', 'b']);
  await run();
  assert.deepEqual(runs[3], { a: 1, b: 1, c: 20 });
  assert.equal(current.fullRound, undefined);
  for (const hits of runs) assert.ok(hits.a && hits.b && hits.c && hits.a + hits.b + hits.c <= 44);
  assert.equal(Object.values(current.pending).filter((change) => change.noticeKey?.startsWith('incident/')).length, 0);
});

test('a rejected web session is confirmed with the stored cookie and can recover later', async () => {
  const now = Date.now(), state = emptyState();
  const config = { platforms: { web: { type: 'webpages', base_url: 'https://web.uni.edu.tr/', download_files: false,
    cookies: [{ name: 'sid', value: 'good', domain: 'web.uni.edu.tr', path: '/' }], pages: [{ id: 'p', url: 'https://web.uni.edu.tr/p' }] } } };
  Object.assign(state, { armed: true, nextFullAt: now + 3600000, lastStatusReportAt: now });
  let current = state, glitch = true; const sent = [];
  const store = { load: async () => structuredClone(current), save: async (s) => { current = structuredClone(s); } };
  const options = { scheduled: 'cron', pause: async () => {}, fetcher: async (_url, request) => { sent.push(request.headers.Cookie);
    return glitch ? new Response('<form><input type="password"></form>', { headers: { 'Set-Cookie': 'sid=anonymous; Path=/' } }) : new Response('<main><p>İçerik</p></main>'); } };
  await tick(config, store, noMail, options);
  assert.equal(current.platforms.web.error, 'auth');
  assert.deepEqual(current.platforms.web.cookies.map((cookie) => cookie.value), ['good']);
  glitch = false;
  await tick(config, store, noMail, options);
  assert.deepEqual(sent, ['sid=good', 'sid=good', 'sid=good']);
  assert.equal(current.platforms.web.error, null);
  assert.equal(Object.values(current.pending).filter((change) => change.noticeKey?.startsWith('incident/')).length, 0);
  assert.deepEqual(current.connectionLog.map((entry) => entry.code), ['auth', 'ok']);
});

test('ÜBYS verifies a suspected session failure and retries the same page with the trusted cookie', async () => {
  const origin = 'https://ubys.bartin.edu.tr', endpoint = '/conversation/GetMyNewMessagesCount', now = Date.now();
  const config = { platforms: { ubys: { type: 'webpages', base_url: origin + '/', download_files: false,
    cookies: [{ name: 'sid', value: 'good', domain: 'ubys.bartin.edu.tr', path: '/' }],
    pages: [{ id: 'p', url: origin + '/p' }] } } };
  let state = { ...emptyState(), armed: true, intervalMinutes: 10, lastStatusReportAt: now };
  const store = { load: async () => structuredClone(state), save: async (value) => { state = structuredClone(value); } };
  const seen = [];
  let expired = false, pageReads = 0;
  const signedOut = () => new Response('<form><input type="password"></form>', {
    headers: { 'Set-Cookie': 'sid=anonymous; Path=/' },
  });
  const options = { force: true, pause: async () => {}, fetcher: async (url, request) => {
    const { pathname } = new URL(url);
    seen.push([pathname, request.headers.Cookie]);
    if (pathname === endpoint) return expired ? signedOut() : Response.json(0);
    return expired || ++pageReads === 1 ? signedOut() : new Response('<main><p>Duyuru</p></main>');
  } };
  await tick(config, store, noMail, options);
  assert.deepEqual(seen, ['/p', endpoint, '/p'].map((path) => [path, 'sid=good']));
  assert.equal(state.platforms.ubys.error, null);
  assert.ok(Object.values(state.platforms.ubys.items).some(({ item }) => item.body === 'Duyuru'));
  assert.equal(Object.values(state.pending).some((change) => change.noticeKey?.startsWith('incident/')), false);

  seen.length = 0;
  expired = true;
  await tick(config, store, noMail, options);
  assert.deepEqual(seen, ['/p', endpoint].map((path) => [path, 'sid=good']));
  assert.equal(state.platforms.ubys.error, 'auth');
  assert.equal(state.platforms.ubys.cookies[0].value, 'good');
  assert.ok(Object.values(state.pending).some((change) => change.item.title === 'Yeniden giriş gerekiyor'));
});

test('request budget: a single site that alone exceeds the allowance is reported instead of blocking the others forever', async () => {
  const now = Date.now(), state = emptyState();
  // 30 sayfanın her biri bir kez yönlendiriyor: 60 istek, tek başına payı aşar.
  const config = { platforms: {
    big: { type: 'webpages', base_url: 'https://big.uni.edu.tr/', download_files: false, pages: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, url: `https://big.uni.edu.tr/p${i}` })) },
    small: { type: 'webpages', base_url: 'https://small.uni.edu.tr/', download_files: false, pages: [{ id: 'p', url: 'https://small.uni.edu.tr/p' }] } } };
  Object.assign(state, { armed: true, nextFullAt: now - 1, lastStatusReportAt: now });
  for (const id of Object.keys(config.platforms)) state.platforms[id] = { items: {}, scopes: {}, guards: {}, cookies: [], lastSuccess: now, error: null };
  let current = state;
  const store = { load: async () => structuredClone(current), save: async (s) => { current = structuredClone(s); } };
  const options = { pause: async () => {}, fetcher: async (url) => url.includes('big.') && !url.includes('/final')
    ? new Response(null, { status: 302, headers: { Location: `${new URL(url).pathname}/final` } }) : new Response('<main><p>İçerik</p></main>') };
  await tick(config, store, () => { throw Error('offline'); }, options);
  assert.equal(current.platforms.big.error, 'quota');
  assert.deepEqual(current.fullRound.done, ['big']);
  await tick(config, store, () => { throw Error('offline'); }, options);
  assert.equal(current.fullRound, undefined);
  assert.ok(Object.keys(current.platforms.small.items).length >= 1);
});

test('page lists are never silently truncated: all locally discovered pages are monitored, oversize lists are rejected', async () => {
  const { ensureSites, effectiveSites, saveSite } = await import('../src/sites.js');
  const make = (n) => ({ platforms: { ders: { display_name: 'Ders', base_url: 'https://ders.uni.edu.tr/', type: 'webpages',
    pages: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, url: `https://ders.uni.edu.tr/p${i}`, kind: 'page' })) } } });
  const state = emptyState(); ensureSites(state, make(17));
  assert.equal(effectiveSites(state, make(17)).active.ders.pages.length, 17); // önceden ilk 10 sayfadan sonrası izlenmiyordu
  // Panelden ad değiştirmek yerel sayfa listesini kırpmaz.
  saveSite(state, { id: 'ders', name: 'Ders Sitesi' }, 2);
  assert.equal(state.sites[0].pages.length, 17);
  const big = emptyState(); ensureSites(big, make(41));
  assert.deepEqual(effectiveSites(big, make(41)).problems, { ders: 'quota' });
  // Panelden 10'dan fazla sayfa girilirse sessizce atılmaz, hata döner.
  assert.throws(() => saveSite(emptyState(), { name: 'Uzun', base_url: 'https://uzun.uni.edu.tr/', type: 'webpages',
    pages: Array.from({ length: 11 }, (_, i) => `https://uzun.uni.edu.tr/p${i}`) }, 1), (e) => e.code === 'config' && /en fazla 10/.test(e.message));
});

test('request budget: the platform subrequest error is not retried or reported as an unreachable site', async () => {
  const { SiteClient } = await import('../src/http.js');
  let calls = 0;
  const client = new SiteClient({ base_url: 'https://a.uni.edu.tr/' }, { pause: async () => {}, fetcher: async () => { calls++; throw new Error('Too many subrequests.'); } });
  await assert.rejects(client.request('https://a.uni.edu.tr/p'), (error) => error.code === 'quota');
  assert.equal(calls, 1);
});

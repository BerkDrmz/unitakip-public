import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../src/core.js';
import { ensureSites, effectiveSites, saveSite, removeSite, setPaused, capabilities, publicSiteURL, MAX_SITES } from '../src/sites.js';
import { baseline, tick, testSite, configuration, siteSetup } from '../src/runtime.js';
import { dashboard, siteAction } from '../src/panel.js';

const mail = { to: 'owner@example.org', smtp: { username: 'owner@gmail.com', password: 'abcdefghijklmnop' } };
const fast = { pause: async () => {}, clock: Date.now };
const bartin = {
  sanal: { display_name: 'Sanal Öğrenme', base_url: 'https://sanalogrenme.bartin.edu.tr', type: 'moodle', token: 'moodle-token-secret' },
  ogreniyorum: { display_name: 'Öğreniyorum.net', base_url: 'https://ogreniyorum.net/mooc/', type: 'webpages', cookies: [{ name: 'PHPSESSID', value: 'cookie-secret', domain: 'ogreniyorum.net' }],
    pages: [{ id: 'derskayitol', url: 'https://ogreniyorum.net/mooc/index.php?do=derskayitol', kind: 'page' }], logged_out_markers: ['name="sifre"'] },
  ubys: { display_name: 'ÜBYS', base_url: 'https://ubys.bartin.edu.tr/', type: 'webpages', cookies: [{ name: 'ASP.NET_SessionId', value: 'ubys-secret', domain: 'ubys.bartin.edu.tr' }],
    pages: [{ id: 'notlar', url: 'https://ubys.bartin.edu.tr/AIS/Student/Class/Index?sapid=private-query', kind: 'grade' }] },
};
const memoryStore = (initial) => { let state = initial; return { load: async () => structuredClone(state), save: async (s) => { state = structuredClone(s); }, get state() { return state; } }; };

test('existing three-site installation migrates in place: same ids, records, scopes and pending kept', () => {
  const state = emptyState();
  for (const id of Object.keys(bartin)) state.platforms[id] = { items: { [`${id}-item`]: { scope: 's', fingerprint: 'f', item: { id: `${id}-item`, kind: 'file', title: 'Eski kayıt' } } }, scopes: { s: 1 }, guards: {}, lastSuccess: 1000 };
  state.pending['sanal/1'] = { id: 'sanal/1', platform: 'sanal', type: 'new', item: { title: 'Bekleyen' }, attempts: 0, nextAttempt: 0 };
  const before = structuredClone(state.platforms);
  assert.equal(ensureSites(state, { ...mail, platforms: bartin }, 5000), true);
  assert.deepEqual(state.sites.map((s) => [s.id, s.preset, s.origin]), [['sanal', 'bartin-sanal', 'migrated'], ['ogreniyorum', 'bartin-ogreniyorum', 'migrated'], ['ubys', 'bartin-ubys', 'migrated']]);
  assert.deepEqual(state.platforms, before);
  assert.ok(state.pending['sanal/1']);
  assert.equal(state.sites[2].pages[0].id, 'notlar'); // kapsam anahtarları değişmez → eski kayıtlar "silinmiş" sayılmaz
  assert.equal(ensureSites(state, { ...mail, platforms: bartin }, 6000), false);
  const { active, problems } = effectiveSites(state, { ...mail, platforms: bartin });
  assert.deepEqual(Object.keys(active), ['sanal', 'ogreniyorum', 'ubys']);
  assert.deepEqual(problems, {});
  assert.equal(active.sanal.token, 'moodle-token-secret');
});

test('configuration accepts any number of sites but keeps security rules strict', () => {
  assert.ok(configuration(JSON.stringify({ ...mail, platforms: {} })));
  assert.ok(configuration(JSON.stringify({ ...mail, platforms: { duyurular: { base_url: 'https://www.uni.edu.tr/duyurular', type: 'webpages' } } })));
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`s${i}`, { base_url: `https://s${i}.uni.edu.tr/`, type: 'webpages' }]));
  assert.throws(() => configuration(JSON.stringify({ ...mail, platforms: many })), (e) => e.code === 'config');
  const leak = { x: { base_url: 'https://lms.uni.edu.tr/', type: 'webpages', cookies: [{ domain: 'turkiye.gov.tr' }] } };
  assert.throws(() => configuration(JSON.stringify({ ...mail, platforms: leak })), (e) => e.code === 'config');
  assert.throws(() => configuration(JSON.stringify({ ...mail, platforms: { x: { base_url: 'http://lms.uni.edu.tr/', type: 'moodle' } } })), (e) => e.code === 'config');
});

test('panel site input is validated against private hosts, credentials in URL and foreign pages', () => {
  const state = emptyState(); state.sites = [];
  for (const url of ['http://lms.uni.edu.tr', 'https://127.0.0.1/', 'https://localhost/', 'https://user:pw@lms.uni.edu.tr/', 'https://lms.uni.edu.tr:8443/', 'https://intranet/', 'not a url'])
    assert.throws(() => saveSite(state, { name: 'Deneme', base_url: url, type: 'webpages' }), (e) => e.code === 'config', url);
  assert.throws(() => saveSite(state, { name: 'Deneme', base_url: 'https://lms.uni.edu.tr/', type: 'webpages', pages: ['https://evil.example.org/'] }), (e) => e.code === 'config');
  assert.throws(() => saveSite(state, { name: 'x', base_url: 'https://lms.uni.edu.tr/', type: 'webpages' }), (e) => e.code === 'config');
  assert.throws(() => saveSite(state, { name: 'Deneme', base_url: 'https://lms.uni.edu.tr/', type: 'ftp' }), (e) => e.code === 'config');
  const site = saveSite(state, { name: 'Bölüm Duyuruları', base_url: 'https://www.uni.edu.tr/duyurular', type: 'webpages', wants: ['announcements', 'hack'] }, 1);
  assert.equal(site.id, 'bolum-duyurulari'); assert.deepEqual(site.wants, ['announcements']);
  assert.equal(site.pages[0].url, 'https://www.uni.edu.tr/duyurular');
  assert.equal(saveSite(state, { name: 'Bölüm Duyuruları', base_url: 'https://www.uni.edu.tr/a', type: 'webpages' }).id, 'bolum-duyurulari-2');
  saveSite(state, { preset: 'bartin-sanal' });
  assert.throws(() => saveSite(state, { preset: 'bartin-sanal' }), (e) => e.code === 'config');
  while (state.sites.length < MAX_SITES) saveSite(state, { name: `Site ${state.sites.length}`, base_url: 'https://www.uni.edu.tr/', type: 'webpages' });
  assert.throws(() => saveSite(state, { name: 'Fazla', base_url: 'https://www.uni.edu.tr/', type: 'webpages' }), (e) => e.code === 'config');
});

test('capabilities are honest: a generic page monitor never claims grades, assignments or exams', () => {
  const page = (kind) => ({ type: 'webpages', pages: [{ url: 'https://x.edu.tr/', kind }] });
  const generic = capabilities(page('page'));
  for (const key of ['announcements', 'assignments', 'exams', 'grades']) assert.equal(generic[key].level, 'none', key);
  assert.equal(generic.files.level, 'partial'); assert.equal(generic.pageChanges.level, 'full');
  assert.equal(capabilities(page('grade')).grades.level, 'partial');
  assert.equal(capabilities({ ...page('grade'), preset: 'bartin-ubys' }).grades.level, 'full');
  const moodle = capabilities({ type: 'moodle' });
  for (const key of ['announcements', 'files', 'assignments', 'exams', 'grades']) assert.equal(moodle[key].level, 'full');
});

test('variable site count end to end: public page added from panel, then removed, others untouched', async () => {
  const pages = { 'https://www.uni.edu.tr/duyurular': '<main><p>Final programı açıklandı.</p><a href="/dosya/program.pdf">Program</a></main>',
    'https://www.ogr.edu.tr/': '<main><p>Ders kaydı başladı.</p></main>' };
  const seen = [];
  const fetcher = async (url) => { seen.push(new URL(url).hostname); return new Response(pages[url] || '<p>yok</p>'); };
  const config = { ...mail, platforms: {} };
  const initial = emptyState(); siteAction('save', { name: 'Bölüm Duyuruları', base_url: 'https://www.uni.edu.tr/duyurular', type: 'webpages', wants: ['announcements', 'files'] }, initial, config, 1);
  const store = memoryStore(initial);
  await baseline(config, store, { ...fast, fetcher });
  assert.equal(store.state.armed, true);
  assert.ok(Object.keys(store.state.platforms['bolum-duyurulari'].items).length >= 2);
  // İkinci site sonradan eklenir: ilk taraması sessiz başlangıçtır (eski içerik için toplu e-posta yok).
  const s = await store.load(); siteAction('save', { name: 'Öğrenci İşleri', base_url: 'https://www.ogr.edu.tr/', type: 'webpages' }, s, config, 2); await store.save(s);
  await tick(config, store, () => { throw new Error('mail'); }, { ...fast, fetcher, force: true });
  assert.ok(Object.keys(store.state.platforms['ogrenci-isleri'].items).length >= 1);
  assert.equal(Object.values(store.state.pending).filter((c) => c.platform === 'ogrenci-isleri').length, 0);
  // Duraklatılan site taranmaz.
  const paused = await store.load(); setPaused(paused, 'ogrenci-isleri', true); await store.save(paused);
  seen.length = 0; await tick(config, store, () => { throw new Error('mail'); }, { ...fast, fetcher, force: true });
  assert.ok(!seen.includes('www.ogr.edu.tr')); assert.ok(seen.includes('www.uni.edu.tr'));
  // Kaldırma: kayıtlar, bekleyenler ve dosya işleri gider; diğer site etkilenmez.
  const removed = await store.load(); removed.pending.x = { id: 'x', platform: 'ogrenci-isleri', type: 'new', item: {}, attempts: 0, nextAttempt: 0 };
  removeSite(removed, 'ogrenci-isleri', 3);
  assert.equal(removed.platforms['ogrenci-isleri'], undefined); assert.equal(removed.pending.x, undefined);
  assert.ok(removed.platforms['bolum-duyurulari']); assert.ok(removed.removedSites['ogrenci-isleri']);
});

test('sites prepared locally appear automatically, but a site removed in the panel is not resurrected', () => {
  const state = emptyState(); ensureSites(state, { ...mail, platforms: { sanal: bartin.sanal } });
  ensureSites(state, { ...mail, platforms: { sanal: bartin.sanal, yeni: { display_name: 'Yeni LMS', base_url: 'https://lms.uni.edu.tr', type: 'moodle', token: 't' } } });
  assert.deepEqual(state.sites.map((s) => [s.id, s.origin]), [['sanal', 'migrated'], ['yeni', 'local']]);
  removeSite(state, 'yeni');
  ensureSites(state, { ...mail, platforms: { sanal: bartin.sanal, yeni: { display_name: 'Yeni LMS', base_url: 'https://lms.uni.edu.tr', type: 'moodle', token: 't' } } });
  assert.deepEqual(state.sites.map((s) => s.id), ['sanal']);
});

test('connection test classifies network, expired session, missing credentials and unsupported structure without saving records', async () => {
  const config = { ...mail, platforms: { ogreniyorum: bartin.ogreniyorum, sanal: { ...bartin.sanal, token: undefined } } };
  const state = emptyState(); ensureSites(state, config);
  siteAction('save', { name: 'Kulüp', base_url: 'https://kulup.uni.edu.tr/', type: 'webpages' }, state, config);
  siteAction('save', { name: 'Seçicili', base_url: 'https://sec.uni.edu.tr/', type: 'webpages' }, state, config);
  state.sites.find((s) => s.id === 'secicili').pages[0].content_selector = '#yok';
  const network = await testSite(config, state, 'kulup', { ...fast, fetcher: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(network.ok, false); assert.equal(network.code, 'network');
  const expired = await testSite(config, state, 'ogreniyorum', { ...fast, fetcher: async () => new Response('<form><input name="sifre" type="password"></form>') });
  assert.equal(expired.code, 'auth');
  let called = false;
  const missing = await testSite(config, state, 'sanal', { ...fast, fetcher: async () => { called = true; return new Response('{}'); } });
  assert.equal(missing.code, 'auth'); assert.equal(called, false);
  const unsupported = await testSite(config, state, 'secicili', { ...fast, fetcher: async () => new Response('<main>Farklı yapı</main>') });
  assert.equal(unsupported.code, 'site');
  const ok = await testSite(config, state, 'kulup', { ...fast, fetcher: async () => new Response('<main><p>Etkinlik takvimi yayımlandı</p><a href="/a.pdf">Takvim</a></main>') });
  assert.equal(ok.ok, true); assert.equal(ok.counts.files, 1); assert.ok(ok.preview.some((p) => p.title === 'Takvim'));
  assert.ok(!JSON.stringify(ok).includes('<main>'));
  assert.equal(Object.keys(state.platforms).length, 0); // test kaydı birleştirmez
  assert.equal(state.siteTests.kulup.ok, true);
});

test('dashboard lists sites without credentials or private local page URLs', () => {
  const config = { ...mail, platforms: bartin };
  const state = emptyState();
  siteAction('save', { name: 'Kulüp', base_url: 'https://kulup.uni.edu.tr/', type: 'webpages', pages: ['https://kulup.uni.edu.tr/etkinlik'] }, state, config);
  const view = dashboard(config, state);
  assert.deepEqual(view.sites.map((s) => s.id), ['sanal', 'ogreniyorum', 'ubys', 'kulup']);
  const json = JSON.stringify(view);
  for (const secret of ['moodle-token-secret', 'cookie-secret', 'ubys-secret', 'private-query', 'abcdefghijklmnop']) assert.ok(!json.includes(secret), secret);
  assert.deepEqual(view.sites[3].pages, ['https://kulup.uni.edu.tr/etkinlik']);
  assert.equal(view.sites[0].login, 'ok'); assert.equal(view.sites[3].login, 'not_needed');
  assert.ok(view.presets.find((p) => p.id === 'bartin-sanal').added);
  const noToken = dashboard({ ...mail, platforms: { sanal: { ...bartin.sanal, token: undefined } } }, emptyState());
  assert.equal(noToken.sites[0].login, 'missing'); assert.equal(noToken.sites[0].error, 'auth');
});

test('siteSetup marks missing preset sessions before any request', () => {
  const state = emptyState(); siteAction('save', { preset: 'bartin-ogreniyorum' }, state, { ...mail, platforms: {} });
  const { active, problems } = siteSetup({ ...mail, platforms: {} }, state);
  assert.deepEqual(active, {}); assert.equal(problems.ogreniyorum, 'auth');
});

test('public URL validation helper', () => {
  assert.equal(publicSiteURL('https://lms.uni.edu.tr/moodle').hostname, 'lms.uni.edu.tr');
  assert.throws(() => publicSiteURL('https://10.0.0.1/'), (e) => e.code === 'config');
});

test('fresh GitHub install with zero sites can start; a panel-added public site then starts silently', async () => {
  const config = { ...mail, platforms: {} };
  const store = memoryStore(emptyState());
  const started = await baseline(config, store, { ...fast, fetcher: async () => { throw new Error('ağ çağrısı beklenmiyordu'); } });
  assert.equal(store.state.armed, true);
  assert.ok(store.state.startedAt);
  assert.ok(started);
  // Siteler panelden eklenir; ilk kontrolde mevcut içerik bildirim üretmez (sessiz başlangıç).
  const state = store.state;
  siteAction('save', { name: 'Bölüm Duyuruları', base_url: 'https://www.ornek-universite.edu.tr/duyurular', type: 'webpages' }, state, config, 1000);
  assert.deepEqual(state.sites.map((s) => s.id), ['bolum-duyurulari']);
  // Bir site varken hiçbiri okunamazsa başlatma reddedilir (eski davranış korunur).
  const blocked = memoryStore(emptyState());
  await assert.rejects(baseline({ ...mail, platforms: { ders: { display_name: 'Ders', base_url: 'https://lms.ornek-universite.edu.tr', type: 'moodle' } } }, blocked, { ...fast }),
    (e) => e.code === 'auth');
  assert.ok(!blocked.state.armed);
});

test('editing a panel site to another address or type resets its records so the next check is a silent baseline', async () => {
  const pages = { 'https://www.uni.edu.tr/duyurular': '<main><p>Eski sitenin duyurusu.</p><a href="/dosya/eski.pdf">Eski</a></main>',
    'https://yeni.uni.edu.tr/haberler': '<main><p>Yeni sitenin haberi.</p><a href="/dosya/yeni.pdf">Yeni</a></main>' };
  const fetcher = async (url) => new Response(pages[url] || '<p>yok</p>');
  const config = { ...mail, platforms: {} };
  const initial = emptyState(); siteAction('save', { name: 'Duyurular', base_url: 'https://www.uni.edu.tr/duyurular', type: 'webpages' }, initial, config, 1);
  const store = memoryStore(initial);
  await baseline(config, store, { ...fast, fetcher });
  const before = Object.keys(store.state.platforms.duyurular.items);
  assert.ok(before.length >= 2);
  // Yalnızca ad değişirse kayıtlar korunur.
  const renamed = await store.load(); renamed.siteTests = { duyurular: { at: 1, ok: true } };
  siteAction('save', { id: 'duyurular', name: 'Bölüm Duyuruları', base_url: 'https://www.uni.edu.tr/duyurular', type: 'webpages' }, renamed, config, 2);
  assert.deepEqual(Object.keys(renamed.platforms.duyurular.items), before);
  assert.ok(renamed.siteTests.duyurular);
  // Adres değişirse eski kayıtlar, bekleyenler ve test sonucu silinir; kimlik aynı kalır.
  renamed.pending.x = { id: 'x', platform: 'duyurular', type: 'new', item: {}, attempts: 0, nextAttempt: 0 };
  siteAction('save', { id: 'duyurular', name: 'Bölüm Duyuruları', base_url: 'https://yeni.uni.edu.tr/haberler', type: 'webpages', pages: [] }, renamed, config, 3);
  assert.equal(renamed.platforms.duyurular, undefined); assert.equal(renamed.pending.x, undefined); assert.equal(renamed.siteTests.duyurular, undefined);
  assert.equal(renamed.sites[0].pages[0].url, 'https://yeni.uni.edu.tr/haberler');
  await store.save(renamed);
  // Yeni adresin ilk taraması sessizdir: eski sitenin içeriği "kaldırıldı", yenisi "yeni" diye bildirilmez.
  await tick(config, store, () => { throw new Error('mail'); }, { ...fast, fetcher, force: true });
  assert.ok(Object.keys(store.state.platforms.duyurular.items).length >= 2);
  assert.equal(Object.values(store.state.pending).filter((c) => c.platform === 'duyurular' && c.type !== 'notice').length, 0);
  // Tür değişikliği kayda işlenir (önceden yok sayılıyor, site "sayfa yok" hatasına düşüyordu).
  const typed = await store.load();
  siteAction('save', { id: 'duyurular', name: 'Bölüm Duyuruları', base_url: 'https://yeni.uni.edu.tr/haberler', type: 'moodle' }, typed, config, 4);
  assert.equal(typed.sites[0].type, 'moodle'); assert.deepEqual(typed.sites[0].pages, []); assert.equal(typed.platforms.duyurular, undefined);
  assert.equal(dashboard(config, typed).sites[0].error, 'auth');
});

test('connection alert subject uses the site name for sites added in the panel', async () => {
  const config = { ...mail, platforms: {} };
  const state = emptyState(); siteAction('save', { name: 'Bölüm Duyuruları', base_url: 'https://www.uni.edu.tr/duyurular', type: 'webpages' }, state, config, 1);
  let sent;
  const { sendGroup } = await import('../src/runtime.js');
  const original = globalThis.fetch;
  const group = [{ id: 'notice/1', noticeKey: 'incident/bolum-duyurulari/1', platform: 'bolum-duyurulari', type: 'notice', item: { title: 'Bağlantı sorunu', body: '', kind: 'notice', url: '' }, detectedAt: 1 }];
  // SMTP'ye bağlanmadan konu satırını yakala: bağlantı kurulmaya çalışıldığı an posta nesnesi hazırdır.
  const connect = () => { throw new Error('offline'); };
  const subjectOf = async (name) => { try { await sendGroup(connect, config, state, { read: async () => null }, name, group); } catch (error) { sent = error; } };
  await subjectOf('bolum-duyurulari');
  assert.ok(sent);
  const { digest } = await import('../src/core.js'); const { siteName } = await import('../src/runtime.js');
  assert.equal(siteName(state, 'bolum-duyurulari'), 'Bölüm Duyuruları'); assert.equal(siteName(state, 'system'), 'Sistem');
  assert.ok(digest(siteName(state, 'bolum-duyurulari'), group, String).subject.includes('Bölüm Duyuruları'));
  globalThis.fetch = original;
});

test('a tracked Moodle file is downloaded through the panel with the cloud token; nothing else can be fetched', async () => {
  const { fileDownload, tick } = await import('../src/runtime.js'); const { mergeSnapshot, makeItem } = await import('../src/core.js');
  const config = { ...mail, platforms: { sanal: { type: 'moodle', base_url: 'https://moodle.uni.edu.tr', token: 'TOKEN1234567890abcdef' } } };
  const state = emptyState(); ensureSites(state, config, 1);
  const raw = 'https://moodle.uni.edu.tr/webservice/pluginfile.php?forcedownload=1&amp;file=%2F12%2Fmod_resource%2Fcontent%2F1%2Fders.pdf';
  mergeSnapshot(state, 'sanal', { complete: ['contents/1'], errors: [], items: [makeItem('contents/1', 'file/7', 'file', 'Ders notu', { course: 'Ağlar', files: [{ url: raw, name: 'ders notu.pdf', version: 'v' }] })] }, 1);
  const material = dashboard(config, state).materials[0];
  assert.equal(material.url, 'https://moodle.uni.edu.tr/pluginfile.php?forcedownload=1&file=%2F12%2Fmod_resource%2Fcontent%2F1%2Fders.pdf');
  assert.match(material.download, /^\/api\/file\?id=/); assert.ok(!JSON.stringify(material).includes('TOKEN'));
  const id = new URLSearchParams(material.download.split('?')[1]).get('id'); let asked;
  const ok = async (url, options) => { asked = { url, options }; return new Response('%PDF-1.7', { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '8' } }); };
  const file = await fileDownload(config, state, id, ok);
  assert.equal(asked.url, 'https://moodle.uni.edu.tr/webservice/pluginfile.php?forcedownload=1&file=%2F12%2Fmod_resource%2Fcontent%2F1%2Fders.pdf&token=TOKEN1234567890abcdef');
  assert.equal(asked.options.redirect, 'manual'); assert.equal(file.name, 'ders notu.pdf'); assert.equal(file.type, 'application/pdf');
  assert.equal(await new Response(file.body).text(), '%PDF-1.7');
  // Serbest adres ya da bilinmeyen kimlik kabul edilmez; anahtar reddedilirse ve yönlendirmede içerik dönmez.
  await assert.rejects(fileDownload(config, state, 'https://evil.test/x', ok), (e) => e.code === 'not_found');
  await assert.rejects(fileDownload(config, state, `${id}x`, ok), (e) => e.code === 'not_found');
  await assert.rejects(fileDownload(config, state, id, async () => Response.json({ errorcode: 'invalidtoken' })), (e) => e.code === 'auth');
  await assert.rejects(fileDownload(config, state, id, async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } })), (e) => e.code === 'site');
  await assert.rejects(fileDownload(config, state, id, async () => { throw new Error('offline'); }), (e) => e.code === 'network');
});

test('a manual check rereads every site from the start and continues without waiting for the timer; an open problem shortens the next scan', async () => {
  const { tick } = await import('../src/runtime.js'); const { panelAction } = await import('../src/panel.js');
  const config = { ...mail, platforms: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { type: 'webpages', base_url: `https://${id}.uni.edu.tr/`, download_files: false,
    pages: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, url: `https://${id}.uni.edu.tr/p${i}` })) }])) };
  let current = Object.assign(emptyState(), { armed: true, startedAt: 1, nextFullAt: Date.now() - 1, lastDailySummary: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(Date.now()) });
  const store = { load: async () => structuredClone(current), save: async (s) => { current = structuredClone(s); } }, hits = [];
  let broken = false;
  const run = () => tick(config, store, () => { throw new Error('no mail expected'); }, { pause: async () => {},
    fetcher: async (url) => { hits.push(new URL(url).hostname[0]); return broken && url.includes('c.uni') && !url.endsWith('/p0') ? new Response('x', { status: 500 }) : new Response(`<main><p>İçerik ${new URL(url).pathname}</p></main>`); } });
  assert.equal((await run()).manualPending, false);                       // zamanlanmış tur: 10 dakikalık ritimle sürer
  assert.deepEqual(current.fullRound.done, ['a', 'b']);
  const storage = { alarm: null, setAlarm: async (at) => { storage.alarm = at; }, deleteAlarm: async () => {} };
  const state = await store.load(); await panelAction('check', {}, state, store, storage);
  assert.equal(current.fullRound, undefined); assert.ok(storage.alarm);  // yarım tur atılır: a ve b de yeniden okunur
  hits.length = 0;
  assert.equal((await run()).manualPending, true);                        // sığmadı: birkaç saniye sonra sürdürülür
  assert.ok(hits.filter((host) => host === 'a').length >= 20);
  const done = await run();
  assert.equal(done.manualPending, false); assert.equal(current.manualRequestedAt, null); assert.equal(current.fullRound, undefined);
  assert.equal(current.nextFullAt - current.lastFullAt, 60 * 60000);
  // Bir sitede okuma sorunu sürerken sonraki tam tarama 20 dakikaya çekilir.
  broken = true; current.nextFullAt = Date.now() - 1;
  for (let i = 0; i < 4 && (i === 0 || current.fullRound); i++) await run();
  assert.equal(current.platforms.c.error, 'partial'); assert.equal(current.nextFullAt - current.lastFullAt, 20 * 60000);
});

test('an address alone selects a known preset or an announcement archive, and generic websites still work', () => {
  const state = { sites: [] };
  const fen = saveSite(state, { base_url: 'fen.bartin.edu.tr' });
  assert.equal(fen.base_url, 'https://fen.bartin.edu.tr/');
  assert.equal(fen.pages[0].url, 'https://fen.bartin.edu.tr/duyuru-arsiv.html');
  assert.equal(capabilities(fen).announcements.level, 'full');
  const moodle = saveSite(state, { base_url: 'https://sanalogrenme.bartin.edu.tr/login/index.php' });
  assert.equal(moodle.id, 'sanal');
  assert.equal(moodle.type, 'moodle');
  assert.equal(moodle.base_url, 'https://sanalogrenme.bartin.edu.tr');
  const generic = saveSite(state, { base_url: 'https://www.baska.edu.tr/etkinlikler' });
  assert.equal(generic.name, 'www.baska.edu.tr');
  assert.equal(generic.pages[0].url, 'https://www.baska.edu.tr/etkinlikler');
  assert.equal(capabilities(generic).pageChanges.level, 'full');
  assert.throws(() => saveSite(state, { base_url: 'http://fen.bartin.edu.tr' }), /https/);
});

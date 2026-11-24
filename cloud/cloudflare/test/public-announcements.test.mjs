import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '../src/panel.js';
import { readPublicAnnouncements } from '../src/web-announcements.js';
import { saveSite, effectiveSites } from '../src/sites.js';
import { emptyState, mergeSnapshot, parsePage, webSnapshot } from '../src/core.js';
import { testSite as probeSite } from '../src/runtime.js';

const root = 'https://kampus.ornek.edu.tr/';
const archive = root + 'duyurular';
const feed = root + 'announcements/feed.xml';

const listing = (detail = '') => `
  <section class="announcement"><nav><a href="/duyurular">Arşiv</a></nav><aside><table>
    <tr><td><a href="/ogrenci/burs">Burs başvuruları açıldı</a><span class="tarih">2026-11-24 10:00:00</span></td></tr>
    <tr><td><a href="/duyurular/ara-sinav">Ara sınav takvimi</a><time datetime="2026-11-23"></time></td></tr>
    ${detail}
  </table></aside></section>`;
const home = `<nav><a href="https://baska.edu.tr/duyurular">Dış duyurular</a>
  <a href="/duyurular?sil=1">Güvensiz seçim</a>
  <a href="/duyurular">Tüm duyurular</a></nav><main>Örnek üniversite</main>`;

test('a university homepage discovers its archive once, exposes each announcement and notifies the next new entry only', async () => {
  const state = emptyState();
  const site = saveSite(state, { base_url: root });
  const config = { platforms: {} };
  const platform = effectiveSites(state, config).active[site.id];
  const page = platform.pages[0];
  const requests = [];
  let archiveBody = listing();
  const responseFor = (url) => {
    requests.push(url);
    assert.ok([root, archive].includes(url), url);
    return url === root ? home : archiveBody;
  };
  const mock = { request: async (url) => ({ url, text: responseFor(url) }) };

  const result = await probeSite(config, state, site.id, { fetcher: async (url) => new Response(responseFor(url)), pause: async () => {} });
  assert.equal(result.counts.announcements, 2);
  assert.deepEqual(result.preview.map((item) => item.title), ['Burs başvuruları açıldı', 'Ara sınav takvimi']);
  assert.equal(dashboard(config, state).sites[0].capabilities.announcements.level, 'full');
  requests.length = 0;

  mergeSnapshot(state, site.id, { items: parsePage(home, root, page), complete: [page.id], errors: [] }, 1000);
  mergeSnapshot(state, site.id, await webSnapshot(platform, mock), 2000);
  assert.deepEqual(requests, [root, archive]);
  assert.equal(Object.keys(state.pending).length, 0);
  assert.equal(dashboard(config, state).sites[0].announcements[0].url, root + 'ogrenci/burs');

  const previousFormats = state.platforms[site.id].formats;
  archiveBody = '<main>Geçici hata</main>';
  const unavailable = await webSnapshot(platform, mock, null, previousFormats);
  assert.deepEqual(unavailable.complete, []);
  assert.equal(unavailable.errors[0].code, 'site');
  mergeSnapshot(state, site.id, unavailable, 3000);
  assert.equal(dashboard(config, state).sites[0].announcements.length, 2);

  archiveBody = listing('<tr><td><a href="/duyurular/yeni-duyuru">Yeni öğrenci duyurusu</a></td></tr>');
  mergeSnapshot(state, site.id, await webSnapshot(platform, mock, null, previousFormats), 4000);
  assert.deepEqual(Object.values(state.pending).map((change) => change.item.title), ['Yeni öğrenci duyurusu']);
});

test('RSS and Atom entries are read without following individual or external links', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Öğrenci duyuruları</title>
    <item><title>Duyuru &amp; başvuru</title><link>${root}ilan/1</link><pubDate>Tue, 24 Nov 2026 08:00:00 GMT</pubDate></item>
    <item><title>Başka alan</title><link>https://baska.edu.tr/ilan/1</link></item>
  </channel></rss>`;
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom duyurusu</title>
    <link rel="alternate" href="/ilan/2"/><updated>2026-11-23T12:00:00Z</updated></entry></feed>`;
  const declared = '<link rel="alternate" type="application/rss+xml" title="Site yayınları" href="/announcements/feed.xml">';
  const genericFeed = '<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">';
  assert.equal(readPublicAnnouncements(genericFeed, root).next, root + 'feed.xml');
  assert.equal(readPublicAnnouncements(genericFeed + declared, root).next, feed);
  assert.deepEqual(readPublicAnnouncements(atom, feed).entries, [{ title: 'Atom duyurusu', url: root + 'ilan/2', date: '2026-11-23' }]);
  const requests = [];
  const page = { id: 'web', kind: 'page', url: root };
  const snapshot = await webSnapshot({ pages: [page], auto_announcements: true }, {
    request: async (url) => {
      requests.push(url);
      return { url, text: url === root ? declared : rss };
    },
  });
  assert.deepEqual(requests, [root, feed]);
  assert.deepEqual(snapshot.items.map((item) => [item.kind, item.title, item.url, item.fields.Tarih]), [
    ['announcement', 'Duyuru & başvuru', root + 'ilan/1', '2026-11-24'],
  ]);
});

test('generic content remains detectable when no public announcement listing can be identified', async () => {
  const r = await webSnapshot({ auto_announcements: true, pages: [{ id: 'home', url: root, kind: 'page' }] }, {
    request: async (url) => ({ url, text: '<main><h2>Üniversitemiz</h2><p>Ana sayfanın içeriği</p></main>' }),
  });
  assert.deepEqual(r.items.map((item) => item.kind), ['page']);
  assert.equal(r.formats, undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, flushQueue, queueNotice } from '../src/core.js';
import { queueStatusReport, platformFailure, platformRecovered, reportStatus, STATUS_REPORT_INTERVAL } from '../src/health.js';

const HOUR = 3600000;
import { tick } from '../src/runtime.js';

const now = Date.parse('2026-11-10T01:00:00Z');
const config = { platforms: { x: { display_name: 'Okul', token: 'TOKEN-MUST-NOT-LEAK', cookies: [{ value: 'COOKIE-MUST-NOT-LEAK' }] } } };
function stateAt(at = now) {
  const state = emptyState();
  state.platforms.x = { items: {}, lastSuccess: at, error: null };
  return state;
}
/** Düşen oturum ilk tespitte bildirilir; aynı gözlemi yinelemek uyarıyı çoğaltmaz. */
const drop = (state, id, at) => { platformFailure(state, id, 'auth', at); platformFailure(state, id, 'auth', at); };
const accept = (state, at) => flushQueue(state, { save: async () => {}, quota: () => 1, send: async () => {} }, at);

const items = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`i${i}`, { item: {} }]));
const pendingReports = (state) => Object.values(state.pending).filter((change) => change.noticeKey?.startsWith('status/'));

const dayOf = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(at);
/** Günlük özeti o gün için gönderilmiş sayarak yalnızca durum değişikliği raporlarını sınar. */
const report = (state, at, cfg = config) => { state.lastDailySummary = dayOf(at); queueStatusReport(state, cfg, at); };
const EVENING = Date.parse('2026-11-10T18:00:00Z'); // İstanbul 21:00

test('quiet days: two daytime updates and one evening summary on Istanbul time', async () => {
  const state = stateAt();
  state.platforms.x.items = items(5);
  const sent = [];
  // İki gün boyunca her zaman dilimi için yalnızca bir e-posta gider.
  for (let at = now; at < EVENING + 24 * HOUR - 600000; at += 600000) {
    state.platforms.x.lastSuccess = at;
    queueStatusReport(state, config, at);
    for (const change of pendingReports(state)) {
      sent.push(at);
      if (change.noticeKey.includes('/daytime/')) {
        assert.match(change.item.title, /tüm siteler güncel/);
        assert.match(change.item.body, /içerik değişikliği tespit edilmedi/);
        assert.match(change.item.body, /Okul: Son kontrolde hata yok\nSon başarılı tam kontrol:/);
        continue;
      }
      assert.equal(change.item.title, 'Günlük özet · bugün yeni içerik yok');
      assert.equal(change.detectedAt, EVENING);
      assert.match(change.item.body, /SON 24 SAATTE YENİ İÇERİK\nBaşarılı kontrollerde yeni ödev, dosya, duyuru, sınav ya da not tespit edilmedi/);
      assert.match(change.item.body, /SİTELERİN DURUMU\n1 sitenin hepsi hatasız okundu\./);
      assert.doesNotMatch(change.item.body, /Takip edilen kayıt|Kuyrukta/);
      assert.ok(!JSON.stringify(change).includes('MUST-NOT-LEAK'));
    }
    await accept(state, at);
  }
  assert.deepEqual(sent, [-12, -6, 0, 12, 18].map(h => EVENING + h * HOUR));
  assert.equal(reportStatus(state).lastStatusReportSentAt, EVENING + 18 * HOUR);
  // Ertesi gün 21:00: yeni günün tek özeti.
  queueStatusReport(state, config, EVENING + 24 * HOUR);
  assert.equal(pendingReports(state).length, 1);
});

test('a changed record count is not a status change: new content has its own mail', async () => {
  const state = stateAt();
  state.platforms.x.items = items(5);
  report(state, now);
  for (const [hours, count] of [[1, 7], [4, 9], [30, 4], [200, 12]]) {
    state.platforms.x.items = items(count); state.platforms.x.lastSuccess = now + hours * HOUR;
    report(state, now + hours * HOUR);
    assert.equal(Object.keys(state.pending).length, 0, `${hours}. saatte rapor gitmemeli`);
  }
  // Özet, son 24 saatte bildirilen içerik sayısını söyler.
  state.activity = [{ type: 'new', sentAt: now + 229 * HOUR }, { type: 'notice', sentAt: now + 229 * HOUR }, { type: 'new', sentAt: now }];
  queueStatusReport(state, config, now + 233 * HOUR); // İstanbul 21:00
  assert.equal(pendingReports(state)[0].item.title, 'Günlük özet · 1 yeni içerik/değişiklik');
});

test('every access and read failure is queued at its first detection', async () => {
  for (const code of ['partial', 'network', 'deadline', 'maintenance', 'site', 'auth', 'gate']) {
    const state = stateAt();
    platformFailure(state, 'x', code, now);
    assert.equal(Object.keys(state.pending).length, 1, code);
    assert.equal(Object.values(state.pending)[0].detectedAt, now);
    await accept(state, now);
    platformFailure(state, 'x', code, now + 600000);
    assert.deepEqual(state.pending, {}, 'same incident must not repeat: ' + code);
  }
});

test('a continuous failure is announced once and its recovery is reported once', async () => {
  const state = stateAt(); report(state, now);
  platformFailure(state, 'x', 'network', now + HOUR); report(state, now + HOUR);
  assert.deepEqual(Object.values(state.pending).map((change) => change.item.title), ['Siteye ulaşılamıyor']);
  await accept(state, now + HOUR);
  for (const hours of [2, 5, 30, 200]) {
    platformFailure(state, 'x', 'network', now + hours * HOUR); report(state, now + hours * HOUR);
    assert.deepEqual(state.pending, {});
  }
  const up = now + 201 * HOUR;
  platformRecovered(state, 'x', up, { full: true }); state.platforms.x.lastSuccess = up;
  report(state, up);
  assert.match(pendingReports(state)[0].item.body, /Düzelen siteler/);
  await accept(state, up); report(state, up + HOUR);
  assert.deepEqual(state.pending, {});
});

test('a dropped session and a survey wall are both announced on their first check', async () => {
  const state = stateAt(); state.panelURL = 'https://panel.example';
  platformFailure(state, 'x', 'auth', now);
  assert.ok(Object.values(state.pending)[0].item.body.includes('https://panel.example/#/baglan/x'));
  await accept(state, now);
  platformRecovered(state, 'x', now + 1, { full: true });
  platformFailure(state, 'x', 'gate', now + 2);
  const notice = Object.values(state.pending)[0];
  assert.equal(notice.item.title, 'Site anket veya onay ekranı gösteriyor');
  assert.match(notice.item.body, /kendi tarayıcından girip ekrandaki formu tamamla/);
});

test('even a short login failure is announced once and a subsequent incident gets its own warning', async () => {
  const state = stateAt(); report(state, now);
  platformFailure(state, 'x', 'auth', now + HOUR); report(state, now + HOUR);
  assert.equal(Object.keys(state.pending).length, 1);
  await accept(state, now + HOUR);
  platformRecovered(state, 'x', now + HOUR + 600000, { full: true }); report(state, now + HOUR + 600000);
  await accept(state, now + HOUR + 600000);
  assert.deepEqual(state.connectionLog.map((entry) => entry.code), ['auth', 'ok']);
  platformFailure(state, 'x', 'auth', now + 2 * HOUR);
  assert.equal(Object.values(state.pending).filter((entry) => entry.noticeKey.startsWith('incident/')).length, 1);
});

test('a recovery inside the three-hour window waits for the window instead of being lost', async () => {
  const state = stateAt();
  report(state, now);
  drop(state, 'x', now + HOUR); report(state, now + HOUR);
  await accept(state, now + HOUR);
  platformRecovered(state, 'x', now + 2 * HOUR, { full: true }); state.platforms.x.lastSuccess = now + 2 * HOUR;
  report(state, now + 2 * HOUR);
  await accept(state, now + 2 * HOUR);
  assert.equal(reportStatus(state).lastStatusReportSentAt, now + 2 * HOUR);
  // Bağlantısı gidip gelen site: ikinci düzelme raporu pencere dolana kadar bekler.
  drop(state, 'x', now + 3 * HOUR); report(state, now + 3 * HOUR);
  await accept(state, now + 3 * HOUR);
  platformRecovered(state, 'x', now + 4 * HOUR, { full: true }); state.platforms.x.lastSuccess = now + 4 * HOUR;
  report(state, now + 4 * HOUR);
  assert.deepEqual(state.pending, {});
  state.platforms.x.lastSuccess = now + 2 * HOUR + STATUS_REPORT_INTERVAL;
  report(state, now + 2 * HOUR + STATUS_REPORT_INTERVAL);
  assert.equal(pendingReports(state).length, 1);
});

test('a status snapshot left by the previous version does not produce a report', () => {
  const state = stateAt(now + 3 * HOUR);
  state.lastStatusReportAt = now; state.statusTroubled = ['x']; // Eski sürümlerden kalan durum.
  state.lastStatusSnapshot = { x: { label: 'Son kontrolde hata yok', count: 3 } };
  for (const hours of [3, 6, 168]) {
    state.platforms.x.lastSuccess = now + hours * HOUR; report(state, now + hours * HOUR);
    assert.equal(Object.keys(state.pending).length, 0);
  }
  assert.equal(state.statusTroubled, undefined);
});

test('pausing, resuming, adding or removing a site in the panel does not produce a report by itself', () => {
  const state = stateAt();
  state.sites = [{ id: 'x', name: 'Okul' }, { id: 'p', name: 'Kapalı', paused: true }, { id: 'old', name: 'Eski' }];
  state.platforms.p = { items: {}, lastSuccess: now, error: null };
  state.platforms.old = { items: {}, lastSuccess: now, error: null };
  report(state, now);
  state.sites = [{ id: 'x', name: 'Okul' }, { id: 'p', name: 'Kapalı' }, { id: 'new', name: 'Yeni' }];
  state.platforms.x.lastSuccess = state.platforms.p.lastSuccess = now + 4 * HOUR;
  report(state, now + 4 * HOUR);
  state.sites[0].paused = true; state.platforms.p.lastSuccess = now + 8 * HOUR;
  report(state, now + 8 * HOUR);
  assert.equal(Object.keys(state.pending).length, 0);
  assert.deepEqual(Object.keys(state.lastStatusSnapshot), ['x', 'p', 'new']);
});

test('failed summary remains durable without accumulating more reports during SMTP outage', async () => {
  const state = stateAt(EVENING); let durable;
  queueStatusReport(state, config, EVENING);
  await flushQueue(state, { quota: () => 1, save: async (s) => { durable = structuredClone(s); }, send: async () => { throw Error('offline'); } }, EVENING);
  assert.equal(Object.values(durable.pending)[0].attempts, 1);
  for (const days of [1, 2, 5]) queueStatusReport(durable, config, EVENING + days * 24 * HOUR);
  assert.equal(Object.keys(durable.pending).length, 1);
  await accept(durable, EVENING + 5 * 24 * HOUR);
  assert.equal(Object.keys(durable.pending).length, 0);
});

test('the daily summary shows paused, expired, stale and missing checks without claiming success', () => {
  const state = stateAt(EVENING - 86400000);
  state.sites = [{ id: 'x', name: 'Eski' }, { id: 'missing', name: 'Yeni' }, { id: 'paused', name: 'Kapalı', paused: true }, { id: 'auth', name: 'Oturum' }, { id: 'ok', name: 'Düzelen' }];
  state.platforms.auth = { error: 'auth' };
  state.platforms.ok = { items: {}, lastSuccess: EVENING, error: null };
  queueStatusReport(state, config, EVENING);
  const body = pendingReports(state)[0].item.body;
  assert.match(body, /1 sitede sorun var/);
  assert.match(body, /Düzelen: Son kontrolde hata yok/);
  assert.match(body, /Eski: Tam kontrol güncel değil/);
  assert.match(body, /Yeni: Tam kontrol güncel değil/);
  assert.match(body, /Kapalı: Duraklatıldı/);
  assert.match(body, /Oturum: Yeniden giriş gerekiyor/);
});

test('a once-only notice is never repeated as a reminder, a regular notice may repeat after a day', async () => {
  const state = stateAt();
  queueNotice(state, 'stale/x/1', 'x', 'A', 'a', now, { once: true }); queueNotice(state, 'other', 'x', 'B', 'b', now);
  await accept(state, now);
  queueNotice(state, 'stale/x/1', 'x', 'A', 'a', now + 30 * 86400000, { once: true }); queueNotice(state, 'other', 'x', 'B', 'b', now + 86400000);
  assert.deepEqual(Object.values(state.pending).map((change) => change.noticeKey), ['other']);
});

test('a fresh incident after recovery is sent immediately, continuous failure is not spammed', async () => {
  const state = stateAt();
  drop(state, 'x', now);
  const first = Object.values(state.pending)[0].noticeKey;
  await accept(state, now);
  platformFailure(state, 'x', 'auth', now + 1);
  assert.equal(Object.keys(state.pending).length, 0);
  platformRecovered(state, 'x', now + 2, { full: true });
  drop(state, 'x', now + HOUR);
  assert.equal(Object.keys(state.pending).length, 1);
  assert.notEqual(Object.values(state.pending)[0].noticeKey, first);
  platformFailure(state, 'x', 'gate', now + HOUR + 4);
  assert.deepEqual(Object.values(state.pending).map((change) => change.item.title), ['Site anket veya onay ekranı gösteriyor']);
});

test('a deferred login warning is removed on recovery, without removing content or another site warning', async () => {
  const state = stateAt();
  state.platforms.other = { items: {}, lastSuccess: now };
  platformFailure(state, 'x', 'auth', now);
  await flushQueue(state, { save: async () => {}, quota: () => 1, send: async () => { throw new Error('SMTP offline'); } }, now);
  queueNotice(state, 'content/x', 'x', 'İçerik özeti', '', now, { once: true });
  platformFailure(state, 'other', 'auth', now);
  platformRecovered(state, 'x', now + 1);
  assert.deepEqual(Object.values(state.pending).map(({ platform, item }) => [platform, item.title]), [
    ['x', 'İçerik özeti'], ['other', 'Yeniden giriş gerekiyor'],
  ]);
});

test('an overdue full-check warning remains until that site completes a full scan', () => {
  const state = stateAt();
  for (const id of ['x', 'other']) queueNotice(state, `stale/${id}/1`, id, '24 saattir başarılı kontrol yok', '', now);
  queueNotice(state, 'bulk/x/test', 'x', 'Yeni içerik', '', now);
  const keys = () => Object.values(state.pending).map(change => change.noticeKey);
  platformRecovered(state, 'x', now + 1);
  assert.deepEqual(keys(), ['stale/x/1', 'stale/other/1', 'bulk/x/test']);
  platformRecovered(state, 'x', now + 2, { full: true });
  assert.deepEqual(keys(), ['stale/other/1', 'bulk/x/test']);
});

test('a good session check cannot hide a failing content section', () => {
  const state = stateAt();
  platformFailure(state, 'x', 'partial', now);
  platformRecovered(state, 'x', now + 1);
  assert.equal(state.platforms.x.error, 'partial');
  platformRecovered(state, 'x', now + 2, { full: true });
  assert.equal(state.platforms.x.error, null);
});

test('urgent incident precedes an older content backlog when delivery quota is limited', async () => {
  const state = stateAt(); let available = true, first;
  state.pending.old = { id: 'old', platform: 'other', type: 'new', item: { title: 'File' }, nextAttempt: now, attempts: 0 };
  drop(state, 'x', now);
  await flushQueue(state, { save: async () => {}, quota: () => available ? 1 : 0, send: async (name) => { first = name; available = false; } }, now);
  assert.equal(first, 'x'); assert.ok(state.pending.old);
});

test('all due incidents go first and content mail advances across sites with a limited quota', async () => {
  const state = stateAt();
  state.platforms.other = { items: {}, lastSuccess: now };
  for (let n = 0; n < 40; n++) {
    const id = 'x-' + n;
    state.pending[id] = { id, platform: 'x', type: 'new', item: { title: id }, nextAttempt: now, attempts: n === 0 ? 3 : 0 };
  }
  state.pending.other = { id: 'other', platform: 'other', type: 'new', item: { title: 'Other' }, nextAttempt: now, attempts: 0 };
  drop(state, 'x', now);
  drop(state, 'other', now);
  const sent = [];
  await flushQueue(state, { save: async () => {}, quota: () => 4 - sent.length, send: async (name, changes) => {
    sent.push([name, changes.length, Boolean(changes[0].noticeKey)]);
  } }, now);
  assert.deepEqual(sent, [['x', 1, true], ['other', 1, true], ['x', 30, false], ['other', 1, false]]);
  assert.ok(state.pending['x-0']);
});

test('Moodle token is checked between full scans and urgent warning is attempted before the next site', async () => {
  const at = Date.now(), state = emptyState();
  state.armed = true; state.nextFullAt = at + 3600000; state.lastStatusReportAt = at;
  // Önceki kontrol anahtarın reddedildiğini görmüştü; bu kontrol doğrular ve uyarıyı hemen göndermeye çalışır.
  state.sequence = 1;
  state.platforms.sanal = { items: {}, scopes: {}, lastSuccess: at, error: 'auth', healthIncident: { code: 'auth', key: 'incident/sanal/1', startedAt: at - 600000, since: at - 600000, announced: false } };
  state.platforms.web = { items: {}, scopes: {}, lastSuccess: at, error: null };
  const cfg = { platforms: {
    sanal: { type: 'moodle', base_url: 'https://sanalogrenme.bartin.edu.tr', token: 'fake' },
    web: { type: 'webpages', base_url: 'https://www.uni.edu.tr', pages: [{ id: 'p', url: 'https://www.uni.edu.tr/p' }] },
  } };
  let current = state, warningAttempted = false, checkedNext = false;
  await tick(cfg, { load: async () => structuredClone(current), save: async (s) => { current = structuredClone(s); } },
    () => { throw Error('SMTP offline'); }, { pause: async () => {}, fetcher: async (_url, options) => {
      if (options.method === 'POST') {
        assert.equal(new URLSearchParams(options.body).get('wsfunction'), 'core_webservice_get_site_info');
        return Response.json({ errorcode: 'invalidtoken' });
      }
      warningAttempted = Object.values(current.pending).some((c) => c.noticeKey?.startsWith('incident/sanal/') && c.attempts === 1);
      checkedNext = true;
      return new Response('<p>Coursework</p>');
    } });
  assert.ok(checkedNext); assert.ok(warningAttempted);
  assert.equal(current.platforms.sanal.error, 'auth');
  assert.equal(current.platforms.web.error, null);
});

test('the daily summary leads with the content of the day and the deadlines of the coming week', () => {
  const state = stateAt(EVENING - HOUR);
  state.platforms.x.lastSuccess = EVENING - 600000;
  const due = EVENING + 2 * 86400000;
  state.platforms.x.items = {
    a: { item: { kind: 'assignment', title: 'Lab 5', course: 'Algoritmalar', dueAt: due } },
    e: { item: { kind: 'event', title: 'Lab 5 teslim tarihi', course: 'Algoritmalar', dueAt: due } },
    late: { item: { kind: 'assignment', title: 'Proje', course: 'Web', dueAt: EVENING + 10 * 86400000 } },
    gone: { item: { kind: 'quiz', title: 'Silinen sınav', dueAt: due }, missingSince: EVENING - HOUR },
  };
  state.activity = [
    { platform: 'x', type: 'new', title: 'Hafta 7.pdf', course: 'Algoritmalar', sentAt: EVENING - 3 * HOUR },
    { platform: 'x', type: 'updated', title: 'Vize notu', course: 'Web', sentAt: EVENING - 5 * HOUR },
    { platform: 'system', type: 'notice', title: 'Günlük özet', sentAt: EVENING - 2 * HOUR },
    { platform: 'x', type: 'new', title: 'Dünkü dosya', sentAt: EVENING - 30 * HOUR },
  ];
  queueStatusReport(state, config, EVENING);
  const change = pendingReports(state)[0];
  assert.equal(change.item.title, 'Günlük özet · 2 yeni içerik/değişiklik');
  assert.match(change.item.body, /• Okul · Algoritmalar — Hafta 7\.pdf \(yeni\)\n• Okul · Web — Vize notu \(güncellendi\)/);
  assert.doesNotMatch(change.item.body, /Dünkü dosya|Günlük özet \(/);
  assert.match(change.item.body, /ÖNÜMÜZDEKİ 7 GÜNDE SON TARİHİ OLANLAR\n• .* · Okul · Algoritmalar — Lab 5\n\nSİTELERİN/);
  assert.doesNotMatch(change.item.body, /Lab 5 teslim tarihi|Proje|Silinen sınav/);
});

test('different assignments, exams and calendar events can share a deadline', () => {
  const state = stateAt(EVENING);
  const dueAt = EVENING + HOUR;
  const record = (kind, title) => ({ item: { kind, title, course: 'Programlama', dueAt } });
  state.platforms.x.items = {
    lab: record('assignment', 'Lab'), essay: record('assignment', 'Rapor'), exam: record('quiz', 'Kısa sınav'),
    mirror: record('event', 'Lab teslim tarihi'), seminar: record('event', 'Seminer'),
  };
  queueStatusReport(state, config, EVENING);
  const body = pendingReports(state)[0].item.body;
  for (const title of ['Lab', 'Rapor', 'Kısa sınav', 'Seminer']) assert.ok(body.includes('— ' + title + '\n'), title);
  assert.doesNotMatch(body, /Lab teslim tarihi/);
});

test('bulk content is included in daytime and evening reports before and after mail delivery', async () => {
  for (const alreadySent of [false, true]) {
    const state = stateAt(EVENING - 7 * HOUR);
    queueNotice(state, 'bulk/x/test/1', 'x', 'Toplu içerik göründü', 'Bir grup dosya eklendi.', EVENING - 7 * HOUR);
    if (alreadySent) await accept(state, EVENING - 7 * HOUR);
    queueStatusReport(state, config, EVENING - 6 * HOUR);
    const daytime = pendingReports(state)[0];
    assert.match(daytime.item.body, /içerik değişikliği tespit edildi/);
    delete state.pending[daytime.id];
    queueStatusReport(state, config, EVENING);
    const evening = pendingReports(state)[0].item;
    assert.match(evening.title, /1 toplu içerik bildirimi/);
    assert.match(evening.body, /Okul — Toplu içerik göründü/);
    assert.equal(evening.body.includes('e-posta bekliyor'), !alreadySent);
  }
});

test('the daily summary includes detected content still waiting for email', () => {
  const state = stateAt(EVENING - HOUR);
  state.pending.grade = { id: 'grade', platform: 'x', type: 'updated', item: { title: 'Vize', course: 'Web' },
    detectedAt: EVENING - 60000, nextAttempt: EVENING + 60000, attempts: 1 };
  queueStatusReport(state, config, EVENING);
  const report = pendingReports(state)[0];
  assert.equal(report.item.title, 'Günlük özet · 1 yeni içerik/değişiklik');
  assert.match(report.item.body, /Okul · Web — Vize \(güncellendi, e-posta bekliyor\)/);
  assert.match(report.item.body, /1 içerik bildirimi gönderim kuyruğunda/);
  assert.ok(state.pending.grade);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanURL, emptyState, mergeSnapshot, makeItem, flushQueue, parsePage, cookieHeader, fieldDiff, safeURL, webSnapshot } from '../src/core.js';
import { SiteClient } from '../src/http.js';
import { moodleCall, moodleSnapshot, flatten } from '../src/moodle.js';
import { Vault, b64 } from '../src/store.js';
import { hash } from '../src/hash.js';
import { smtp, message } from '../src/smtp.js';
import { baseline, configuration, tick, assignmentTest, keepUbysSession } from '../src/runtime.js';

const now = 1900000000000;
const HOUR_MS = 3600000;
const snap = (items, complete = ['p']) => ({ items, complete, errors: [] });
const item = (body, id = '1') => makeItem('p', id, 'page', 'Başlık', { body });
const platform = { base_url: 'https://example.com/', cookies: [] };
const fast = { pause: async () => {}, clock: () => now, deadline: now + 240000 };
const key = b64(crypto.getRandomValues(new Uint8Array(32)));
const mailConfig = { to: 'student@example.com', smtp: { username: 'student@gmail.com', password: 'abcdefghijklmnop' } };

test('ÜBYS grade checks notify once between full scans without changing unrelated scopes', async () => {
  const base = 'https://ubys.bartin.edu.tr';
  const sessionCheck = base + '/conversation/GetMyNewMessagesCount';
  const grade = { id: 'grades', kind: 'grade', url: base + '/AIS/Student/Class/Index', content_selector: '#grades', track_text: false };
  const assignment = { id: 'assignments', kind: 'assignment', url: base + '/assignments', content_selector: '#tasks' };
  const ubys = { base_url: base + '/', type: 'webpages', pages: [grade, assignment], session_check_url: base + '/',
    logged_out_markers: ['id="loginForm"'], cookies: [{ name: 'session', value: 'original', domain: 'ubys.bartin.edu.tr', path: '/', expires: -1 }] };
  const config = { ...mailConfig, platforms: { ubys } };
  const previous = Date.now() - 600000;
  const table = (score) => `<table id="grades"><tr><th>Sınav</th><th>Not</th></tr><tr><td>Vize</td><td>${score}</td></tr></table>`;
  let state = emptyState();
  state.armed = true;
  state.lastFullAt = previous;
  state.sites = [{ id: 'ubys', type: 'webpages', preset: 'bartin-ubys', name: 'ÜBYS', base_url: ubys.base_url,
    pages: ubys.pages, session_check_url: ubys.session_check_url }];
  mergeSnapshot(state, 'ubys', { items: [...parsePage(table(''), grade.url, grade), makeItem(assignment.id, '1', 'assignment', 'Ev ödevi')],
    complete: [grade.id, assignment.id], errors: [] }, previous);
  state.platforms.ubys.partial = [{ scope: assignment.id, code: 'site' }];
  const before = structuredClone(state.platforms.ubys);
  const store = { load: async () => structuredClone(state), save: async value => { state = structuredClone(value); } };
  const requests = [];
  let sends = 0, reject = false;
  const connection = smtpMock().connect;
  const options = { pause: async () => {}, connect: (...args) => { sends++; return connection(...args); }, fetcher: async (url) => {
    requests.push(url);
    if (reject) return new Response('<form id="loginForm"></form>');
    if (url === sessionCheck) return Response.json(0);
    return new Response(url === grade.url ? table('82') : '<main>Öğrenci ekranı</main>');
  } };
  await keepUbysSession(config, store, options);
  assert.deepEqual(requests, [grade.url]);
  assert.equal(sends, 1);
  assert.equal(state.activity.at(-1).category, 'grade');
  assert.equal(state.activity.at(-1).type, 'updated');
  assert.equal(Object.keys(state.pending).length, 0);
  assert.equal(state.lastFullAt, previous);
  assert.equal(state.platforms.ubys.lastSuccess, previous);
  assert.deepEqual(state.platforms.ubys.partial, before.partial);
  assert.equal(state.platforms.ubys.scopes.assignments, previous);
  await keepUbysSession(config, store, options);
  assert.deepEqual(requests, [grade.url, sessionCheck]);
  assert.equal(sends, 1);
  state.platforms.ubys.lastGradeCheckAt = previous;
  reject = true;
  await keepUbysSession(config, store, options);
  assert.deepEqual(requests.slice(-2), [grade.url, sessionCheck]);
  assert.equal(sends, 1);
  assert.equal(state.platforms.ubys.cookies[0].value, 'original');
});

test('displayed links keep page IDs while stripping sign-in fields', () => {
  const link = 'https://student:example@portal.test/page?id=123&refresh_token=synthetic&id_token=synthetic&client_secret=synthetic#main';
  assert.equal(cleanURL(link), 'https://portal.test/page?id=123');
});

test('assignment test mail identifies each platform and never claims a real assignment', () => {
  const config = { platforms: { sanal: { display_name: 'Sanal Öğrenme' }, ogreniyorum: { display_name: 'Öğreniyorum.net' }, ubys: { display_name: 'ÜBYS' } } };
  const before = JSON.stringify(config);
  for (const [name, platform] of Object.entries(config.platforms)) {
    const mail = assignmentTest(config, name, now);
    assert.ok(mail.subject.startsWith('[DENEME]'));
    assert.ok(mail.subject.includes(platform.display_name));
    assert.ok(mail.body.includes('Ödeviniz var'));
    assert.ok(mail.body.includes('Gerçek bir ödev duyurusu değildir.'));
    assert.ok(mail.html.includes('DENEME'));
  }
  assert.equal(JSON.stringify(config), before);
  for (const bad of ['unknown', '__proto__', '']) assert.throws(() => assignmentTest(config, bad), (e) => e.code === 'config');
});

test('baseline silent, changes stable, cycles A-B-A independently queued', () => {
  const state = emptyState();
  mergeSnapshot(state, 'x', snap([item('A')]), now);
  assert.equal(Object.keys(state.pending).length, 0);
  mergeSnapshot(state, 'x', snap([item('B')]), now + 1);
  mergeSnapshot(state, 'x', snap([item('B')]), now + 2);
  mergeSnapshot(state, 'x', snap([item('A')]), now + 3);
  assert.deepEqual(Object.values(state.pending).map((change) => change.item.body), ['B', 'A']);
});

test('partial sections and sudden content loss preserve previous data', () => {
  const state = emptyState();
  const items = Array.from({ length: 8 }, (_, n) => item(String(n), String(n)));
  mergeSnapshot(state, 'x', snap(items), now);
  mergeSnapshot(state, 'x', snap([], []), now + 1);
  assert.equal(Object.keys(state.platforms.x.items).length, 8);
  mergeSnapshot(state, 'x', snap([]), now + 2);
  mergeSnapshot(state, 'x', snap([]), now + 3);
  assert.equal(Object.keys(state.platforms.x.items).length, 8);
  mergeSnapshot(state, 'x', snap([]), now + 4);
  assert.equal(Object.values(state.platforms.x.items).filter((record) => !record.missingSince).length, 0);
  assert.equal(Object.values(state.pending)[0].type, 'notice');
});

const material = (id, publishedAt, name = id) => makeItem('p', `material/${id}`, 'material', name, { course: 'Ders', material: { url: 'https://ubys.example.edu.tr/c', extension: 'pdf', opensSource: true, publishedAt } });
const DAY = 86400000;

test('old files that vanish for a scan and come back are not mailed again as new', () => {
  const state = emptyState();
  const files = [material('a', now - 30 * DAY), material('b', now - 20 * DAY)];
  mergeSnapshot(state, 'x', snap(files), now);
  // Site bir kontrolde dersi boş döndürdü (5'ten az kayıt: azalma koruması devreye girmez).
  mergeSnapshot(state, 'x', snap([]), now + 3600000);
  assert.deepEqual(state.pending, {});
  assert.ok(Object.values(state.platforms.x.items).every((record) => record.missingSince));
  mergeSnapshot(state, 'x', snap(files), now + 7200000);
  assert.deepEqual(state.pending, {});
  assert.ok(Object.values(state.platforms.x.items).every((record) => !record.missingSince));
});

test('a file the teacher opens late with an old publish date is still mailed as new', () => {
  const state = emptyState();
  mergeSnapshot(state, 'x', snap([material('a', now - 30 * DAY)]), now);
  // Hoca üç hafta önce tarihlenmiş ders notunu bugün erişime açtı: yayın tarihi eski diye bastırılmaz.
  mergeSnapshot(state, 'x', snap([material('a', now - 30 * DAY), material('hafta-5', now - 21 * DAY)]), now + DAY);
  assert.deepEqual(Object.values(state.pending).map((change) => [change.type, change.item.title]), [['new', 'hafta-5']]);
});

test('a genuinely new file, or one without a publish date, is still mailed once', () => {
  const state = emptyState();
  mergeSnapshot(state, 'x', snap([material('a', now - 30 * DAY)]), now);
  const t = now + 3600000;
  mergeSnapshot(state, 'x', snap([material('a', now - 30 * DAY), material('new', t - 600000), material('undated', null)]), t);
  assert.deepEqual(Object.values(state.pending).map((change) => [change.type, change.item.title]), [['new', 'new'], ['new', 'undated']]);
  mergeSnapshot(state, 'x', snap([material('a', now - 30 * DAY), material('new', t - 600000), material('undated', null)]), t + 3600000);
  assert.equal(Object.keys(state.pending).length, 2);
});

test('SMTP outage retains queue indefinitely, durable before send, then acknowledges', async () => {
  const state = emptyState();
  mergeSnapshot(state, 'x', snap([item('A')]), now);
  mergeSnapshot(state, 'x', snap([item('B')]), now + 1);
  let saved = null;
  const io = { quota: () => 1, save: async (s) => { saved = structuredClone(s); }, send: async () => { assert.equal(Object.keys(saved.pending).length, 1); throw new Error('offline'); } };
  let time = now + 2;
  for (let n = 0; n < 20; n++) { await flushQueue(state, io, time); time += 3600001; }
  assert.equal(Object.values(state.pending)[0].attempts, 20);
  io.send = async () => {};
  await flushQueue(state, io, time);
  assert.equal(Object.keys(state.pending).length, 0);
  assert.equal(Object.keys(saved.pending).length, 0);
});

test('failed durable checkpoint prevents external mail', async () => {
  const state = emptyState(); mergeSnapshot(state, 'x', snap([item('A')]), now); mergeSnapshot(state, 'x', snap([item('B')]), now + 1);
  let sent = false;
  await assert.rejects(flushQueue(state, { quota: () => 1, save: async () => { throw new Error('disk'); }, send: async () => { sent = true; } }, now + 2));
  assert.equal(sent, false);
});

test('nested grade tables retain headings and identify updates after reorder', () => {
  const html = (grade, reversed = false) => `<div id="content"><table id="courses"><tr><th>Ders</th><th>Ad</th></tr>${(reversed ? ['B', 'A'] : ['A', 'B']).map((name) => `<tr><td>${name}</td><td>Ders ${name}</td></tr><tr><td colspan="2"><table><tr><th>Sınav</th><th>Not</th></tr><tr><td>Vize</td><td>${name === 'A' ? grade : '-'}</td></tr></table></td></tr>`).join('')}</table></div>`;
  const page = { id: 'p', kind: 'grade', content_selector: '#content', track_text: false, track_links: false, key_columns: [0] };
  const before = parsePage(html('-'), platform.base_url, page), after = parsePage(html('85', true), platform.base_url, page);
  const state = emptyState(); mergeSnapshot(state, 'x', snap(before), now); mergeSnapshot(state, 'x', snap(after), now + 1);
  const changes = Object.values(state.pending);
  assert.equal(changes.length, 1); assert.equal(changes[0].type, 'updated');
  assert.equal(fieldDiff(changes[0].previous, changes[0].item), 'Not: - → 85');
});

test('time counters are filtered while actual exam dates survive', () => {
  const [data] = parsePage('<div id="c"><p>Son giriş: 09.11.2026 13:12</p><p>Online sınav 20 Kasım’da</p></div>', platform.base_url, { id: 'p', content_selector: '#c' });
  assert.equal(data.body, 'Online sınav 20 Kasım’da');
});

test('cookie isolation and HTTPS redirect safety', () => {
  const cookies = [{ name: 'a', value: 'secret', domain: 'example.com', path: '/', expires: -1 }, { name: 'edevlet', value: 'never', domain: 'turkiye.gov.tr', path: '/' }];
  assert.equal(cookieHeader(cookies, platform.base_url), 'a=secret');
  for (const url of ['http://example.com/', 'https://evil.com/', 'https://user:pass@example.com/', 'https://example.com:444/']) assert.throws(() => safeURL(url, platform.base_url));
});

test('network retry, redirects and renewed cookies work without decompressing twice', async () => {
  let call = 0;
  const client = new SiteClient(platform, { ...fast, fetcher: async (_url, options) => {
    call++;
    if (call === 1) return new Response('retry', { status: 503 });
    if (call === 2) return new Response(null, { status: 302, headers: { Location: '/ok', 'Set-Cookie': 'session=renewed; Path=/; Secure' } });
    assert.equal(options.headers.Cookie, 'session=renewed');
    return new Response('hello');
  } });
  assert.equal((await client.request(platform.base_url)).text, 'hello'); assert.equal(call, 3);
});

test('auth, cross-host redirects and response-size errors are not retried', async () => {
  for (const [response, code] of [[new Response('', { status: 403 }), 'auth'], [new Response(null, { status: 302, headers: { Location: 'https://evil.com/' } }), 'unsafe'], [new Response('x', { headers: { 'Content-Length': String(9 * 1024 * 1024) } }), 'size']]) {
    let calls = 0;
    const client = new SiteClient(platform, { ...fast, fetcher: async () => { calls++; return response; } });
    await assert.rejects(client.request(platform.base_url), (e) => e.code === code); assert.equal(calls, 1);
  }
});

test('web page failure preserves only that scope and login forms cause auth error', async () => {
  const p = { ...platform, pages: [{ id: 'good', url: 'https://example.com/good', content_selector: '#c' }, { id: 'missing', url: 'https://example.com/bad', content_selector: '#c' }] };
  const client = { request: async (url) => ({ url, text: url.endsWith('good') ? '<div id="c">Hello</div>' : '<div>changed</div>' }) };
  const data = await webSnapshot(p, client);
  assert.deepEqual(data.complete, ['good']); assert.equal(data.errors[0].scope, 'missing');
  client.request = async () => ({ text: '<input type="password">', url: p.pages[0].url });
  await assert.rejects(webSnapshot(p, client), (e) => e.code === 'auth');
});

test('Moodle forbids write methods and formats nested parameters', async () => {
  await assert.rejects(moodleCall({}, 'mod_assign_save_submission'), (e) => e.code === 'unsafe');
  assert.deepEqual(flatten({ events: { courseids: [3, 4] } }), { 'events[courseids][0]': '3', 'events[courseids][1]': '4' });
});

test('Moodle optional forum failure and partial assignment do not remove successful data', async () => {
  const client = { platform: { base_url: 'https://example.com', token: 'fake', features: {} }, request: async (_url, options) => {
    const fn = options.payload.wsfunction;
    const responses = {
      core_webservice_get_site_info: { userid: 1 }, core_course_get_enrolled_courses_by_timeline_classification: { courses: [{ id: 2, fullname: 'Course' }] },
      core_course_get_contents: [{ id: 1, name: 'Section', modules: [] }], mod_assign_get_assignments: { courses: [{ id: 2, assignments: [{ id: 1, name: 'staged' }] }, { id: 3 }] },
      mod_quiz_get_quizzes_by_courses: { quizzes: [] }, core_calendar_get_calendar_events: { events: [] }, gradereport_user_get_grade_items: { usergrades: [] },
      mod_forum_get_forums_by_courses: { errorcode: 'nopermissions', exception: 'moodle_exception' },
    }; return { text: JSON.stringify(responses[fn]) };
  } };
  const result = await moodleSnapshot(client.platform, client, now);
  assert.ok(result.complete.includes('contents/2')); assert.ok(!result.complete.includes('assignments'));
  assert.ok(!result.items.some((i) => i.title === 'staged')); assert.ok(result.errors.some((e) => e.scope === 'forums'));
});

test('AES-GCM authenticates content, object identity and encryption key', async () => {
  const vault = new Vault(key), plain = new TextEncoder().encode('private grades');
  const first = await vault.seal(plain, 'state'), second = await vault.seal(plain, 'state');
  assert.notEqual(first, second); assert.ok(!first.includes('private'));
  assert.deepEqual(await vault.open(first, 'state'), plain);
  await assert.rejects(vault.open(first, 'file/other'));
  await assert.rejects(new Vault(b64(new Uint8Array(32))).open(first, 'state'));
});

function smtpMock({ rejectMail = false, dataReply, onQuit } = {}) {
  let controller; const writes = [];
  const readable = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('220 Gmail\r\n')); } });
  const writable = new WritableStream({ write(bytes) {
    const line = new TextDecoder().decode(bytes); writes.push(line);
    let reply = '250 OK\r\n';
    if (line.startsWith('EHLO')) reply = '250-Gmail\r\n250 AUTH PLAIN\r\n';
    if (line.startsWith('AUTH')) reply = '235 accepted\r\n';
    if (line.startsWith('DATA')) reply = '354 go\r\n';
    if (line.includes('Message-ID:') && (dataReply || rejectMail)) reply = `${dataReply || 552} rejected\r\n`;
    if (line.startsWith('QUIT') && onQuit) return onQuit();
    if (line.startsWith('QUIT')) reply = '221 bye\r\n';
    // Deliberately fragment replies across stream chunks.
    controller.enqueue(new TextEncoder().encode(reply.slice(0, 2))); controller.enqueue(new TextEncoder().encode(reply.slice(2)));
  } });
  const connect = (host, options) => { assert.deepEqual(host, { hostname: 'smtp.gmail.com', port: 465 }); assert.equal(options.secureTransport, 'on'); return { readable, writable, opened: Promise.resolve(), closed: Promise.resolve(), close: async () => {} }; };
  return { connect, writes };
}
test('SMTP TLS login probe sends no message; MIME supports UTF8 attachments', async () => {
  let mock = smtpMock(); await smtp(mock.connect, mailConfig);
  assert.ok(!mock.writes.some((line) => line.startsWith('MAIL')));
  mock = smtpMock(); await smtp(mock.connect, mailConfig, { subject: 'Sınav', body: 'Not: 85', id: 'change/1' }, [{ name: 'ödev.pdf', bytes: new Uint8Array([1, 2, 3]) }]);
  const content = mock.writes.find((line) => line.includes('Message-ID:'));
  assert.ok(content.includes('Content-Disposition: attachment')); assert.ok(content.includes('AQID'));
  assert.ok(!content.includes(mailConfig.smtp.password));
  assert.throws(() => message({ ...mailConfig, to: 'a@example.com\r\nBcc:evil@example.com' }, { body: '', subject: '' }));
});
test('warning subject names the actual problem; only a dropped session asks for re-login', async () => {
  const { sendGroup } = await import('../src/runtime.js'); const { platformFailure } = await import('../src/health.js');
  const subjectOf = async (code) => {
    const state = emptyState(); state.platforms.ders = { items: {} }; state.panelURL = 'https://panel.test';
    // Bütün hatalar ilk gözlemde bildirilir; aynı olayın ikinci gözlemi çoğaltılmaz.
    platformFailure(state, 'ders', code, 1000); platformFailure(state, 'ders', code, 1000 + 600000);
    const group = Object.values(state.pending), mock = smtpMock();
    await sendGroup(mock.connect, mailConfig, state, { read: async () => null }, 'ders', group);
    const header = mock.writes.find((line) => line.includes('Message-ID:')).match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
    return { subject: new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))), body: group[0].item.body };
  };
  const auth = await subjectOf('auth'), gate = await subjectOf('gate'), size = await subjectOf('size');
  assert.ok(auth.subject.endsWith('Yeniden giriş gerekiyor')); assert.ok(auth.body.includes('https://panel.test/#/baglan/ders'));
  assert.ok(gate.subject.endsWith('Site anket veya onay ekranı gösteriyor')); assert.ok(gate.body.includes('yeniden bağlanman gerekmiyor'));
  assert.ok(size.subject.endsWith('Sayfa boyutu sınırı aşıldı')); assert.ok(size.body.includes('yeniden giriş yapman gerekmiyor'));
  for (const mail of [gate, size]) assert.ok(!mail.subject.includes('giriş') && !mail.body.includes('#/baglan/'));
});
test('a bulk appearance of old content is recorded silently and announced once, a normal upload is still mailed item by item', () => {
  const state = emptyState(), course = (count, from = 0) => ({ complete: ['c'], errors: [], items: Array.from({ length: count }, (_, i) =>
    makeItem('c', `f${from + i}`, 'file', `Hafta ${from + i}`, { course: 'BTS321', files: [{ url: `https://example.com/f${from + i}.pdf`, name: `f${from + i}.pdf`, version: 'v' }] })) });
  mergeSnapshot(state, 'web', course(3), 1000);                               // ilk okuma sessizdir
  assert.equal(mergeSnapshot(state, 'web', course(5), 2000), 2);              // hocanın yüklediği iki dosya tek tek bildirilir
  assert.equal(Object.values(state.pending).filter((change) => change.type === 'new').length, 2);
  assert.equal(Object.keys(state.fileJobs).length, 2);
  state.pending = {}; state.fileJobs = {};
  assert.equal(mergeSnapshot(state, 'web', course(45), 3000), 0);             // 40 kayıt birden: eski içerik yeniden listelendi
  const pending = Object.values(state.pending);
  assert.equal(pending.length, 1); assert.equal(pending[0].item.title, 'Toplu içerik göründü');
  assert.match(pending[0].item.body, /BTS321: 40 kayıt aynı kontrolde topluca göründü/); assert.match(pending[0].item.body, /… ve 30 kayıt daha/);
  assert.equal(Object.keys(state.fileJobs).length, 0);                        // dosyaları indirilmez, e-postaya eklenmez
  assert.equal(Object.keys(state.platforms.web.items).length, 45);            // kayıtlar panelde durur
  state.pending = {};
  assert.equal(mergeSnapshot(state, 'web', course(45), 4000), 0);             // aynı liste yeniden bildirilmez
  assert.deepEqual(state.pending, {});
});

test('SMTP failure is sanitized and never exposes app password', async () => {
  await assert.rejects(smtp(smtpMock({ rejectMail: true }).connect, mailConfig, { subject: 'test', body: 'test' }), (e) => e.code === 'mail' && !e.message.includes(mailConfig.smtp.password));
});

test('cloud export validation rejects eDevlet cookies', () => {
  const c = { ...mailConfig, platforms: {
    sanal: { base_url: 'https://sanalogrenme.bartin.edu.tr', type: 'moodle', token: 'fake' },
    ogreniyorum: { base_url: 'https://ogreniyorum.net/mooc/', type: 'webpages', cookies: [{ domain: 'ogreniyorum.net' }], pages: [{ url: 'https://ogreniyorum.net/mooc/' }] },
    ubys: { base_url: 'https://ubys.bartin.edu.tr/', type: 'webpages', cookies: [{ domain: 'ubys.bartin.edu.tr' }], pages: [{ url: 'https://ubys.bartin.edu.tr/read' }] },
  } };
  assert.ok(configuration(JSON.stringify(c)));
  c.platforms.ubys.cookies.push({ domain: 'turkiye.gov.tr' });
  assert.throws(() => configuration(JSON.stringify(c)), (e) => e.code === 'config');
});

test('external Moodle URL resources remain modules, not downloadable files', async () => {
  const p = { base_url: 'https://example.com', token: 'fake', features: { assignments: false, quizzes: false, calendar: false, grades: false, announcements: false } };
  const responses = { core_webservice_get_site_info: { userid: 1 },
    core_course_get_enrolled_courses_by_timeline_classification: { courses: [{ id: 1, fullname: 'Course' }] },
    core_course_get_contents: [{ id: 2, modules: [{ id: 3, modname: 'url', name: 'External link', url: 'https://example.com/mod/url/view.php?id=3', contents: [{ type: 'url', filename: 'link', fileurl: 'https://forms.gle/example' }] }] }],
  };
  const result = await moodleSnapshot(p, { platform: p, request: async (_url, options) => ({ text: JSON.stringify(responses[options.payload.wsfunction]) }) }, now);
  assert.equal(result.errors.length, 0);
  assert.ok(result.items.some((i) => i.kind === 'module' && i.title === 'External link'));
  assert.ok(!result.items.some((i) => i.kind === 'file'));
});

test('baseline isolates expired platform, then recovery is silent and later failure preserves records', async () => {
  const config = { ...mailConfig, platforms: {
    sanal: { base_url: 'https://example.com', token: 'fake', type: 'moodle', features: { contents: false, assignments: false, quizzes: false, calendar: false, grades: false, announcements: false } },
    web: { ...platform, type: 'webpages', pages: [{ id: 'p', url: 'https://example.com/page', content_selector: '#c' }] },
  } };
  let state = emptyState(), fail = true, saves = 0;
  const store = { load: async () => structuredClone(state), save: async (s) => { saves++; state = structuredClone(s); } };
  const fetcher = async (_url, options) => {
    if (options.method === 'POST') {
      const fn = new URLSearchParams(options.body).get('wsfunction');
      return Response.json(fn === 'core_webservice_get_site_info' ? { userid: 1 } : { courses: [{ id: 1, fullname: 'Course' }] });
    }
    return new Response(fail ? '<input type="password">' : '<div id="c">Actual coursework</div>');
  };
  const opts = { ...fast, clock: Date.now, deadline: undefined, fetcher };
  await baseline(config, store, opts);
  assert.equal(saves, 1); assert.equal(state.armed, true);
  assert.equal(state.platforms.sanal.error, null); assert.equal(state.platforms.web.error, 'auth');
  assert.equal(Object.keys(state.platforms.web.items).length, 0);
  const accepted = (...args) => smtpMock().connect(...args);
  state.manualRequestedAt = Date.now(); state.intervalMinutes = 30;
  fail = false; await tick(config, store, accepted, { ...opts, scheduled: true });
  assert.equal(state.platforms.web.error, null); assert.equal(Object.keys(state.pending).length, 0);
  assert.equal(Object.keys(state.platforms.web.items).length, 1); assert.equal(state.scheduledRuns, 1);
  assert.equal(state.manualRequestedAt, null); assert.equal(state.nextFullAt - state.lastFullAt, 30 * 60000);
  const previous = structuredClone(state.platforms.web.items);
  fail = true;
  const refused = () => { throw new Error('SMTP offline'); };
  await tick(config, store, refused, { ...opts, force: true });
  assert.deepEqual(state.platforms.web.items, previous);
  assert.equal(state.platforms.web.error, 'auth');
  // İlk gözlem uyarıyı üretir; giriş sayfasının çerezleri saklı oturumun üzerine yazılmaz.
  assert.equal(Object.values(state.pending).filter((change) => change.noticeKey?.startsWith('incident/web/')).length, 1);
  state.platforms.web.healthIncident.since -= 600000;
  await tick(config, store, refused, { ...opts, force: true });
  // Aynı kesinti ikinci kez uyarı üretmez; gönderilemeyen ilk uyarı korunur.
  assert.ok(Object.keys(state.notices).some((key) => key.startsWith('incident/web/')));
  assert.equal(Object.values(state.pending).filter((change) => change.noticeKey?.startsWith('incident/web/')).length, 1);
});

test('initial start does not arm or save when every platform fails authentication', async () => {
  let saved = false;
  const config = { ...mailConfig, platforms: { web: { ...platform, type: 'webpages', pages: [{ id: 'p', url: 'https://example.com/' }] } } };
  await assert.rejects(baseline(config, { load: async () => emptyState(), save: async () => { saved = true; } },
    { ...fast, clock: Date.now, fetcher: async () => new Response('<input type="password">') }), (e) => e.code === 'auth');
  assert.equal(saved, false);
});

test('an empty table message is not tracked as a row, and a page text summary is not an assignment', () => {
  const html = `<div class="content"><h1>Ödevler</h1><table><tr><th>Ödev</th><th>Son Tarih</th></tr><tr><td colspan="2">Kayit bulunamadi.</td></tr></table></div>`;
  const items = parsePage(html, 'https://example.com/odevler', { id: 'odev', kind: 'assignment', content_selector: '.content' });
  assert.deepEqual(items.map((item) => item.id), ['odev/text']);
  const full = parsePage(html.replace('<td colspan="2">Kayit bulunamadi.</td>', '<td>Proje</td><td>20.11.2026</td>'), 'https://example.com/odevler', { id: 'odev', kind: 'assignment', content_selector: '.content' });
  assert.equal(full.filter((item) => item.id !== 'odev/text').length, 1);
  for (const message of ['Kayıt bulunamadı', 'Kayıt bulunmamaktadır.', 'No records found']) {
    const rows = parsePage(`<table><tr><th>A</th></tr><tr><td>${message}</td></tr></table>`, 'https://example.com/', { id: 'p', track_text: false });
    assert.deepEqual(rows, [], message);
  }
});

test('the same content under a new id or a changed link is not mailed again, but two identical files in one course still count', () => {
  const state = emptyState();
  const topic = (id, title, url) => makeItem('learning/ders-1', `material/${id}`, 'material', title, { course: 'E-Ticaret', url: 'https://ogreniyorum.net/c', material: { url, extension: 'pdf', opensSource: false } });
  const scan = (suffix) => ({ items: [topic(`giris-${suffix}`, 'Giriş', `https://ogreniyorum.net/x?konu=${suffix}1`), topic(`ozet-${suffix}`, 'Konu Özeti', `https://ogreniyorum.net/x?konu=${suffix}2`), topic(`ozet2-${suffix}`, 'Konu Özeti', `https://ogreniyorum.net/x?konu=${suffix}3`)], complete: ['learning/ders-1'], errors: [] });
  mergeSnapshot(state, 'og', scan('1'), now);
  for (let hour = 1; hour <= 6; hour++) mergeSnapshot(state, 'og', scan(String(hour + 1)), now + hour * 3600000);
  assert.deepEqual(state.pending, {});
  // Gerçekten yeni bir içerik (üçüncü "Konu Özeti" dahil) yine bir kez bildirilir.
  const next = scan('9'); next.items.push(topic('ozet3', 'Konu Özeti', 'https://ogreniyorum.net/x?konu=94'), topic('mobil', 'Mobil Ticaret', 'https://ogreniyorum.net/x?konu=95'));
  mergeSnapshot(state, 'og', next, now + 7 * 3600000);
  assert.deepEqual(Object.values(state.pending).map((change) => change.item.title).sort(), ['Konu Özeti', 'Mobil Ticaret']);
  mergeSnapshot(state, 'og', next, now + 8 * 3600000);
  assert.equal(Object.keys(state.pending).length, 2);
});

test('content removed and re-added within a week is not mailed again; after a week it is new again', () => {
  const state = emptyState();
  const a = makeItem('p', 'one', 'announcement', 'Duyuru', { body: 'Vize 20 Kasım' });
  mergeSnapshot(state, 'x', snap([makeItem('p', 'other', 'page', 'Sayfa')]), now);
  mergeSnapshot(state, 'x', snap([makeItem('p', 'other', 'page', 'Sayfa'), a]), now + 1);
  assert.equal(Object.keys(state.pending).length, 1); state.pending = {};
  delete state.platforms.x.items['p/one'];
  mergeSnapshot(state, 'x', snap([makeItem('p', 'other', 'page', 'Sayfa'), makeItem('p', 'two', 'announcement', 'Duyuru', { body: 'Vize 20 Kasım' })]), now + 2 * 86400000);
  assert.deepEqual(state.pending, {});
  delete state.platforms.x.items['p/two'];
  mergeSnapshot(state, 'x', snap([makeItem('p', 'other', 'page', 'Sayfa'), makeItem('p', 'three', 'announcement', 'Duyuru', { body: 'Vize 20 Kasım' })]), now + 9 * 86400000);
  assert.equal(Object.keys(state.pending).length, 1);
});

const SURVEY = ['Bana Zorunlu Ölçekler', 'Bilişsel Yük Aktarımı Ölçeği', 'Daha önce bir proje ya da ödev kapsamında hazırlayıp teslim etmeniz gereken bir raporu oluştururken yapay zekâ araçlarından yararlandınız mı? *',
  '1- Ders kapsamında karşılaştığım bir kavramı kendi sözcükleriyle açıklamasını yapay zekâdan isterim. *', '2- Bir ders metninde anlatılan ana düşünceyi belirlemesini yapay zekâdan isterim. *'].join('\n');
const pageText = (scope, body) => makeItem(scope, 'text', 'page', `Sayfa ${scope}`, { body });
const pages = (bodies) => ({ items: Object.entries(bodies).flatMap(([scope, body]) => [pageText(scope, body), makeItem(scope, 'row', 'table_row', `Satır ${scope}`)]), complete: Object.keys(bodies), errors: [] });
const normal = { a: 'Duyurular\nVize 20 Kasım', b: 'Ödevler\nÖdev 1', c: 'Konular\nHafta 1', d: 'Sınavlar\nFinal' };

test('a mandatory survey shown on every page is a wall, not an update: nothing is mailed and old records survive', () => {
  const state = emptyState();
  mergeSnapshot(state, 'og', pages(normal), now);
  // Site bütün sayfalarda aynı anketi gösteriyor (bir sayfada seçici farkından başlık fazladan geliyor).
  const wall = pages({ a: `Ölçeklerim\n${SURVEY}`, b: SURVEY, c: SURVEY, d: SURVEY });
  wall.items = wall.items.filter((entry) => entry.kind === 'page');
  mergeSnapshot(state, 'og', wall, now + HOUR_MS);
  assert.deepEqual(state.pending, {});
  assert.equal(state.platforms.og.error, 'gate');
  assert.deepEqual(wall.errors.map((error) => error.code), ['gate', 'gate', 'gate', 'gate']);
  assert.equal(state.platforms.og.lastSuccess, now);
  assert.equal(state.platforms.og.items['a/text'].item.body, normal.a);
  assert.ok(!state.platforms.og.items['a/row'].missingSince);
  // Anket doldurulunca sayfalar eski hâline döner: bildirim yok; sonrasında gerçek değişiklik bildirilir.
  mergeSnapshot(state, 'og', pages(normal), now + 2 * HOUR_MS);
  assert.deepEqual(state.pending, {});
  assert.equal(state.platforms.og.error, null);
  mergeSnapshot(state, 'og', pages({ ...normal, b: 'Ödevler\nÖdev 1\nÖdev 2' }), now + 3 * HOUR_MS);
  assert.deepEqual(Object.values(state.pending).map((change) => [change.type, change.item.id]), [['updated', 'b/text']]);
});

test('survey text already stored as content by the older version is recognised and replaced silently', () => {
  const state = emptyState();
  mergeSnapshot(state, 'og', pages(normal), now);
  delete state.platforms.og.gateChecked;
  // Eski sürüm anket metnini içerik diye kaydetmişti.
  for (const scope of ['a', 'b', 'c', 'd']) Object.assign(state.platforms.og.items[`${scope}/text`], { item: pageText(scope, SURVEY), fingerprint: 'eski' });
  const wall = pages({ a: SURVEY, b: SURVEY, c: SURVEY, d: SURVEY });
  mergeSnapshot(state, 'og', wall, now + HOUR_MS);
  assert.deepEqual(state.pending, {});
  assert.equal(state.platforms.og.error, 'gate');
  mergeSnapshot(state, 'og', pages(normal), now + 2 * HOUR_MS);
  assert.deepEqual(state.pending, {});
  assert.equal(state.platforms.og.items['a/text'].item.body, normal.a);
  assert.equal(state.platforms.og.items['a/text'].gate, undefined);
});

test('two pages sharing a text, short identical texts and a first scan are never treated as a wall', () => {
  const state = emptyState();
  // İlk kontrol: karşılaştırılacak eski içerik yok, aynı metinli sayfalar olduğu gibi kaydedilir.
  mergeSnapshot(state, 'x', pages({ a: SURVEY, b: SURVEY, c: SURVEY }), now);
  assert.equal(state.platforms.x.error, null);
  const other = emptyState();
  mergeSnapshot(other, 'x', pages(normal), now);
  mergeSnapshot(other, 'x', pages({ ...normal, a: SURVEY, b: SURVEY }), now + HOUR_MS);
  assert.equal(Object.keys(other.pending).length, 2);
  other.pending = {};
  mergeSnapshot(other, 'x', pages({ a: 'Kayıt yok', b: 'Kayıt yok', c: 'Kayıt yok', d: 'Kayıt yok' }), now + 2 * HOUR_MS);
  assert.equal(Object.keys(other.pending).length, 4);
  assert.equal(other.platforms.x.error, null);
});

test('a new item with a due date shows its description; a moved date is shown in Istanbul time', () => {
  const item = { title: 'Ödev 1', body: 'Rapor yüklenecek.', dueAt: Date.UTC(2026, 10, 20, 20, 59) };
  assert.equal(fieldDiff(null, item), 'Rapor yüklenecek.');
  const moved = fieldDiff({ ...item, dueAt: Date.UTC(2026, 10, 18, 20, 59) }, item);
  assert.match(moved, /^Tarih güncellendi: 18\.11\.2026 23:59 → 20\.11\.2026 23:59 \(İstanbul\)$/);
  assert.doesNotMatch(moved, /T\d\d:\d\d:\d\d/);
  assert.equal(fieldDiff(item, item), 'Rapor yüklenecek.');
});

test('accepted SMTP delivery stays successful if the server stalls during QUIT', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let notifyQuit;
  const atQuit = new Promise(resolve => { notifyQuit = resolve; });
  const mock = smtpMock({ onQuit: notifyQuit });
  const delivery = smtp(mock.connect, mailConfig, { subject: 'Test', body: 'Test' });
  await atQuit;
  t.mock.timers.tick(30001);
  await delivery;
  assert.equal(mock.writes.filter(line => line.includes('Message-ID:')).length, 1);
});

test('concurrent assignment edits all appear in the email and activity details', () => {
  const previous = { fields: { Ekler: 'ilk.pdf', Konu: 'Hafta 1' }, body: 'İlk açıklama', dueAt: now };
  const current = { fields: { Ekler: 'yeni.pdf' }, body: 'Yeni açıklama', dueAt: now + HOUR_MS };
  const detail = fieldDiff(previous, current);
  for (const part of ['ilk.pdf → yeni.pdf', 'Konu: Hafta 1 → —', 'Tarih güncellendi', 'Yeni açıklama']) assert.ok(detail.includes(part), part);
  assert.match(fieldDiff({ ...previous, fields: {} }, { ...current, fields: {} }), /Tarih güncellendi/);
});

test('an unreadable optional attachment does not block the homework notification', async () => {
  const { sendGroup } = await import('../src/runtime.js');
  const state = emptyState(), file = { url: 'https://school.example/task.pdf', version: 'v1', name: 'task.pdf' };
  state.archive[hash(`school/${file.url}/v1`)] = { sha: 'test-sha', size: 4, name: file.name };
  const item = makeItem('assignments', 'hw', 'assignment', 'Ödev', { url: 'https://school.example/task', files: [file] });
  const mock = smtpMock();
  await sendGroup(mock.connect, mailConfig, state, { read: async () => { throw Error('unavailable'); } },
    'school', [{ id: 'school/1', type: 'new', item, detectedAt: now }]);
  const content = mock.writes.find(line => line.includes('Message-ID:'));
  assert.ok(content);
  assert.doesNotMatch(content, /Content-Disposition: attachment/);
  const body = Buffer.from(content.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0], 'base64').toString();
  assert.match(body, /task.pdf arşivden okunamadı/);
  assert.match(body, /https:\/\/school.example\/task/);
});

test('only a permanent rejection of the mail content triggers a retry without attachments', async () => {
  const { sendGroup } = await import('../src/runtime.js');
  const file = { url: 'https://school.example/file', name: 'test.pdf', version: 'v1' };
  const item = makeItem('assignments', 'hw', 'assignment', 'Ödev', { files: [file] });
  const state = emptyState();
  state.archive[hash(`school/${file.url}/v1`)] = { sha: 'data', name: file.name, size: 1 };
  for (const code of [451, 552]) {
    const attempts = [];
    const connect = (...args) => {
      const mock = smtpMock(attempts.length ? {} : { dataReply: code });
      attempts.push(mock);
      return mock.connect(...args);
    };
    const delivery = sendGroup(connect, mailConfig, state, { read: async () => new Uint8Array([1]) },
      'school', [{ id: 'school/1', type: 'new', item, detectedAt: now }]);
    if (code === 451) {
      await assert.rejects(delivery, { code: 'mail' });
      assert.equal(attempts.length, 1);
    } else {
      await delivery;
      assert.equal(attempts.length, 2);
      assert.ok(!attempts[1].writes.some(line => line.includes('Content-Disposition: attachment')));
    }
    assert.ok(attempts[0].writes.some(line => line.includes('Content-Disposition: attachment')));
  }
});

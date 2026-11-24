// Öğreniyorum.net ve ÜBYS için siteye özel okuma. Örnekler gerçek sayfaların YAPISINI taklit eder;
// içerikleri tamamen uydurmadır (kişi adı, ders, tarih, kimlik değerleri gerçek değildir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSnapshot, parsePage, parseOgrenCountdown, ubysCourseTabs, mergeSnapshot, emptyState } from '../src/core.js';
import { hash } from '../src/hash.js';
import { capabilities, PRESETS } from '../src/sites.js';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const ogrenPage = (id) => PRESETS['bartin-ogreniyorum'].pages.find((page) => page.id === id);
const OGREN = 'https://ogreniyorum.net/mooc/index.php';

// --- Öğreniyorum.net -------------------------------------------------------------------------------------

const notifications = (rows) => `<html><body><div class="content"><div class="card">
  <div class="card-header"><h3 class="card-title">Bildirim Listesi</h3></div>
  <div class="card-body p-0"><table class="table table-sm"><thead><tr><th>Baslik</th><th>Mesaj</th><th>Tarih</th><th>Durum</th><th>Islem</th></tr></thead>
  <tbody>${rows.map(([title, message, date, status]) => `<tr><td>${title}</td><td>${message}</td><td>${date}</td><td>${status}</td>
    <td><a class="btn btn-sm btn-info" href="index.php?do=odevteslim&konu=ORNEK">Ac</a></td></tr>`).join('')}</tbody></table></div></div></div></body></html>`;

test('Öğreniyorum bildirimleri: okundu/okunmadı değişimi bildirim üretmez, yeni bildirim üretir', () => {
  const page = ogrenPage('bildirimler');
  const unread = parsePage(notifications([['Ödev yorumu', 'Örnek ödevinize yorum yapıldı.', '01.10.2026 10:00', 'Okunmadi']]), `${OGREN}?do=bildirimler`, page);
  const read = parsePage(notifications([['Ödev yorumu', 'Örnek ödevinize yorum yapıldı.', '01.10.2026 10:00', 'Okundu']]), `${OGREN}?do=bildirimler`, page);
  assert.equal(unread.length, 1);
  assert.equal(unread[0].kind, 'announcement');
  assert.deepEqual(Object.keys(unread[0].fields), ['Baslik', 'Mesaj', 'Tarih']);
  assert.equal(hash(unread[0]), hash(read[0]), 'yalnızca Durum sütunu değişti');
  // Aynı başlıklı iki bildirim ayrı kayıtlardır.
  const two = parsePage(notifications([['Ödev yorumu', 'Örnek ödevinize yorum yapıldı.', '01.10.2026 10:00', 'Okundu'], ['Ödev yorumu', 'İkinci yorum.', '02.10.2026 11:00', 'Okunmadi']]), `${OGREN}?do=bildirimler`, page);
  assert.equal(new Set(two.map((item) => item.id)).size, 2);
  assert.ok(two.some((item) => item.id === unread[0].id), 'mevcut bildirimin kimliği korunur');
});

test('Öğreniyorum platform duyurusu: yalnızca duyuru kartı izlenir', () => {
  const html = `<html><head><title>ogreniyorum.net</title></head><body><div class="content"><div class="rotate-warning">Ekranı çevirin</div>
    <div class="card announcement-card"><div class="card-header"><h4 class="card-title">Çevrim içi Eğitim Platformu</h4></div>
    <div class="card-body"><p>Örnek duyuru metni: yeni dönem içerikleri yayımlandı.</p><p class="announcement-date">Yayın: 01.09.2026</p></div></div></div></body></html>`;
  const [item, ...rest] = parsePage(html, `${OGREN}?do=anasayfa`, ogrenPage('platform-duyurusu'));
  assert.equal(rest.length, 0);
  assert.equal(item.kind, 'announcement');
  assert.equal(item.title, 'Öğreniyorum.net duyurusu');
  assert.match(item.body, /yeni dönem içerikleri/);
  assert.doesNotMatch(item.body, /Ekranı çevirin/);
});

const countdown = (entries) => `<html><body><div class="content"><div class="card card-info"><div class="card-header"><h3 class="card-title">Kalan Süre</h3></div>
  <div class="card-body"><div class="row">${entries.map(([key, title]) => `<div class="countdown-container"><div class="exam-title">${title}</div><div class="time-boxes" id="countdown${key}"></div></div>`).join('')}</div></div></div></div>
  <script>// Veritabanından gelen geri sayım tarihleri
  const examDates = { ${entries.map(([key, , date]) => `exam${key}: new Date("${date}")`).join(', ')} };</script></body></html>`;

test('Öğreniyorum sınav sayacı: başlık ve İstanbul saatine göre tarih okunur', () => {
  const items = parseOgrenCountdown(countdown([['3', 'Vizelerin Başlaması: 20 Mart 2027', '2027-03-20T23:59:59'], ['4', 'Finallerin Başlangıcı: 05 Haziran 2027', '2027-06-05T09:30:00']]),
    `${OGREN}?do=kacgunkaldi`, ogrenPage('sinav-takvimi'));
  assert.deepEqual(items.map((item) => [item.id, item.kind, item.title]), [
    ['sinav-takvimi/exam/3', 'event', 'Vizelerin Başlaması: 20 Mart 2027'], ['sinav-takvimi/exam/4', 'event', 'Finallerin Başlangıcı: 05 Haziran 2027']]);
  assert.equal(items[0].dueAt, Date.parse('2027-03-20T20:59:59Z'));
  assert.equal(items[1].dueAt, Date.parse('2027-06-05T06:30:00Z'));
  // Sayaç yokken sayfa hâlâ tanınır; yapı değişirse eski kayıtlar korunur.
  assert.deepEqual(parseOgrenCountdown(countdown([]), `${OGREN}?do=kacgunkaldi`, ogrenPage('sinav-takvimi')), []);
  assert.throws(() => parseOgrenCountdown('<div class="content"><p>Başka sayfa</p></div>', `${OGREN}?do=kacgunkaldi`, ogrenPage('sinav-takvimi')), (e) => e.code === 'site');
});

test('Öğreniyorum sınav sayacı genel takip akışında kullanılır', async () => {
  const platform = { pages: [{ ...ogrenPage('sinav-takvimi') }], logged_out_markers: ['name="sifre"'] };
  const client = { request: async (url) => ({ url, text: countdown([['1', 'Vizelerin Başlaması: 20 Mart 2027', '2027-03-20T23:59:59']]) }) };
  const snapshot = await webSnapshot(platform, client);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.items[0].kind, 'event');
  assert.ok(snapshot.items[0].dueAt);
});

// --- ÜBYS -----------------------------------------------------------------------------------------------

const ubysURL = 'https://ubys.bartin.edu.tr/AIS/Student/Class/ClassDetail?classId=ORNEK';
const ubysPlatform = (features = {}) => ({ features, logged_out_markers: ['id="loginForm"', 'data-ajax-url="/Account/Login"'] });
const ubysCourse = ({ homeworks = [], announcements = 1, classId = 'ORNEK!xGGx!' } = {}) => `<html><body>
  <ul class="nav"><li><a href='#3' data-toggle="tab" class="class-tab">&#214;devler<span class="badge" id="odevsayisigosterenSpan">${homeworks.length}</span></a></li>
  <li><a href='#11' data-toggle="tab" class="class-tab">Duyurular <span class="badge" id="duyurusayisigosterenSpan">${announcements}</span></a></li></ul>
  <script id='x'> var EncryptedClassId= null;  (function() { EncryptedClassId= JSON.parse(Base64.decode("${b64(classId)}")); })();</script>
  <script id='y'> var _jsm= null; (function() { _jsm= JSON.parse(Base64.decode("${b64({ StudentClassInfo: { CourseName: 'Örnek Ders', ClassContents: [], Homeworks: homeworks }, UserId: null })}")); })();</script>
  </body></html>`;
const homework = (id, extra = {}) => ({
  Id: id, Name: `Ödev ${id}`, Description: '<p>Örnek açıklama</p>', LastDeliveryDate: '2027-01-15T23:59:00', VisionStartDate: null, VisionEndDate: null,
  IsDeleted: false, Files: [{ IsDeleted: false, File: { Name: 'odev-yonergesi.pdf' } }],
  Persons: [{ Name: 'Uydurma', Surname: 'Öğrenci' }], StudentHomeWorks: [], ...extra,
});
const announcementTab = (rows) => `<div class="row"><div class="col-md-12"><div class="panel panel-default"><div class="panel-body">
  <table id="announcementTable" class="table"><thead><tr><th>No</th><th>Duyuru Tarihi</th><th>Duyuru Başlığı</th><th>İçerik</th><th>Dosya</th></tr></thead>
  <tbody>${rows.map(([date, title, body], i) => `<tr><td>${i + 1}</td><td>${date}</td><td>${title}</td><td>${body}</td><td></td></tr>`).join('')}</tbody></table></div></div></div></div>`;
const examTab = (exams) => `<br /><div class="course-panel"><table id="student-class-exam" class="table"><thead><tr><th>Sınav Adı</th><th>İşlemler</th></tr></thead>
  <tbody><tr><td>Vize</td><td></td></tr><tr><td>Final</td><td></td></tr></tbody></table><div id="student-class-online-exam"></div></div>
  <script> var _jsAllOnlineExams= null; (function() { _jsAllOnlineExams= JSON.parse(Base64.decode("${b64(exams)}")); })();</script>`;

function fakeUbys(tabs) {
  const requests = [];
  return { requests, client: { request: async (url, options = {}) => {
    assert.equal(options.method ?? 'GET', 'GET');
    const target = new URL(url);
    if (target.pathname === '/AIS/Student/Class/ClassDetail') return { url, text: tabs.course };
    assert.equal(target.pathname, '/AIS/Student/Class/GetClassDetailPartial');
    requests.push({ tab: target.searchParams.get('ClassDetailPartial'), classId: target.searchParams.get('ClassId') });
    const body = tabs[target.searchParams.get('ClassDetailPartial')];
    if (body instanceof Error) throw body;
    return { url, text: body };
  } } };
}

test('ÜBYS ders sayfası: ödev, duyuru ve çevrimiçi sınav ayrı kapsamlarda okunur; öğrenci listesi okunmaz', async () => {
  const now = Date.parse('2026-12-01T12:00:00Z');
  const course = ubysCourse({ homeworks: [homework(1), homework(2, { IsDeleted: true }), homework(3, { VisionEndDate: '2026-11-01T00:00:00' }), homework(4, { VisionStartDate: '2027-02-01T00:00:00' })], announcements: 2 });
  const { client, requests } = fakeUbys({
    course,
    11: announcementTab([['20.11.2026', 'Quiz tarihi', 'Örnek &#231;alışma duyurusu.'], ['25.11.2026', 'Ödev teslimi', 'Ödevler sisteme yüklenecek.']]),
    7: examTab([{ Id: 9, ClassAssesmentMethodDetailId: 5, IsTestExam: false, Exam: { Id: 77, Name: 'Çevrimiçi Quiz', StartDate: '2026-12-10T10:00:00', FinishDate: '2026-12-10T10:40:00' } }]),
  });
  const page = { id: 'ders-1', kind: 'course_materials', course_name: 'Örnek Ders', url: ubysURL };
  const out = { items: [], complete: [], errors: [] };
  await ubysCourseTabs(ubysPlatform(), client, { url: ubysURL, text: course }, page, out, now);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.complete, ['assignments/ders-1', 'announcements/ders-1', 'exams/ders-1']);
  assert.deepEqual(requests, [{ tab: '11', classId: 'ORNEK!xGGx!' }, { tab: '7', classId: 'ORNEK!xGGx!' }]);

  const homeworks = out.items.filter((item) => item.kind === 'assignment');
  assert.deepEqual(homeworks.map((item) => item.id), ['assignments/ders-1/homework/1'], 'silinen ve görünürlük dışı ödevler alınmaz');
  assert.equal(homeworks[0].dueAt, Date.parse('2027-01-15T20:59:00Z'));
  assert.equal(homeworks[0].body, 'Örnek açıklama');
  assert.equal(homeworks[0].fields.Ekler, 'odev-yonergesi.pdf');
  assert.equal(homeworks[0].files, undefined, 'ödev ekleri indirilmeye çalışılmaz (indirme ÜBYS\'de kayıt yazar)');
  assert.doesNotMatch(JSON.stringify(out.items), /Uydurma|Öğrenci"/, 'ödevdeki öğrenci listesi kayda girmez');

  const announcements = out.items.filter((item) => item.kind === 'announcement');
  assert.deepEqual(announcements.map((item) => [item.title, item.fields.Tarih, item.course]), [['Quiz tarihi', '20.11.2026', 'Örnek Ders'], ['Ödev teslimi', '25.11.2026', 'Örnek Ders']]);
  assert.equal(announcements[0].body, 'Örnek çalışma duyurusu.');

  const [exam] = out.items.filter((item) => item.kind === 'event');
  assert.equal(exam.id, 'exams/ders-1/online/77');
  assert.equal(exam.dueAt, Date.parse('2026-12-10T07:00:00Z'));
  assert.equal(exam.fields.Tür, 'Çevrimiçi sınav');
});

test('ÜBYS: duyurusu olmayan derste duyuru isteği atılmaz; istenmeyen özellik okunmaz', async () => {
  const course = ubysCourse({ announcements: 0 });
  const { client, requests } = fakeUbys({ course, 7: examTab([]) });
  const out = { items: [], complete: [], errors: [] };
  await ubysCourseTabs(ubysPlatform(), client, { url: ubysURL, text: course }, { id: 'd' }, out);
  assert.deepEqual(requests.map((r) => r.tab), ['7']);
  assert.ok(out.complete.includes('announcements/d'), 'sıfır duyuru da tam okumadır');
  const off = { items: [], complete: [], errors: [] };
  const second = fakeUbys({ course });
  await ubysCourseTabs(ubysPlatform({ quizzes: false, announcements: false, assignments: false }), second.client, { url: ubysURL, text: course }, { id: 'd' }, off);
  assert.deepEqual(second.requests, []); assert.deepEqual(off.complete, []);
});

test('ÜBYS: bir sekme bozulursa yalnızca o kapsam korunur; oturum kapanırsa bütün kontrol durur', async () => {
  const course = ubysCourse({ homeworks: [homework(1)], announcements: 1 });
  const broken = fakeUbys({ course, 11: '<div>Beklenmeyen içerik</div>', 7: examTab([]) });
  const out = { items: [], complete: [], errors: [] };
  await ubysCourseTabs(ubysPlatform(), broken.client, { url: ubysURL, text: course }, { id: 'd' }, out);
  assert.deepEqual(out.errors, [{ scope: 'announcements/d', code: 'site' }]);
  assert.deepEqual(out.complete, ['assignments/d', 'exams/d']);

  const loggedOut = fakeUbys({ course, 11: '<form id="loginForm"><input type="password"></form>', 7: examTab([]) });
  await assert.rejects(ubysCourseTabs(ubysPlatform(), loggedOut.client, { url: ubysURL, text: course }, { id: 'd' }, { items: [], complete: [], errors: [] }), (e) => e.code === 'auth');
});

test('ÜBYS sekmeleri genel akışta çalışır ve ilk okumada mevcut kayıtlar için bildirim üretmez', async () => {
  const platform = { ...ubysPlatform(), pages: [{ id: 'ders-1', kind: 'course_materials', url: ubysURL }] };
  const tabs = { course: ubysCourse({ homeworks: [homework(1)], announcements: 1 }), 11: announcementTab([['20.11.2026', 'İlk duyuru', 'Metin']]), 7: examTab([]) };
  const state = emptyState(), now = Date.parse('2026-12-01T12:00:00Z');
  const first = await webSnapshot(platform, fakeUbys(tabs).client);
  assert.deepEqual(first.complete, ['ders-1', 'assignments/ders-1', 'announcements/ders-1', 'exams/ders-1']);
  assert.equal(mergeSnapshot(state, 'ubys', first, now), 0, 'yeni kapsamlar ilk okumada sessizce başlar');

  tabs.course = ubysCourse({ homeworks: [homework(1), homework(2)], announcements: 2 });
  tabs[11] = announcementTab([['20.11.2026', 'İlk duyuru', 'Metin'], ['28.11.2026', 'Yeni duyuru', 'Yeni metin']]);
  assert.equal(mergeSnapshot(state, 'ubys', await webSnapshot(platform, fakeUbys(tabs).client), now + 60000), 2);
  const kinds = Object.values(state.pending).map((change) => [change.type, change.item.kind, change.item.title]).sort();
  assert.deepEqual(kinds, [['new', 'announcement', 'Yeni duyuru'], ['new', 'assignment', 'Ödev 2']]);
});

// --- Desteklenen özellikler -----------------------------------------------------------------------------

test('capabilities: ÜBYS ders sayfaları ve Öğreniyorum şablonu gerçekte okunanı söyler', () => {
  const ubys = capabilities({ type: 'webpages', preset: 'bartin-ubys', pages: [{ kind: 'grade', url: 'https://ubys.bartin.edu.tr/AIS/Student/Class/Index' }, { kind: 'course_materials', url: ubysURL }] });
  for (const key of ['announcements', 'files', 'assignments']) assert.equal(ubys[key].level, 'full', key);
  assert.match(ubys.announcements.note, /ek adları/);
  assert.match(ubys.files.note, /otomatik arşivleme kapalıdır/);
  assert.match(ubys.assignments.note, /Teslim durumunu ÜBYS üzerinden/);
  assert.equal(ubys.exams.level, 'partial');
  assert.match(ubys.exams.note, /çevrimiçi/i);
  assert.match(ubys.exams.note, /yüz yüze/);
  assert.equal(ubys.grades.level, 'full');

  const noCourses = capabilities({ type: 'webpages', preset: 'bartin-ubys', pages: [{ kind: 'grade', url: 'https://ubys.bartin.edu.tr/AIS/Student/Class/Index' }] });
  assert.equal(noCourses.announcements.level, 'none');
  assert.equal(noCourses.assignments.level, 'none');
  assert.equal(noCourses.files.level, 'partial');
  const genericCourse = capabilities({ type: 'webpages', pages: [{ kind: 'course_materials', url: 'https://other.edu.tr/AIS/Student/Class/ClassDetail' }] });
  assert.equal(genericCourse.assignments.level, 'none');
  assert.equal(genericCourse.files.level, 'partial');

  const ogren = capabilities({ type: 'webpages', pages: PRESETS['bartin-ogreniyorum'].pages.map((page) => (typeof page === 'string' ? { url: page, kind: 'page' } : page)) });
  assert.equal(ogren.announcements.level, 'partial');
  assert.match(ogren.announcements.note, /bildirim/);
  assert.equal(ogren.assignments.level, 'full');
  assert.match(ogren.assignments.note, /son teslim/);
  assert.equal(ogren.exams.level, 'partial');
  assert.match(ogren.exams.note, /sınav dönemi/);
  assert.equal(ogren.grades.level, 'none', 'Öğreniyorum not sayfası sunmuyor');
  assert.match(ogren.grades.note, /Performansım/);
  assert.equal(ogren.files.level, 'partial', 'hazır şablon ders içerik sayfaları eklenmeden tam dosya takibi iddia etmez');
  const contentSite = capabilities({ type: 'webpages', pages: [{ kind: 'page', url: `${OGREN}?do=iceriklistele&konu=sample` }] });
  assert.equal(contentSite.files.level, 'full');
  assert.match(contentSite.files.note, /PDF içeriği indirilip karşılaştırılmaz/);
  assert.equal(contentSite.assignments.level, 'none');
  assert.equal(capabilities({ type: 'webpages', pages: [{ kind: 'page', url: `${OGREN}?do=derskonulistele&dersno=sample` }] }).files.level, 'partial', 'yalnızca ders konu listesi, PDF listesi takibi sayılmaz');
  const wrongRoute = capabilities({ type: 'webpages', pages: [{ kind: 'assignment', url: 'https://other.example/mooc/index.php?do=odevler' }] });
  assert.equal(wrongRoute.assignments.level, 'partial');

  // Aynı sitede yalnızca sayfa izleyen bir bağlantı hiçbir şey iddia etmez.
  const plain = capabilities({ type: 'webpages', pages: [{ kind: 'page', url: `${OGREN}?do=derskayitol` }] });
  for (const key of ['announcements', 'assignments', 'exams', 'grades']) assert.equal(plain[key].level, 'none', key);
});

test('ÜBYS matches an announced absence to the summary and reads statistics only from the selected term', async () => {
  const base = 'https://ubys.bartin.edu.tr';
  const page = { id: 'guz', url: base + '/AIS/Student/Class/Index', kind: 'grade', content_selector: '#Guz2026table', track_text: false };
  const index = '<table id="Guz2026table"><tr><th>Kod</th><th>Ders</th></tr>' +
    '<tr><td><a href="/AIS/Student/Class/ClassDetail?classId=abc" data-class-id="abc">D1</a></td><td>Ders</td></tr>' +
    '<tr><td><table><tr><td>Vize :</td><td>Girmedi</td></tr></table></td></tr></table>';
  const headers = ['Sınav Tipi', 'Sınav Adı', 'Sınav Notu', 'İlan Tarihi', 'Mazeret', 'Sınıf Ortalaması', 'Standart Sapma', 'Harf Notu Aralığı'];
  const term = (year, semester, score) => `<li class="y${year}"><div class="semester">${semester}</div><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>
    <tr>${['Ara Sınav', 'Vize', score, '20.11.2026 15:00', '0', '47,5', '6,5', '70–80'].map(v => `<td>${v}</td>`).join('')}</tr></tbody></table></li>`;
  const model = `<script>_jsm = JSON.parse(Base64.decode("${b64({ StudentClassInfo: { Homeworks: [{ Id: 123, Name: 'Ders çalışması' }] } })}"));</script>`;
  const detail = `${model}<ul class="course-details">${term(2025, 'Güz', '72')}${term(2026, 'Bahar', '80')}${term(2026, 'Güz', 'Girmedi')}</ul>`;
  const out = await webSnapshot({ pages: [page] }, { request: async url => ({ url, text: url === page.url ? index : detail }) });
  assert.deepEqual(out.errors, []);
  const [assignment] = out.items.filter(i => i.kind === 'assignment');
  assert.equal(assignment.title, 'Ders çalışması');
  assert.ok(out.complete.includes(assignment.scope));
  const rows = out.items.filter(i => i.scope.startsWith('exam-results/'));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(out.items.some(i => i.id === row.summaryId));
  assert.deepEqual(Object.values(row.fields), ['Ara Sınav', 'Vize', 'Girmedi', '20.11.2026 15:00', '0', '47,5', '6,5', '70–80']);
  const locked = model + '<ul class="course-details"><li class="y2026"><div class="semester">Güz</div><div class="success-status">Notlarınızı görebilmeniz için ankete katılmanız gerekmektedir.</div></li></ul>';
  const later = await webSnapshot({ pages: [page] }, { request: async url => ({ url, text: url === page.url ? index : locked }) });
  assert.deepEqual(later.errors, []);
  assert.equal(later.surveyByGrade[row.summaryId], true);
  assert.ok(!later.complete.includes(row.scope));
  const state = emptyState();
  mergeSnapshot(state, 'ubys', out, 1000);
  mergeSnapshot(state, 'ubys', later, 2000);
  assert.ok(state.platforms.ubys.items[row.id]);
  assert.ok(state.platforms.ubys.surveyGrades.includes(row.summaryId));
  mergeSnapshot(state, 'ubys', out, 3000);
  assert.deepEqual(state.platforms.ubys.surveyGrades, []);
  // A table first seen behind a survey must notify when a result becomes visible.
  const initiallyLocked = emptyState();
  mergeSnapshot(initiallyLocked, 'ubys', later, 1000);
  assert.deepEqual(initiallyLocked.pending, {});
  mergeSnapshot(initiallyLocked, 'ubys', out, 2000);
  mergeSnapshot(initiallyLocked, 'ubys', out, 3000);
  assert.deepEqual(Object.values(initiallyLocked.pending).map(change => change.item.id), [row.id]);
});

test('Bartın archives retain stable announcement links and migrate from the old page record silently', async () => {
  const url = 'https://fen.bartin.edu.tr/duyuru-arsiv.html';
  const page = { id: 'arsiv', url, kind: 'page' };
  const row = (date, title, href) => `<li class="list-group-item"><div class="col-2">${date}</div><div class="col-10"><a href="${href}">${title}</a></div></li>`;
  const html = (rows) => `<main><div class="content-area"><div class="col-lg-10"><ul class="list-group">${rows}</ul></div></div></main>`;
  const first = row('24/11/2026', 'Duyuru A', '/duyurular/a.html?token=ignored');
  const linked = row('23/11/2026', 'Duyuru B', 'https://oidb.bartin.edu.tr/duyurular/b.html');
  const unsafe = row('23/11/2026', 'Dış bağlantı', 'https://bartin.edu.tr.example.com/duyurular/b.html');
  const read = (body) => webSnapshot({ pages: [page] }, { request: async () => ({ url, text: body }) });
  const state = emptyState();
  mergeSnapshot(state, 'fen', { items: parsePage(html(first), url, page), complete: [page.id], errors: [] }, 1000);
  const snapshot = await read(html(first + linked + unsafe));
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.items.map(({ kind, url, fields }) => [kind, url, fields.Tarih]), [
    ['announcement', 'https://fen.bartin.edu.tr/duyurular/a.html', '24/11/2026'],
    ['announcement', 'https://oidb.bartin.edu.tr/duyurular/b.html', '23/11/2026'],
  ]);
  mergeSnapshot(state, 'fen', snapshot, 2000);
  assert.equal(Object.keys(state.platforms.fen.items).length, 2);
  assert.equal(Object.keys(state.pending).length, 0);
  const added = row('25/11/2026', 'Duyuru C', '/duyurular/c.html');
  mergeSnapshot(state, 'fen', await read(html(added + linked + first)), 3000);
  assert.deepEqual(Object.values(state.pending).map((change) => change.item.title), ['Duyuru C']);
  const missing = await read('<main>Arşive ulaşılamadı</main>');
  assert.deepEqual(missing.complete, []);
  assert.equal(missing.errors[0].code, 'site');
});

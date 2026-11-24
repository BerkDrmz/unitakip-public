import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, makeItem, mergeSnapshot, parseOgrenContent, webSnapshot } from '../src/core.js';
import { dashboard } from '../src/panel.js';

const base = 'https://ogreniyorum.net/mooc/';
const courseURL = base + 'index.php?do=derskonulistele&dersno=course-id';
const topicURL = base + 'index.php?do=iceriklistele&konu=topic-id';
const pdfURL = base + 'index.php?do=icerikpdf&konu=file+opaque%2Bvalue==';
const card = (title, href, count = '') => `<a href="${href}"><div class="menu-card"><div class="card-content"><h3>${title}</h3><p>${count}</p></div></div></a>`;
const content = (cards, heading = '') => `${heading ? `<h1>${heading}</h1>` : ''}<div class="content"><div class="menu-container">${cards}</div></div>`;
const courseHTML = content(card('Hafta 1 — Temel Kavramlar', topicURL, 'Geçirilen Süre: 1 saat'), 'BTS321 E-Ticaret');
const topicHTML = content(card('Ders İzlencesi', pdfURL));
const platform = { type: 'webpages', base_url: base, download_files: false, pages: [
  { id: 'course', kind: 'page', url: courseURL, content_selector: '.content' },
  { id: 'topic', kind: 'page', url: topicURL, content_selector: '.content' },
] };

test('content routes without file extensions appear as PDFs and topics with the right course, without fetching files', async () => {
  const requests = [];
  const snapshot = await webSnapshot(platform, { request: async (url) => {
    requests.push(url); return { url, text: url === courseURL ? courseHTML : topicHTML };
  } });
  assert.deepEqual(requests, [courseURL, topicURL]);
  assert.equal(snapshot.errors.length, 0);
  const materials = snapshot.items.filter((item) => item.kind === 'material');
  assert.equal(materials.length, 2);
  assert.ok(materials.every((item) => item.course === 'BTS321 E-Ticaret' && !item.files));
  const pdf = materials.find((item) => item.material.extension === 'pdf');
  assert.equal(pdf.material.url, pdfURL); // Preserve opaque +/%2B values exactly.
  const state = emptyState(); mergeSnapshot(state, 'ogreniyorum', snapshot, 1000);
  const projected = dashboard({ to: 'student@example.org', platforms: { ogreniyorum: platform } }, state);
  assert.equal(projected.materials.length, 2);
  assert.ok(projected.materials.some((m) => m.title === 'Ders İzlencesi' && m.url === pdfURL && m.extension === 'pdf'));
});

test('adding structured content to an already tracked page starts silently; later additions are notified', async () => {
  const state = emptyState();
  mergeSnapshot(state, 'ogreniyorum', { items: [makeItem('topic', 'text', 'page', 'Existing page')], complete: ['topic'], errors: [] }, 1000);
  const page = { id: 'topic', course_name: 'Ders' };
  const first = parseOgrenContent(topicHTML, topicURL, page);
  mergeSnapshot(state, 'ogreniyorum', { items: first, complete: ['learning/topic'], errors: [] }, 2000);
  assert.equal(Object.keys(state.pending).length, 0);
  const later = parseOgrenContent(content(card('Ders İzlencesi', pdfURL) + card('Yeni Sunum', base + 'index.php?do=icerikpdf&konu=new')), topicURL, page);
  mergeSnapshot(state, 'ogreniyorum', { items: later, complete: ['learning/topic'], errors: [] }, 3000);
  assert.equal(Object.keys(state.pending).length, 1);
  assert.equal(Object.values(state.pending)[0].item.title, 'Yeni Sunum');
  assert.equal(Object.keys(state.fileJobs).length, 0);
});

test('viewing counters do not change content records; unsafe and unrelated actions are excluded', () => {
  const first = parseOgrenContent(courseHTML, courseURL, { id: 'course' });
  const later = parseOgrenContent(courseHTML.replace('1 saat', '2 saat'), courseURL, { id: 'course' });
  assert.deepEqual(later, first);
  const html = content(card('File', pdfURL) + card('Other host', 'https://evil.example/index.php?do=icerikpdf&konu=x') +
    card('Logout', base + 'index.php?do=cikis&konu=x') + card('Unsupported', base + 'index.php?do=submit&konu=x') + card('Duplicate', pdfURL));
  assert.equal(parseOgrenContent(html, topicURL, { id: 'topic', course_name: 'Ders' }).length, 1);
});

test('a failed parent course keeps earlier course-labelled content instead of replacing it with empty course names', async () => {
  const state = emptyState();
  mergeSnapshot(state, 'ogreniyorum', { items: parseOgrenContent(topicHTML, topicURL, { id: 'topic', course_name: 'Ders' }), complete: ['learning/topic'], errors: [] }, 1000);
  const snapshot = await webSnapshot(platform, { request: async (url) => {
    if (url === courseURL) throw Error('temporarily unavailable');
    return { url, text: topicHTML };
  } });
  assert.ok(!snapshot.complete.includes('learning/topic'));
  assert.ok(snapshot.errors.length);
  mergeSnapshot(state, 'ogreniyorum', snapshot, 2000);
  assert.ok(Object.values(state.platforms.ogreniyorum.items).some(({ item }) => item.course === 'Ders'));
});

test('Öğreniyorum her yüklemede konu değerini yeniden şifreler: aynı materyal tekrar bildirilmez, eski kimlikler sessizce geçer', () => {
  const page = { id: 'topic', course_name: 'Ders' };
  const load = (salt) => content(card('Konu Özeti', `${base}index.php?do=icerikpdf&konu=A${salt}`) + card('Konu Özeti', `${base}index.php?do=icerikpdf&konu=B${salt}`) + card('Sunum', `${base}index.php?do=iceriklistele&konu=C${salt}`));
  const state = emptyState();
  // Eski sürümün bıraktığı kayıt: kimlik şifreli bağlantının özetiydi.
  state.platforms.ogreniyorum = { items: { 'learning/topic/material/abc123': { scope: 'learning/topic', fingerprint: 'x', item: { id: 'learning/topic/material/abc123', scope: 'learning/topic' } } },
    scopes: { 'learning/topic': 1 }, guards: {}, lastSuccess: 1, error: null };
  const first = parseOgrenContent(load('1'), topicURL, page), second = parseOgrenContent(load('2'), topicURL, page);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.equal(new Set(first.map((item) => item.id)).size, 3, 'aynı başlıklı iki özet ayrı kayıttır');
  assert.equal(mergeSnapshot(state, 'ogreniyorum', { items: first, complete: ['learning/topic'], errors: [] }, 2000), 0, 'kimlik geçişi bildirim üretmez');
  assert.equal(mergeSnapshot(state, 'ogreniyorum', { items: second, complete: ['learning/topic'], errors: [] }, 3000), 0, 'yeniden şifrelenen bağlantı bildirim üretmez');
  assert.equal(Object.keys(state.pending).length, 0);
  assert.ok(!state.platforms.ogreniyorum.items['learning/topic/material/abc123']);
});

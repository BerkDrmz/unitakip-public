import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOgrenAssignments, parsePage, webSnapshot, emptyState, mergeSnapshot } from '../src/core.js';

const url = 'https://ogreniyorum.net/mooc/index.php?do=odevler';
const page = { id: 'odevler', kind: 'assignment', content_selector: '.content', url };
const html = (rows) => `<div class="content"><table><thead><tr>${['#','Ders','Konu','Baslik','Aciklama','Son Teslim','Tarih','Dosya'].map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(([title, due = '20.11.2026 23:59', explanation = 'Örnek açıklama'], i) => `<tr><td>${i+1}</td><td>E-Ticaret</td><td>Hafta 3</td><td>${title}</td><td>${explanation}</td><td>${due}</td><td>13.11.2026</td><td></td></tr>`).join('') : '<tr><td colspan="8">Kayit bulunamadi.</td></tr>'}</tbody></table></div>`;
const snapshot = (body) => webSnapshot({ pages: [page] }, { request: async (target) => ({ url: target, text: body }) });

test('Öğreniyorum ödevleri gerçek sütunlarla ders/başlık/açıklama ve İstanbul teslim tarihine dönüşür; ek istek yoktur', async () => {
  let reads = 0;
  const result = await webSnapshot({ pages: [page] }, { request: async (target) => { reads++; return { url: target, text: html([['Ürün incelemesi']]) }; } });
  assert.equal(reads, 1); assert.deepEqual(result.errors, []);
  const [item] = result.items;
  assert.equal(item.kind, 'assignment'); assert.equal(item.course, 'E-Ticaret');
  assert.equal(item.title, 'Ürün incelemesi'); assert.equal(item.body, 'Örnek açıklama');
  assert.equal(item.dueAt, Date.parse('2026-11-20T20:59:00Z'));
  assert.ok(!Object.hasOwn(item.fields, '#'));
  const [unknown] = parseOgrenAssignments(html([['Saat yok', '20.11.2026']]), url, page);
  assert.equal(unknown.dueAt, null); assert.match(unknown.body, /Son teslim: 20.11.2026/);
});

test('Öğreniyorum boş ödev listesi sahte ödev üretmez; sonraki yeni ödev bildirilir, sıralama sessizdir ve tarih değişimi güncellemedir', async () => {
  const state = emptyState();
  const empty = await snapshot(html([]));
  assert.deepEqual(empty.items, []); assert.deepEqual(empty.complete, ['odevler']);
  mergeSnapshot(state, 'ogreniyorum', empty, 1000);
  mergeSnapshot(state, 'ogreniyorum', await snapshot(html([['İlk ödev'], ['İkinci ödev']])), 2000);
  assert.equal(Object.values(state.pending).filter((c) => c.item.kind === 'assignment').length, 2);
  state.pending = {};
  assert.equal(mergeSnapshot(state, 'ogreniyorum', await snapshot(html([['İkinci ödev'], ['İlk ödev']])), 3000), 0);
  assert.equal(mergeSnapshot(state, 'ogreniyorum', await snapshot(html([['İkinci ödev'], ['İlk ödev', '21.11.2026 23:59']])), 4000), 1);
  assert.equal(Object.values(state.pending)[0].type, 'updated');
  assert.equal(Object.values(state.pending)[0].item.title, 'İlk ödev');
});

test('Öğreniyorum ödev biçimi geçişi sessizdir; tanınmayan sayfa eski ödevleri silmez', async () => {
  const state = emptyState(), body = html([['Mevcut ödev']]);
  mergeSnapshot(state, 'ogreniyorum', { items: parsePage(body, url, page), complete: [page.id], errors: [] }, 1000);
  assert.equal(mergeSnapshot(state, 'ogreniyorum', await snapshot(body), 2000), 0);
  assert.equal(Object.keys(state.pending).length, 0);
  assert.equal(Object.values(state.platforms.ogreniyorum.items)[0].item.title, 'Mevcut ödev');
  const broken = await snapshot('<div class="content"><table><thead><tr><th>Farklı sayfa</th></tr></thead></table></div>');
  assert.deepEqual(broken.complete, []); assert.deepEqual(broken.errors, [{ scope: page.id, code: 'site' }]);
  mergeSnapshot(state, 'ogreniyorum', broken, 3000);
  assert.equal(Object.values(state.platforms.ogreniyorum.items)[0].item.title, 'Mevcut ödev');
});

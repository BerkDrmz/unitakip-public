import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { emptyState, usageStatus, ROWS_WRITTEN_LIMIT } from '../src/core.js';
import { status } from '../src/runtime.js';

// Gerçek SQLite Durable Object: Store'un kaydettiği sayı, Cloudflare'ın her sorgu için ölçtüğü rowsWritten toplamına eşit olmalı.
async function run() {
  const storePath = new URL('../src/store.js', import.meta.url).pathname;
  const corePath = new URL('../src/core.js', import.meta.url).pathname;
  const source = `
    import { Store } from ${JSON.stringify(storePath)};
    import { emptyState } from ${JSON.stringify(corePath)};
    function measured(storage) {
      const cursors = [];
      const sql = { exec: (...args) => { const cursor = storage.sql.exec(...args); cursors.push(cursor); return cursor; }, get databaseSize() { return storage.sql.databaseSize; } };
      return { storage: { sql, transactionSync: (fn) => storage.transactionSync(fn) }, total: () => cursors.reduce((sum, c) => sum + c.rowsWritten, 0), reset: () => { cursors.length = 0; } };
    }
    export class TestStore {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
      async fetch(request) {
        const which = new URL(request.url).pathname;
        if (which === '/days') {
          const store = new Store(this.ctx.storage, this.env.STATE_KEY), day = Date.parse('2026-01-01T12:00:00Z');
          const fresh = store.usage(day);
          this.ctx.storage.transactionSync(() => { store.count(5, day); store.count(2, day + 3600000); });
          const sameDay = store.usage(day);
          this.ctx.storage.transactionSync(() => store.count(7, day + 86400000));
          return Response.json({ fresh, sameDay, nextDay: store.usage(day + 86400000), twoDaysLater: store.usage(day + 2 * 86400000), threeDaysLater: store.usage(day + 3 * 86400000) });
        }
        const probe = measured(this.ctx.storage), store = new Store(probe.storage, this.env.STATE_KEY);
        probe.reset(); // tablo oluşturma bir kerelik; sayaç yalnızca kayıt yazımlarını tutar
        const steps = {}, check = (name) => { steps[name] = { truth: probe.total(), counted: store.usage().rowsWritten }; };
        const state = emptyState(); await store.save(state); check('first');
        await store.save(structuredClone(state)); check('identical');
        await store.save({ ...state, sequence: 1 }); check('changed');
        await store.save({ ...state, sequence: 2, big: 'x'.repeat(700000) }); check('multipart');
        await store.save({ ...state, sequence: 3 }); check('shrunk');
        await store.archive('k1', new Uint8Array(1000)); check('archive');
        const reopened = new Store(probe.storage, this.env.STATE_KEY); await reopened.load();
        await reopened.save({ ...state, sequence: 4 }); check('reopened');
        return Response.json({ steps, usage: store.usage() });
      }
    }
    export default { fetch(request, env) { return env.TEST.getByName(new URL(request.url).pathname).fetch(request); } };
  `;
  const result = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'storage-usage-test.js' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: result.outputFiles[0].text,
    compatibilityDate: '2026-11-01', bindings: { STATE_KEY: btoa('k'.repeat(32)) },
    durableObjects: { TEST: { className: 'TestStore', useSQLite: true } } }));
  try {
    const writes = await (await mf.dispatchFetch('https://test/writes')).json();
    const days = await (await mf.dispatchFetch('https://test/days')).json();
    return { writes, days };
  } finally { await mf.dispose(); }
}

test('stored row counter equals the rowsWritten Cloudflare measured for every query, including its own upsert', async () => {
  const { writes: { steps, usage } } = await run();
  for (const [name, { truth, counted }] of Object.entries(steps)) assert.equal(counted, truth, `${name}: sayılan ${counted}, ölçülen ${truth}`);
  assert.ok(steps.first.counted > 0);
  assert.equal(steps.identical.counted, steps.first.counted);          // özdeş kayıt yazılmaz, sayaç artmaz
  assert.ok(steps.multipart.counted - steps.changed.counted > steps.changed.counted - steps.first.counted); // iki parçalı kayıt daha pahalı
  assert.ok(steps.archive.counted > steps.shrunk.counted);              // dosya arşivi de sayılır
  assert.ok(steps.reopened.counted > steps.archive.counted);            // yeni Store örneği aynı sayaca ekler
  assert.ok(usage.databaseSize > 0);
});

test('day change moves today\'s total to yesterday and starts from zero', async () => {
  const { days } = await run();
  assert.deepEqual({ ...days.fresh, databaseSize: 0 }, { rowsWritten: 0, yesterdayRows: null, databaseSize: 0 });
  assert.equal(days.sameDay.rowsWritten, 9);                            // (5 + 1) + (2 + 1): her upsert kendi satırını da sayar
  assert.equal(days.nextDay.rowsWritten, 8); assert.equal(days.nextDay.yesterdayRows, 9);
  assert.equal(days.twoDaysLater.rowsWritten, 0); assert.equal(days.twoDaysLater.yesterdayRows, 8);
  assert.equal(days.threeDaysLater.rowsWritten, 0); assert.equal(days.threeDaysLater.yesterdayRows, null);
});

test('status exposes measured storage usage, and stays valid for stores without a counter', () => {
  const state = emptyState();
  const measured = status(state, { usage: () => ({ rowsWritten: 1234, yesterdayRows: 5678, databaseSize: 4096 }) }).usage;
  assert.deepEqual([measured.rowsWritten, measured.yesterdayRows, measured.rowsLimit, measured.databaseSize], [1234, 5678, ROWS_WRITTEN_LIMIT, 4096]);
  const plain = status(state, { load: async () => state, save: async () => {} }).usage;
  assert.equal(plain.rowsWritten, null); assert.equal(plain.databaseSize, null);
  assert.equal(usageStatus(state).rowsLimit, 100000);
});

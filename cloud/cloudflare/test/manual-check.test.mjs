import test from 'node:test';
import assert from 'node:assert/strict';
import { SiteClient } from '../src/http.js';
import { emptyState } from '../src/core.js';
import { tick } from '../src/runtime.js';
import { dashboard } from '../src/panel.js';

test('request pacing: defaults to 1.5 seconds, manual minimum is one second, and no unbounded burst is allowed', async () => {
  const starts = async (minIntervalMs) => {
    let clock = Date.now(); const start = clock, times = [];
    const client = new SiteClient({ base_url: 'https://uni.edu.tr/' }, { minIntervalMs, clock: () => clock,
      pause: async (delay) => { clock += delay; }, fetcher: async () => { times.push(clock - start); return new Response('ok'); } });
    for (let i = 0; i < 3; i++) await client.request('https://uni.edu.tr/');
    return times;
  };
  assert.deepEqual(await starts(), [0, 1500, 3000]);
  assert.deepEqual(await starts(1000), [0, 1000, 2000]);
  assert.deepEqual(await starts(0), [0, 1000, 2000]);
});

test('manual and background scans use the selected pacing, report real progress, and persist the same checkpoints', async () => {
  const run = async (manual) => {
    const state = emptyState(), progress = [], starts = []; let clock = Date.now(), saves = 0;
    Object.assign(state, { armed: true, nextFullAt: 0, lastDailySummary: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(clock) });
    if (manual) state.manualRequestedAt = clock;
    const config = { platforms: Object.fromEntries(['a', 'b'].map((id) => [id, { type: 'webpages', base_url: `https://${id}.uni.edu.tr/`,
      pages: [0, 1].map((i) => ({ id: `p${i}`, url: `https://${id}.uni.edu.tr/p${i}` })) }])) };
    let current = state;
    await tick(config, { load: async () => current, save: async (s) => { saves++; current = s; } }, () => { throw Error('unexpected SMTP'); }, {
      clock: () => clock, pause: async (delay) => { clock += delay; },
      fetcher: async () => { starts.push(clock); return new Response('<main>Örnek</main>'); }, onProgress: (p) => progress.push(p),
    });
    assert.deepEqual(progress.map((p) => [p.current, p.completed, p.total]), [['a', 0, 2], [null, 1, 2], ['b', 1, 2], [null, 2, 2]]);
    assert.equal(current.manualRequestedAt, null);
    assert.equal(current.usage.requests, 4);
    return { gap: starts[1] - starts[0], saves, config, state: current };
  };
  const manual = await run(true), background = await run(false);
  assert.equal(manual.gap, 1000); assert.equal(background.gap, 1500);
  assert.equal(manual.saves, background.saves);
  const progress = { startedAt: Date.now(), full: true, completed: 1, total: 2, current: 'b', token: 'private-secret' };
  const view = dashboard(manual.config, manual.state, { checking: true, checkProgress: progress });
  assert.equal(view.checkProgress.current, 'b');
  assert.equal(view.checkProgress.completed, 1);
  assert.ok(!JSON.stringify(view.checkProgress).includes('private-secret'));
  assert.equal(dashboard(manual.config, manual.state, { checking: false, checkProgress: progress }).checkProgress, null);
});

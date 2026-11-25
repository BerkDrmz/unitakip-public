import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classroomConsent, classroomSnapshot, exchangeClassroomCode, validClassroomCallback } from '../src/classroom.js';
import { dashboard } from '../src/panel.js';
import { ensureSites, effectiveSites, saveSite } from '../src/sites.js';
import { emptyState, mergeSnapshot } from '../src/core.js';

const oauth = { id: 'synthetic-client', secret: 'synthetic-secret' };
const origin = 'https://panel.ornek.edu.tr';
const consentFor = () => classroomConsent(oauth, origin, 'classroom', { id: 'session-id', expiry: 10000 }, 1000);

test('a Classroom API rejection refreshes once and retries with the current token', async () => {
  const platform = { oauth, connection: { refreshToken: 'synthetic-refresh' } };
  let refreshes = 0;
  const reads = [];
  const result = await classroomSnapshot(platform, { fetcher: async (url, options) => {
    if (new URL(url).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'access-' + ++refreshes });
    reads.push(options.headers.Authorization);
    return reads.length === 1 ? Response.json({}, { status: 401 }) : Response.json({ courses: [] });
  } });
  assert.deepEqual(reads, ['Bearer access-1', 'Bearer access-2']);
  assert.deepEqual(result.complete, ['classroom/courses']);
});

test('Google consent uses offline read-only permissions, PKCE and a time-limited browser binding', async () => {
  const consent = await consentFor();
  const url = new URL(consent.url);
  const query = url.searchParams;
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(query.get('access_type'), 'offline');
  assert.equal(query.get('redirect_uri'), origin + '/oauth/classroom/callback');
  assert.equal(query.get('code_challenge_method'), 'S256');
  assert.notEqual(consent.pending.verifier, query.get('code_challenge'));
  assert.deepEqual(query.get('scope').split(' ').map((scope) => scope.split('/').at(-1)), [
    'openid', 'classroom.courses.readonly', 'classroom.coursework.me.readonly', 'classroom.announcements.readonly',
  ]);
  assert.match(consent.cookie, /Secure; HttpOnly; SameSite=Lax/);
  const callback = origin + '/oauth/classroom/callback?state=' + query.get('state');
  const headers = { Cookie: consent.cookie.split(';')[0] };
  assert.equal(validClassroomCallback(new Request(callback, { headers }), consent.pending, 2000), true);
  assert.equal(validClassroomCallback(new Request(callback), consent.pending, 2000), false);
  assert.equal(validClassroomCallback(new Request(callback + 'x', { headers }), consent.pending, 2000), false);
  assert.equal(validClassroomCallback(new Request(callback, { headers }), consent.pending, 11000), false);
});

test('the code exchange checks all required Classroom scopes and keeps the Google subject and refresh token', async () => {
  const consent = await consentFor();
  const requests = [];
  const google = async (url, init) => {
    requests.push(String(url));
    if (new URL(url).hostname === 'oauth2.googleapis.com') {
      assert.equal(init.body.get('grant_type'), 'authorization_code');
      assert.equal(init.body.get('code_verifier'), consent.pending.verifier);
      assert.equal(init.body.get('code'), 'synthetic-code');
      return Response.json({ access_token: 'temporary', refresh_token: 'offline',
        scope: new URL(consent.url).searchParams.get('scope') });
    }
    assert.equal(init.headers.Authorization, 'Bearer temporary');
    return Response.json({ sub: 'example-account' });
  };
  assert.deepEqual(await exchangeClassroomCode(oauth, consent.pending, 'synthetic-code', { fetcher: google }), {
    account: 'example-account', refreshToken: 'offline', clientId: oauth.id,
  });
  assert.equal(requests.length, 2);
  await assert.rejects(exchangeClassroomCode(oauth, consent.pending, 'synthetic-code', {
    fetcher: async () => Response.json({ refresh_token: 'offline', access_token: 'temporary', scope: 'openid' }),
  }), { code: 'classroom_policy' });
});

test('an existing Classroom URL becomes a Google connection and only courses, published work and announcements are read', async () => {
  const state = emptyState(), cfg = { platforms: {}, classroomOAuth: oauth };
  state.sites = [{ id: 'existing', type: 'webpages', name: 'Eski Classroom', base_url: 'https://classroom.google.com/u/0/h', origin: 'panel', pages: [] }];
  ensureSites(state, cfg);
  const missing = dashboard(cfg, state).sites[0];
  assert.equal(missing.id, 'existing');
  assert.equal(missing.type, 'classroom');
  assert.equal(missing.login, 'missing');
  assert.equal(dashboard({ platforms: {} }, state).sites[0].error, 'classroom_setup');
  assert.throws(() => saveSite(state, { base_url: 'classroom.google.com' }), /zaten ekli/);
  state.platforms.existing = { items: {}, scopes: {}, guards: {}, classroom: { clientId: oauth.id, account: 'synthetic-user', refreshToken: 'offline' } };
  const platform = effectiveSites(state, cfg).active.existing;
  let updated = false;
  const budget = { used: 0, limit: 44 };
  const fetcher = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'oauth2.googleapis.com') {
      assert.equal(init.body.get('grant_type'), 'refresh_token');
      return Response.json({ access_token: 'temporary' });
    }
    assert.equal(init.method, undefined);
    assert.equal(init.headers.Authorization, 'Bearer temporary');
    if (parsed.pathname === '/v1/courses') {
      assert.equal(parsed.searchParams.get('studentId'), 'me');
      return Response.json({ courses: [{ id: '42', name: 'Örnek ders', alternateLink: 'https://classroom.google.com/c/42' }] });
    }
    if (parsed.pathname === '/v1/courses/42/courseWork') {
      if (!parsed.searchParams.has('pageToken')) return Response.json({ courseWork: [{ id: '1', title: 'Ödev', dueDate: { year: 2026, month: 11, day: 25 },
        dueTime: { hours: 17 }, alternateLink: 'https://classroom.google.com/c/42/a/1/details' }], nextPageToken: 'next' });
      return Response.json(updated ? { courseWork: [{ id: '2', title: 'Yeni ödev' }] } : {});
    }
    assert.equal(parsed.pathname, '/v1/courses/42/announcements');
    return Response.json({ announcements: [{ id: '1', text: 'Ders duyurusu', creationTime: '2026-11-24T17:00:00Z' }] });
  };
  const first = await classroomSnapshot(platform, { fetcher, budget });
  assert.equal(budget.used, 5);
  assert.equal(first.items[0].dueAt, Date.UTC(2026, 10, 25, 17));
  mergeSnapshot(state, 'existing', first, 1000);
  assert.equal(Object.keys(state.pending).length, 0);
  updated = true;
  mergeSnapshot(state, 'existing', await classroomSnapshot(platform, { fetcher, budget }), 2000);
  assert.deepEqual(Object.values(state.pending).map((change) => change.item.title), ['Yeni ödev']);
  const view = dashboard(cfg, state);
  assert.equal(view.sites[0].announcements[0].title, 'Ders duyurusu');
  assert.equal(view.tasks.length, 2);
  assert.ok(!JSON.stringify(view).includes('offline') && !JSON.stringify(view).includes('synthetic-user'));
  await assert.rejects(classroomSnapshot(platform, { fetcher, budget: { used: 0, limit: 1 } }), { code: 'quota' });
  await assert.rejects(classroomSnapshot(platform, { fetcher: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) }), { code: 'auth' });
});

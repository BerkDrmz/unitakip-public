import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the Apps Script template checks the complete Classroom lists and installs a single hourly trigger', async () => {
  const raw = await readFile(new URL('../ui/src/classroom-script/Code.gs', import.meta.url), 'utf8');
  const setup = await readFile(new URL('../ui/src/classroom-script/Setup.gs', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../ui/src/classroom-script/appsscript.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [{ userSymbol: 'Classroom', version: 'v1', serviceId: 'classroom' }]);
  assert.equal(manifest.oauthScopes.filter((scope) => scope.includes('classroom.')).length, 3);
  assert.ok(manifest.oauthScopes.filter((scope) => scope.includes('classroom.')).every((scope) => scope.endsWith('.readonly')));
  const settings = new Map(), sends = [], triggers = [];
  const secret = 'fixture-local-token';
  const url = 'https://panel.example.com/sync/classroom/test';
  const executable = raw.replace('__UNITAKIP_SCRIPT_CONFIG__', JSON.stringify({ url, token: secret, revision: 'fixture-v1' }));
  let permissionGranted = false, acceptsSnapshot = false;
  const app = {
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    PropertiesService: { getUserProperties: () => ({ getProperty: (k) => settings.get(k), setProperty: (k, v) => settings.set(k, v) }) },
    Utilities: { getUuid: () => '11111111-1111-4111-8111-111111111111', newBlob: (s) => ({ getBytes: () => Buffer.from(s) }) },
    Classroom: { Courses: {
      list: ({ pageToken }) => pageToken ? { courses: [{ id: '2', name: 'Örnek iki' }] }
        : { courses: [{ id: '1', name: 'Örnek bir' }], nextPageToken: 'next' },
      CourseWork: { list: (id) => ({ courseWork: [{ id, title: 'Alıştırma' }] }) },
      Announcements: { list: () => ({ announcements: [] }) },
    } },
    UrlFetchApp: { fetch: (address, options) => {
      assert.equal(address, url);
      assert.equal(options.headers.Authorization, 'Bearer ' + secret);
      assert.equal(options.followRedirects, false);
      assert.ok(!options.payload.includes(secret));
      if (!acceptsSnapshot) return { getResponseCode: () => 401, getContentText: () => '{}' };
      sends.push(JSON.parse(options.payload));
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    } },
    ScriptApp: {
      AuthMode: { FULL: 'FULL' },
      requireAllScopes: (mode) => {
        assert.equal(mode, 'FULL');
        if (!permissionGranted) throw new Error('Google authorization requested');
      },
      getProjectTriggers: () => triggers.map((name) => ({ getHandlerFunction: () => name })),
      newTrigger: (name) => ({ timeBased: () => ({ everyHours: (hours) => {
        assert.equal(hours, 1);
        return { create: () => triggers.push(name) };
      } }) }),
    },
    HtmlService: { createHtmlOutput: (html) => ({ setTitle: () => html }) },
  };
  const context = vm.createContext(app);
  vm.runInContext(executable + '\n' + setup, context);
  const open = () => vm.runInContext('doGet()', context);
  assert.throws(open, /Google authorization requested/);
  assert.equal(sends.length, 0);
  permissionGranted = true;
  assert.match(open(), /kurulumu tamamlanamadı/);
  assert.equal(triggers.length, 0);
  acceptsSnapshot = true;
  assert.match(open(), /İlk Classroom aktarımı tamamlandı/);
  assert.match(open(), /İlk Classroom aktarımı tamamlandı/);
  assert.deepEqual(triggers, ['syncUniTakip']);
  assert.equal(sends.length, 1);
  vm.runInContext('startUniTakip()', context);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].courses.map((course) => course.id), ['1', '2']);
  assert.equal(sends[0].source, sends[1].source);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClassroom } from '../install-classroom.mjs';

const origin = 'https://unitakip.example.workers.dev';
const id = 'google-classroom';
const editor = 'https://script.google.com/d/synthetic_google_script_123/edit';
const deploymentId = 'synthetic_google_deployment_123';
const setupUrl = `https://script.google.com/macros/s/${deploymentId}/exec`;
const token = 'A'.repeat(43) + '.' + 'B'.repeat(43);

test('automatic setup creates and uploads a private Apps Script project, then safely resumes on retry', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'unitakip classroom '));
  let site, uploaded = false, deployment, deploymentBlocked = false, openCount = 0;
  const calls = [], api = [];
  const admin = 'local-test-credential-'.repeat(2);
  const messages = [];
  try {
    await writeFile(join(folder, 'deployment.json'), JSON.stringify({ url: origin }));
    await writeFile(join(folder, 'secrets.json'), JSON.stringify({ ADMIN_TOKEN: admin }));
    const fetcher = async (url, options) => {
      assert.equal(url.origin, origin);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer ' + admin);
      api.push(url.pathname);
      if (url.pathname === '/api/dashboard') return Response.json({ liveEnabled: true, armed: true, sites: site ? [site] : [] });
      if (url.pathname === '/api/sites/save') {
        assert.equal(JSON.parse(options.body).base_url, 'https://classroom.google.com/');
        site = { id, hostname: 'classroom.google.com', classroomScriptConfigured: false };
        return Response.json({ site: id });
      }
      assert.equal(url.pathname, '/api/sites/classroom-script');
      assert.deepEqual(JSON.parse(options.body), { id, replace: false });
      site.classroomScriptConfigured = true;
      return Response.json({ url: origin + '/sync/classroom/' + id, token });
    };
    const clasp = async (cwd, auth, [action, ...args], options) => {
      assert.equal(auth, join(cwd, '.clasprc.json'));
      calls.push(action);
      if (action === 'login') await writeFile(auth, '{}');
      if (action === 'create-script') {
        assert.deepEqual(args, ['--type', 'standalone', '--title', 'UniTakip Classroom', '--rootDir', 'source']);
        await writeFile(join(cwd, '.clasp.json'), JSON.stringify({ scriptId: 'synthetic_google_script_123', rootDir: 'source' }));
      }
      if (action === 'push') {
        assert.deepEqual(args, ['--force']);
        const code = await readFile(join(cwd, 'source', 'Code.gs'), 'utf8');
        assert.ok(code.includes('function startUniTakip()'));
        assert.ok(code.includes(token));
        assert.ok(!code.includes(admin) && !code.includes('__UNITAKIP_SCRIPT_CONFIG__'));
        const manifest = JSON.parse(await readFile(join(cwd, 'source', 'appsscript.json'), 'utf8'));
        assert.equal(manifest.dependencies.enabledAdvancedServices[0].serviceId, 'classroom');
        assert.deepEqual(manifest.webapp, { access: 'MYSELF', executeAs: 'USER_ACCESSING' });
        assert.deepEqual(manifest.urlFetchWhitelist, [origin + '/sync/classroom/' + id]);
        assert.match(await readFile(join(cwd, 'source', 'Setup.gs'), 'utf8'), /function doGet\(\)/);
        if (!uploaded) {
          uploaded = true;
          throw new Error('temporary error');
        }
      }
      if (action === 'list-deployments') {
        assert.deepEqual(options, { json: true });
        if (deploymentBlocked) throw new Error('Google deployment blocked');
        return deployment ? [deployment] : [];
      }
      if (action === 'create-deployment') {
        assert.deepEqual(options, { json: true });
        assert.equal(args[0], '--description');
        assert.match(args[1], /^UniTakip Classroom kurulumu [a-f0-9]{20}$/);
        deployment = { deploymentId, description: args[1] };
        return deployment;
      }
      if (action === 'open-web-app') {
        assert.deepEqual(args, [deploymentId]);
        assert.deepEqual(options, { quiet: true });
        if (++openCount === 1) throw new Error('Deployment is not visible yet');
      }
    };
    const options = { folder, fetcher, clasp, log: (line) => messages.push(line), pause: async (delay) => assert.equal(delay, 1000) };
    await assert.rejects(installClassroom(options), /temporary error/);
    assert.equal(await installClassroom(options), setupUrl);
    assert.equal(await installClassroom(options), setupUrl);
    deploymentBlocked = true;
    assert.equal(await installClassroom(options), editor);
    site = { ...site, classroomSyncAt: 1, login: 'ok' };
    assert.equal(await installClassroom(options), origin + '/#/siteler');
    assert.deepEqual(calls, ['login', 'create-script', 'push', 'push', 'list-deployments', 'create-deployment', 'open-web-app', 'open-web-app',
      'push', 'list-deployments', 'open-web-app', 'push', 'list-deployments', 'open-script']);
    assert.deepEqual(api, ['/api/dashboard', '/api/sites/save', '/api/sites/classroom-script', '/api/dashboard',
      '/api/dashboard', '/api/dashboard', '/api/dashboard']);
    assert.ok(messages.every((line) => !line.includes(token) && !line.includes(admin)));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('an invalid saved Worker address is rejected before reading the Google project or contacting a host', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'unitakip classroom invalid '));
  try {
    await writeFile(join(folder, 'deployment.json'), JSON.stringify({ url: 'https://outside.example/?secret=test' }));
    await assert.rejects(installClassroom({ folder, fetcher: () => assert.fail('unexpected network request') }), /HTTPS workers.dev/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

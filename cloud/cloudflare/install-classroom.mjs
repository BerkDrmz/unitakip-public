import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataFolder = fileURLToPath(new URL('../../data/cloudflare/', import.meta.url));
const template = new URL('./ui/src/classroom-script/', import.meta.url);
const settingsLink = 'https://script.google.com/home/usersettings';
const claspPackage = '@google/clasp@3.4.1';
const setupDeploymentPrefix = 'UniTakip Classroom kurulumu ';
const validId = (id) => typeof id === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(id);
const validDeployment = (id) => typeof id === 'string' && /^[\w-]{20,150}$/.test(id);
const classroomHost = 'classroom.google.com';
const missingSetup = 'Önce README’deki Cloudflare kurulumunu tamamla. smtp-check komutu panel adresini yerelde kaydeder.';

async function optionalJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function workerOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(missingSetup); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') ||
      url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Kurulum kayıtlı bir HTTPS workers.dev panel adresi gerektiriyor.');
  }
  return url.origin;
}

function panelClient(origin, adminToken, fetcher) {
  return async (name, payload) => {
    for (const delay of [0, 2500, 7500, 15000]) {
      if (delay) await new Promise((done) => setTimeout(done, delay));
      const response = await fetcher(new URL('/api/' + name, origin), {
        headers: { Authorization: `Bearer ${adminToken}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(20000),
      });
      if (response.status === 401) throw new Error('Yerel yönetim anahtarı panelle eşleşmiyor. Cloudflare kurulumunu kontrol et.');
      const result = await response.json();
      if (response.ok) return result;
      if (result.error === 'busy') continue;
      if (result.error === 'classroom_already_paired') {
        throw new Error('Classroom zaten eşleştirilmiş. Bilerek değiştireceksen komutu -- --replace ile çalıştır.');
      }
      if (result.error === 'not_found') throw new Error('Bu Worker sürümünde otomatik Classroom kurulumu bulunmuyor. UniTakip Worker’ını güncelle.');
      if (result.error === 'config' && typeof result.message === 'string') throw new Error(result.message);
      throw new Error(`UniTakip kurulum isteğini kabul etmedi (HTTP ${response.status}).`);
    }
    throw new Error('UniTakip şu anda tarama yapıyor. Biraz sonra aynı komutu yeniden çalıştır.');
  };
}

function runClasp(cwd, authFile, args, { json = false, quiet = false } = {}) {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Komutu npm üzerinden çalıştır: npm --prefix cloud/cloudflare run classroom:setup');
  // Invoke npm's JS entry point directly. This works on Windows without spawning npm.cmd through a shell.
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [npm, 'exec', '--yes', '--package', claspPackage, '--', 'clasp', '--auth', authFile, ...(json ? ['--json'] : []), ...args], {
      cwd, stdio: ['inherit', json ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit'], windowsHide: true,
    });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (text) => { output += text; });
    child.stderr?.resume();
    child.once('error', fail);
    child.once('close', (status) => {
      if (status !== 0) return fail(new Error('Google Apps Script işlemi tamamlanamadı.'));
      try { done(json ? JSON.parse(output) : undefined); } catch (error) { fail(error); }
    });
  });
}

async function deployPrivateSetup(clasp, directory, auth, description) {
  const json = { json: true };
  const deployments = await clasp(directory, auth, ['list-deployments'], json);
  const existing = deployments.filter((deployment) => validDeployment(deployment.deploymentId) &&
    deployment.description?.startsWith(setupDeploymentPrefix));
  const same = existing.find((deployment) => deployment.description === description);
  if (same) return same.deploymentId;
  const previous = existing[0]?.deploymentId;
  const created = await clasp(directory, auth, ['create-deployment', '--description', description,
    ...(previous ? ['--deploymentId', previous] : [])], json);
  if (!validDeployment(created.deploymentId)) throw new Error('Google kurulum bağlantısı doğrulanamadı.');
  return created.deploymentId;
}

async function openPrivateSetup(clasp, directory, auth, deployment, pause) {
  // A newly created deployment can take a moment to become visible to Google's read API.
  for (const delay of [0, 1000, 2500, 5000, 8000, 12000]) {
    if (delay) await pause(delay);
    try {
      await clasp(directory, auth, ['open-web-app', deployment], { quiet: true });
      return;
    } catch (error) {
      if (delay === 12000) throw error;
    }
  }
}

export async function installClassroom({ folder = dataFolder, fetcher = fetch, clasp = runClasp, log = console.log,
  replace = false, pause = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const deployment = await optionalJSON(join(folder, 'deployment.json'));
  const origin = workerOrigin(deployment?.url);
  const local = await optionalJSON(join(folder, 'secrets.json'));
  if (typeof local?.ADMIN_TOKEN !== 'string' || local.ADMIN_TOKEN.length < 32) throw new Error(missingSetup);

  const panel = panelClient(origin, local.ADMIN_TOKEN, fetcher);
  const dashboard = await panel('dashboard');
  if (!dashboard.liveEnabled || !dashboard.armed) throw new Error('Önce UniTakip’te takibi başlat.');
  const classroom = dashboard.sites.find((site) => site.hostname === classroomHost);
  if (classroom?.paused) throw new Error('Önce UniTakip’te Classroom kartından takibi sürdür.');
  if (classroom?.classroomSyncAt && classroom.login === 'ok' && !classroom.error && !replace) {
    const url = origin + '/#/siteler';
    log(`Classroom aktarımı zaten çalışıyor.\n${url}`);
    return url;
  }

  const directory = resolve(folder, 'classroom-script', new URL(origin).hostname);
  const source = join(directory, 'source');
  const auth = join(directory, '.clasprc.json');
  const project = join(directory, '.clasp.json');
  const pairing = join(directory, 'pairing.json');
  const existing = await optionalJSON(pairing);
  const reusable = !replace && existing?.id === classroom?.id && validId(existing?.id) && classroom?.classroomScriptConfigured;
  if (classroom?.classroomScriptConfigured && !reusable && !replace) {
    throw new Error('Classroom zaten eşleştirilmiş. Bilerek değiştireceksen komutu -- --replace ile çalıştır.');
  }

  await mkdir(source, { mode: 0o700, recursive: true });
  if (!await optionalJSON(auth)) {
    log('Tarayıcıda Classroom derslerini gördüğün Google hesabını seç.');
    await clasp(directory, auth, ['login']);
  }
  if (!await optionalJSON(project)) {
    try {
      await clasp(directory, auth, ['create-script', '--type', 'standalone', '--title', 'UniTakip Classroom', '--rootDir', 'source']);
    } catch {
      throw new Error(`Google projeyi oluşturamadı. Google Apps Script API ayarı kapalıysa ${settingsLink} adresinden bir kez açıp aynı komutu çalıştır.`);
    }
  }
  const { scriptId, rootDir } = await optionalJSON(project) || {};
  if (typeof scriptId !== 'string' || !/^[\w-]{20,150}$/.test(scriptId) || resolve(directory, rootDir || '.') !== source) {
    throw new Error('Yerel Apps Script proje kaydı doğrulanamadı.');
  }
  const editor = `https://script.google.com/d/${scriptId}/edit`;

  const id = classroom?.id || (await panel('sites/save', { base_url: 'https://classroom.google.com/' })).site;
  if (!validId(id)) throw new Error('UniTakip’teki Classroom kaydı doğrulanamadı.');
  const expected = `${origin}/sync/classroom/${id}`;
  const connection = reusable ? existing : await panel('sites/classroom-script', { id, replace });
  if (connection.url !== expected || !/^[\w-]{43}\.[\w-]{43}$/.test(connection.token || '')) {
    throw new Error('UniTakip’ten alınan aktarım bilgisi doğrulanamadı.');
  }
  await writeFile(pairing, JSON.stringify({ id, url: connection.url, token: connection.token }), { mode: 0o600 });
  const [code, setupPage, manifest] = await Promise.all(['Code.gs', 'Setup.gs', 'appsscript.json'].map((name) => readFile(new URL(name, template), 'utf8')));
  const revision = createHash('sha256').update(connection.token).digest('hex');
  const sourceCode = code.replace('__UNITAKIP_SCRIPT_CONFIG__', JSON.stringify({ url: expected, token: connection.token, revision }));
  const privateManifest = JSON.stringify({ ...JSON.parse(manifest), urlFetchWhitelist: [expected],
    webapp: { access: 'MYSELF', executeAs: 'USER_ACCESSING' } }, null, 2);
  await Promise.all([
    writeFile(join(source, 'Code.gs'), sourceCode, { mode: 0o600 }),
    writeFile(join(source, 'Setup.gs'), setupPage),
    writeFile(join(source, 'appsscript.json'), privateManifest),
  ]);
  await clasp(directory, auth, ['push', '--force']);
  const digest = createHash('sha256').update(JSON.stringify([sourceCode, setupPage, privateManifest])).digest('hex').slice(0, 20);
  try {
    const deployment = await deployPrivateSetup(clasp, directory, auth, setupDeploymentPrefix + digest);
    await openPrivateSetup(clasp, directory, auth, deployment, pause);
    const url = `https://script.google.com/macros/s/${deployment}/exec`;
    log(`Açılan Google ekranında istenen izinleri ver. İlk aktarım ve saatlik takip otomatik başlar.\n${url}`);
    return url;
  } catch {
    log(`Google otomatik kurulum sayfasını açamadı. Düzenleyicide startUniTakip → Çalıştır seçip izin verebilirsin.\n${editor}`);
    try { await clasp(directory, auth, ['open-script']); } catch { log('Düzenleyici bağlantısını tarayıcıda aç.'); }
    return editor;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--replace')) throw new Error('Kullanım: npm --prefix cloud/cloudflare run classroom:setup');
    await installClassroom({ replace: args.includes('--replace') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Authenticated admin calls without putting credentials in shell arguments or URLs.
import { readFile, writeFile } from 'node:fs/promises';
const directory = new URL('../../data/cloudflare/', import.meta.url);
const commands = new Set(['status', 'probe', 'smtp-check', 'test-email', 'start', 'stop', 'run']);
try {
  const [action, supplied] = process.argv.slice(2);
  if (!commands.has(action)) throw new Error('command');
  const saved = await readFile(new URL('deployment.json', directory), 'utf8').then(JSON.parse).catch(() => ({}));
  const endpoint = new URL(supplied || saved.url);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.workers.dev') || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('endpoint');
  const secrets = JSON.parse(await readFile(new URL('secrets.json', directory), 'utf8'));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(new URL(action, endpoint), { method: action === 'status' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${secrets.ADMIN_TOKEN}` }, redirect: 'error', signal: controller.signal });
    const result = await response.json();
    console.log(JSON.stringify({ status: response.status, ...result }));
    if (!response.ok) process.exitCode = 1;
    else if (supplied) await writeFile(new URL('deployment.json', directory), JSON.stringify({ url: endpoint.href }), { mode: 0o600 });
  } finally { clearTimeout(timer); }
} catch { console.error('Yönetim çağrısı tamamlanamadı. Komutu, dağıtım adresini ve yerel gizli paketi kontrol et.'); process.exitCode = 1; }

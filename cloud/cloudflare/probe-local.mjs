import { readFile } from 'node:fs/promises';
import { configuration, probe } from './src/runtime.js';

try {
  const secrets = JSON.parse(await readFile(new URL('../../data/cloudflare/secrets.json', import.meta.url), 'utf8'));
  const config = configuration(secrets.CONFIG_JSON || Array.from({length:Number(secrets.CONFIG_PARTS)}, (_,i)=>secrets[`CONFIG_${i}`]).join(''));
  const started = performance.now(), cpu = process.cpuUsage();
  const result = await probe(config);
  const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ platforms: result, wallSeconds: Number(((performance.now() - started) / 1000).toFixed(1)), cpuMs: Math.ceil((used.user + used.system) / 1000), sent: false, uploaded: false }));
  if (Object.values(result).some((entry) => !entry.ok)) process.exitCode = 1;
} catch { console.error('Yerel bulut denemesi başarısız; hiçbir e-posta gönderilmedi.'); process.exitCode = 1; }

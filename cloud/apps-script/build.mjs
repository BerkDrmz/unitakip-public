import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/runtime.js'],
  outfile: 'dist/Code.gs',
  bundle: true,
  format: 'iife',
  globalName: 'UniTakip',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  external: ['crypto'],
  footer: { js: '\nfunction testConnection(){return UniTakip.testConnection();}\nfunction installTracking(){return UniTakip.installTracking();}\nfunction scheduledCheck(){return UniTakip.scheduledCheck();}\nfunction stopTracking(){return UniTakip.stopTracking();}\nfunction importCredentials(){return UniTakip.importCredentials();}\n' },
});
await writeFile('dist/appsscript.json', JSON.stringify({
  timeZone: 'Europe/Istanbul',
  runtimeVersion: 'V8',
  exceptionLogging: 'NONE',
  oauthScopes: [
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/script.scriptapp',
  ],
}, null, 2) + '\n');

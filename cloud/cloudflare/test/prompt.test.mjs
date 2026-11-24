import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptationPrompt, publicAddress, safeName } from '../ui/src/lib/prompt.js';

test('adaptation prompt carries public context only and never secrets, personal data or query values', () => {
  const site = {
    name: 'LMS ali.veli@ogr.uni.edu.tr 20231234', url: 'https://user:pw@lms.uni.edu.tr/student/20231234/course?token=abc123&sesskey=s3cr3t#notlar',
    type: 'webpages', token: 'moodle-token-secret', cookies: [{ name: 'MoodleSession', value: 'cookie-secret' }], notes: 'kişisel not: vize 85',
  };
  const prompt = buildAdaptationPrompt(site, { wants: ['grades', 'assignments', 'files', 'bogus'], code: 'site', unsupported: ['grades', 'assignments'] });
  for (const forbidden of ['abc123', 's3cr3t', 'token=', 'sesskey', '#notlar', 'user:pw', 'moodle-token-secret', 'cookie-secret', 'MoodleSession', 'ali.veli', '20231234', 'kişisel not', 'vize 85', '?'])
    assert.ok(!prompt.includes(forbidden), forbidden);
  assert.ok(prompt.includes('https://lms.uni.edu.tr/student/…/course'));
  assert.ok(prompt.includes('Not, Ödev, Dosya'));
  assert.ok(prompt.includes('desteklenmeyen yapı'));
  assert.ok(prompt.includes('CAPTCHA'));
  assert.ok(prompt.includes('npm test'));
  assert.ok(/şifre, token veya çerez isteme/i.test(prompt));
});

test('unknown error codes never leak raw server text', () => {
  const prompt = buildAdaptationPrompt({ name: 'X Üni', url: 'https://x.edu.tr/', type: 'moodle' }, { code: '<html>Fatal: password=hunter2</html>' });
  assert.ok(!prompt.includes('hunter2')); assert.ok(!prompt.includes('<html>'));
  assert.ok(prompt.includes('Moodle'));
});

test('helpers sanitize names and addresses', () => {
  assert.equal(safeName(''), 'Adsız site');
  assert.equal(safeName('a'.repeat(100)).length, 60);
  assert.equal(publicAddress('javascript:alert(1)'), '(adres geçersiz)');
  assert.equal(publicAddress('https://x.edu.tr/a/AbCdEfGhIjKlMnOpQrStUvWx/b'), 'https://x.edu.tr/a/…/b');
});

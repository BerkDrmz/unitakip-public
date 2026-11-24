import test from 'node:test';
import assert from 'node:assert/strict';
import { siteTestFailure } from '../ui/src/lib/meta.js';

test('a successful newer scan supersedes an old partial or login test; current failed tests still warn', () => {
  for (const code of ['partial', 'auth', 'network']) {
    const lastTest = { at: 1000, ok: false, code };
    assert.equal(siteTestFailure({ lastTest, lastSuccess: 2000 }), null, 'old failures are history, not current incidents');
    assert.equal(siteTestFailure({ lastTest, lastSuccess: 500 }), code, 'a newer failed test remains visible');
    assert.equal(siteTestFailure({ lastTest }), code, 'no successful scan yet');
    assert.equal(siteTestFailure({ lastTest, lastSuccess: 1000 }), code, 'equal times do not prove recovery');
  }
  assert.equal(siteTestFailure({}), null);
  assert.equal(siteTestFailure({ lastTest: { at: 1000, ok: true, code: null } }), null);
});

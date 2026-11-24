import test from 'node:test';
import assert from 'node:assert/strict';
import { moodleSnapshot, moodleCall, READ_ONLY } from '../src/moodle.js';
import { emptyState, mergeSnapshot, webSnapshot } from '../src/core.js';
import { SiteClient } from '../src/http.js';

const now = Date.parse('2026-11-13T04:00:00+03:00');
const wrapper = 'tool_mobile_call_external_functions';
function fixture(options = {}) {
  const courses = Array.from({ length: options.courseCount || 3 }, (_, i) => ({ id: i + 1, fullname: `Ders ${i + 1}` }));
  const many = (create) => Array.from({ length: options.volume || 1 }, (_, i) => create(i));
  const requests = [], executed = [];
  const platform = { base_url: 'https://moodle.uni.edu.tr', token: 'private-token', batch_requests: options.batch !== false };
  let grade = '85';
  const answer = (fn, args) => {
    executed.push([fn, args]);
    if (options.fail === fn) return { errorcode: options.auth ? 'invalidtoken' : 'nopermissions', exception: 'moodle_exception', message: 'private-server-error' };
    switch (fn) {
      case 'core_webservice_get_site_info': return { userid: 7, functions: [...READ_ONLY, ...(options.advertise === false ? [] : [wrapper])].map((name) => ({ name })) };
      case 'core_course_get_enrolled_courses_by_timeline_classification': return { courses };
      case 'core_course_get_contents': return [{ id: args.courseid, name: 'Hafta 1', modules: many((i) => ({ id: args.courseid * 1000 + i, modname: 'resource', name: `Sunum ${i}`, contents: [{ filename: `sunum-${i}.pdf`, fileurl: `${platform.base_url}/pluginfile.php/${args.courseid}/sunum-${i}.pdf`, filesize: 123, timemodified: 4 }] })) }];
      case 'mod_assign_get_assignments': return { courses: [{ id: 1, assignments: many((i) => ({ id: 22 + i, name: `Ödev ${i}`, cmid: 9 + i, duedate: 1795000000, intro: '<p>Açıklama</p>' })) }] };
      case 'mod_quiz_get_quizzes_by_courses': return { quizzes: [{ id: 8, course: 1, name: 'Quiz', coursemodule: 4, timeclose: 1795000000 }] };
      case 'core_calendar_get_calendar_events': return { events: [{ id: 2, courseid: 1, name: 'Sınav', timestart: 1795000000 }] };
      case 'gradereport_user_get_grade_items': return { usergrades: [{ gradeitems: many((i) => ({ id: 20 + i, itemname: `Vize ${i}`, gradeformatted: grade })) }] };
      case 'mod_forum_get_forums_by_courses': return options.noForums ? [] : [{ id: 4, course: 1, type: 'news' }, { id: 5, course: 2, type: 'news' }, { id: 6, course: 3, type: 'general' }];
      case 'mod_forum_get_forum_discussions': return { discussions: [{ id: args.forumid, subject: 'Duyuru', message: '<p>Metin</p>' }] };
      default: throw Error(`Unexpected function: ${fn}`);
    }
  };
  const client = { platform, request: async (_url, { payload }) => {
    const fn = payload.wsfunction; requests.push(fn);
    if (fn !== wrapper) return { text: JSON.stringify(answer(fn, Object.fromEntries(Object.entries(payload).filter(([key]) => !['wstoken', 'wsfunction', 'moodlewsrestformat'].includes(key)).map(([key, value]) => [key, /^\d+$/.test(value) ? Number(value) : value])))) };
    if (options.outerFailure) return { text: JSON.stringify({ errorcode: 'invalidparameter', exception: 'moodle_exception' }) };
    if (options.malformed) return { text: '{"responses":[{"error":false,"data":"bad json"}]}' };
    const responses = [];
    for (let i = 0; payload[`requests[${i}][function]`]; i++) {
      assert.ok(i < 4, 'response size is bounded to four calls');
      const call = payload[`requests[${i}][function]`]; assert.ok(READ_ONLY.has(call));
      const value = answer(call, JSON.parse(payload[`requests[${i}][arguments]`]));
      if (value.errorcode) { responses.push({ error: true, exception: JSON.stringify(value) }); break; }
      responses.push({ error: false, data: JSON.stringify(value) });
    }
    return { text: JSON.stringify({ responses }) };
  } };
  return { platform, client, requests, executed, setGrade: (value) => { grade = value; } };
}
const run = (f) => moodleSnapshot(f.platform, f.client, now);

test('official Moodle batching returns identical files, grades, assignments, quizzes, calendar and announcements with fewer HTTP calls', async () => {
  const direct = fixture({ batch: false }), batched = fixture();
  assert.deepEqual(await run(batched), await run(direct));
  assert.equal(direct.requests.length, 14);
  assert.equal(batched.requests.length, 6);
  assert.equal(batched.executed.length, direct.executed.length, 'all underlying reads still happen');
  assert.ok(!batched.executed.some(([fn, args]) => fn === 'mod_forum_get_forum_discussions' && args.forumid === 6));
});

test('a Moodle batch stopping on a section failure preserves other sections and reads remaining calls individually', async () => {
  const direct = fixture({ batch: false, fail: 'mod_assign_get_assignments' }), batched = fixture({ fail: 'mod_assign_get_assignments' });
  const result = await run(batched);
  assert.deepEqual(result, await run(direct));
  assert.deepEqual(result.errors, [{ scope: 'assignments', code: 'site' }]);
  assert.ok(result.complete.includes('grades/3'));
  assert.ok(result.complete.includes('forum/5'));
  assert.equal(batched.executed.filter(([fn]) => fn === 'mod_assign_get_assignments').length, 1);
});

test('unavailable or malformed batching falls back without losing content; unadvertised support is never probed', async () => {
  const expected = await run(fixture({ batch: false }));
  for (const options of [{ outerFailure: true }, { malformed: true }, { advertise: false }]) {
    const f = fixture(options); assert.deepEqual(await run(f), expected);
    assert.equal(f.requests.filter((fn) => fn === wrapper).length, options.advertise === false ? 0 : 1);
  }
});

test('expired credentials inside a Moodle batch abort the snapshot and reveal no server error or token', async () => {
  const f = fixture({ fail: 'core_course_get_contents', auth: true });
  await assert.rejects(run(f), (error) => error.code === 'auth' && !/private/.test(error.message));
  assert.equal(f.requests.length, 3);
});

test('Moodle batch results never survive into the next scan, and the general batch wrapper is not publicly allowed', async () => {
  const f = fixture(), first = await run(f); const cost = f.requests.length;
  f.setGrade('92'); const second = await run(f);
  assert.equal(f.requests.length, cost * 2);
  assert.equal(first.items.find((item) => item.kind === 'grade').fields.Not, '85');
  assert.equal(second.items.find((item) => item.kind === 'grade').fields.Not, '92');
  await assert.rejects(moodleCall(f.client, wrapper, { requests: [{ function: 'mod_assign_save_submission', arguments: '{}' }] }), (error) => error.code === 'unsafe');
});

test('busy fixed-page scan: 200 PDFs, 100 assignments and 200 grades still use 30 HTTP reads with all records retained', async () => {
  const pages = Array.from({ length: 26 }, (_, i) => ({ id: `p${i}`, url: `https://web.uni.edu.tr/p${i}`, content_selector: 'main' }));
  const read = async (volume, courseCount = 2, retries = 0) => {
    const f = fixture({ volume, courseCount, noForums: true }), moodle = await run(f);
    const budget = { used: f.requests.length, limit: 44 };
    let retryCount = 0;
    const client = new SiteClient({ base_url: 'https://web.uni.edu.tr/', pages }, { pause: async () => {}, budget,
      fetcher: async () => {
        if (retryCount++ < retries) throw Error('temporary network failure');
        return new Response(`<main><p>Ödev ve duyuru</p>${Array.from({ length: volume }, (_, i) => `<a href="/d${i}.pdf">Dosya ${i}</a>`).join('')}</main>`);
      } });
    const web = await webSnapshot(client.platform, client);
    return { moodle, web, requests: budget.used };
  };
  const quiet = await read(1), busy = await read(100);
  assert.equal(quiet.requests, 30); assert.equal(busy.requests, 30);
  assert.equal(busy.moodle.items.filter((i) => i.kind === 'file').length, 200);
  assert.equal(busy.moodle.items.filter((i) => i.kind === 'assignment').length, 100);
  assert.equal(busy.moodle.items.filter((i) => i.kind === 'grade').length, 200);
  assert.equal(busy.web.complete.length, 26);
  assert.deepEqual(busy.moodle.errors, []); assert.deepEqual(busy.web.errors, []);
  const state = emptyState(); mergeSnapshot(state, 'sanal', quiet.moodle, now);
  mergeSnapshot(state, 'sanal', busy.moodle, now + 60000);
  assert.equal(Object.keys(state.platforms.sanal.items).length, busy.moodle.items.length);
  assert.ok(Object.keys(state.pending).length > 0, 'new records are queued despite being grouped into bulk notices');
  const newCourses = await read(100, 10), retry = await read(100, 2, 2);
  assert.equal(newCourses.requests, 34, 'additional courses add actual HTTP batches');
  assert.equal(retry.requests, 32, 'two network retries add two requests');
});

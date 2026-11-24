import { MonitorError, cleanURL, htmlText, makeItem, safeURL } from './core.js';
import { hash } from './hash.js';

export const READ_ONLY = new Set([
  'core_webservice_get_site_info', 'core_enrol_get_users_courses',
  'core_course_get_enrolled_courses_by_timeline_classification', 'core_course_get_contents',
  'mod_forum_get_forums_by_courses', 'mod_forum_get_forum_discussions',
  'mod_assign_get_assignments', 'mod_quiz_get_quizzes_by_courses',
  'core_calendar_get_calendar_events', 'gradereport_user_get_grade_items',
  'message_popup_get_popup_notifications',
]);

export function flatten(value, prefix = '', result = {}) {
  if (Array.isArray(value)) value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`, result));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) flatten(entry, prefix ? `${prefix}[${key}]` : key, result);
  else if (value !== undefined && value !== null) result[prefix] = String(value);
  return result;
}

export async function moodleCall(client, fn, args = {}) {
  if (!READ_ONLY.has(fn)) throw new MonitorError('unsafe', 'Moodle yazma işlevi engellendi.');
  return requestMoodle(client, fn, args);
}

function moodleError(data) {
  if (['invalidtoken', 'accessexception', 'requireloginerror', 'invalidsession', 'invalidsesskey'].includes(data?.errorcode)) return new MonitorError('auth', 'Moodle oturumu doldu; yeniden giriş gerekiyor.');
  return new MonitorError('site', 'Bir Moodle bölümü okunamadı; o bölümün eski verisi korundu.');
}

async function requestMoodle(client, fn, args) {
  const platform = client.platform;
  if (!platform.token) throw new MonitorError('auth', 'Moodle tokenı eksik.');
  const response = await client.request(`${platform.base_url.replace(/\/$/, '')}/webservice/rest/server.php`, {
    method: 'post', moodle: true,
    payload: { wstoken: platform.token, wsfunction: fn, moodlewsrestformat: 'json', ...flatten(args) },
  });
  let data;
  try { data = JSON.parse(response.text); } catch { throw new MonitorError('maintenance', 'Moodle JSON yerine beklenmedik bir sayfa döndürdü.'); }
  if (data?.errorcode || data?.exception) {
    throw moodleError(data);
  }
  return data;
}

/** Resmî mobil toplu okuma: en çok dört bölüm/istek; sonuçlar yalnızca bu tarama boyunca tutulur. */
function snapshotReader(client, available) {
  let enabled = available.has('tool_mobile_call_external_functions') && client.platform.batch_requests !== false;
  const cache = new Map(), key = (fn, args) => JSON.stringify([fn, args]);
  return {
    read: async (fn, args = {}) => {
      const cached = cache.get(key(fn, args));
      if (!cached) return moodleCall(client, fn, args);
      if (cached.error) throw cached.error;
      return cached.value;
    },
    prefetch: async (calls) => {
      // Toplu uç nokta yazma işlevlerini de destekler; burada yalnızca mevcut okuma listemiz kullanılabilir.
      for (const [fn] of calls) if (!READ_ONLY.has(fn)) throw new MonitorError('unsafe', 'Moodle yazma işlevi engellendi.');
      if (!enabled) return;
      for (let offset = 0; offset < calls.length; offset += 4) {
        const group = calls.slice(offset, offset + 4);
        if (group.length < 2) continue;
        try {
          const result = await requestMoodle(client, 'tool_mobile_call_external_functions', {
            requests: group.map(([fn, args]) => ({ function: fn, arguments: JSON.stringify(args) })),
          });
          const responses = result?.responses;
          // Moodle ilk bölüm hatasında durur; eksik kalanlar eski tekli yoldan okunur.
          if (!Array.isArray(responses) || !responses.length || responses.length > group.length ||
              (responses.length < group.length && responses.at(-1)?.error !== true)) throw new MonitorError('site', 'Toplu yanıt eksik.');
          const staged = [];
          for (let index = 0; index < responses.length; index++) {
            const response = responses[index];
            if (response?.error === true) {
              const error = moodleError(JSON.parse(response.exception));
              if (error.code === 'auth') throw error;
              if (index !== responses.length - 1) throw new MonitorError('site', 'Toplu yanıt sırası geçersiz.');
              staged.push({ error });
            } else {
              if (response?.error !== false || typeof response.data !== 'string') throw new MonitorError('site', 'Toplu yanıt geçersiz.');
              staged.push({ value: JSON.parse(response.data) });
            }
          }
          staged.forEach((entry, index) => cache.set(key(...group[index]), entry));
        } catch (error) {
          if (['auth', 'deadline', 'quota'].includes(error.code)) throw error;
          // Destek kaldırılırsa, yanıt çok büyükse ya da sunucu toplu okumayı reddederse veri atlanmaz.
          enabled = false;
          return;
        }
      }
    },
  };
}

const timestamp = (seconds) => seconds ? Number(seconds) * 1000 : null;
const fileList = (files, root) => (files || []).filter((file) => file.fileurl && file.filename && (!file.type || file.type === 'file')).map((file) => ({
  url: cleanURL(safeURL(file.fileurl, root)), name: file.filename, size: Number(file.filesize || 0),
  version: hash([file.filename, file.filesize || 0, file.timemodified || 0]),
}));

export async function moodleSnapshot(platform, client, now) {
  const items = [], complete = [], errors = [];
  const info = await moodleCall(client, 'core_webservice_get_site_info');
  if (!info.userid) throw new MonitorError('site', 'Moodle kullanıcı bilgisi beklenen yapıda değil.');
  const available = new Set((info.functions || []).map((entry) => entry.name));
  const can = (fn) => !available.size || available.has(fn);
  const section = async (scope, action) => {
    const staged = [];
    try { await action((...args) => staged.push(makeItem(scope, ...args))); items.push(...staged); complete.push(scope); }
    catch (error) {
      if (['auth', 'deadline', 'quota'].includes(error.code)) throw error;
      errors.push({ scope, code: error.code || 'site' });
    }
  };
  let courses;
  if (platform.course_classification !== 'all' && can('core_course_get_enrolled_courses_by_timeline_classification')) {
    courses = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const data = await moodleCall(client, 'core_course_get_enrolled_courses_by_timeline_classification', { classification: 'inprogress', limit: 100, offset });
      if (!Array.isArray(data.courses)) throw new MonitorError('site', 'Moodle ders listesi beklenen yapıda değil.');
      courses.push(...data.courses);
      if (!data.nextoffset || data.nextoffset <= offset || data.courses.length < 100) break;
      offset = data.nextoffset;
      if (page === 19) throw new MonitorError('site', 'Ders listesi sayfalama sınırına ulaştı; kısmi veri işlenmedi.');
    }
  } else courses = await moodleCall(client, 'core_enrol_get_users_courses', { userid: info.userid });
  if (!Array.isArray(courses)) throw new MonitorError('site', 'Moodle ders listesi beklenen yapıda değil.');
  courses = courses.filter((course) => (!platform.include_course_ids?.length || platform.include_course_ids.includes(course.id)) && !platform.exclude_course_ids?.includes(course.id));
  const ids = courses.map((course) => course.id);
  const names = Object.fromEntries(courses.map((course) => [course.id, course.fullname]));
  const features = platform.features || {};
  const reader = snapshotReader(client, available), read = reader.read;
  const planned = [];
  if (features.contents !== false) for (const id of ids) planned.push(['core_course_get_contents', { courseid: id }]);
  if (ids.length && features.assignments !== false && can('mod_assign_get_assignments')) planned.push(['mod_assign_get_assignments', { courseids: ids }]);
  if (ids.length && features.quizzes !== false && can('mod_quiz_get_quizzes_by_courses')) planned.push(['mod_quiz_get_quizzes_by_courses', { courseids: ids }]);
  const calendarArgs = { events: { courseids: ids }, options: { timestart: Math.floor(now / 1000) - 86400, timeend: Math.floor(now / 1000) + (platform.calendar_days_ahead || 90) * 86400 } };
  if (ids.length && features.calendar !== false && can('core_calendar_get_calendar_events')) planned.push(['core_calendar_get_calendar_events', calendarArgs]);
  if (features.grades !== false && can('gradereport_user_get_grade_items')) for (const id of ids) planned.push(['gradereport_user_get_grade_items', { courseid: id, userid: info.userid }]);
  if (ids.length && (features.announcements !== false || features.forums) && can('mod_forum_get_forums_by_courses')) planned.push(['mod_forum_get_forums_by_courses', { courseids: ids }]);
  await reader.prefetch(planned);
  await section('courses', async (add) => { for (const course of courses) add(course.id, 'course', course.fullname, { url: `${platform.base_url}/course/view.php?id=${course.id}`, body: htmlText(course.summary || '') }); });
  if (features.contents !== false) for (const course of courses) await section(`contents/${course.id}`, async (add) => {
    const contents = await read('core_course_get_contents', { courseid: course.id });
    if (!Array.isArray(contents)) throw new MonitorError('site', 'Moodle ders bölümleri beklenen yapıda değil.');
    for (const content of contents) {
      if (content.uservisible === false || content.visible === 0) continue;
      add(`section/${content.id}`, 'section', content.name || `Bölüm ${content.section}`, { course: course.fullname, body: htmlText(content.summary), url: `${platform.base_url}/course/view.php?id=${course.id}#section-${content.section}` });
      for (const module of content.modules || []) {
        if (module.uservisible === false || module.visible === 0) continue;
        if (module.modname !== 'assign' && module.modname !== 'quiz') add(`module/${module.id}`, 'module', module.name, {
          course: course.fullname, body: htmlText(module.description), url: cleanURL(module.url || `${platform.base_url}/course/view.php?id=${course.id}`),
        });
        if (features.files !== false) for (const file of fileList(module.contents, platform.base_url)) add(`file/${module.id}/${hash(file.url)}`, 'file', file.name, {
          course: course.fullname, url: cleanURL(module.url || `${platform.base_url}/course/view.php?id=${course.id}`), files: [file],
        });
      }
    }
  });
  if (ids.length && features.assignments !== false && can('mod_assign_get_assignments')) await section('assignments', async (add) => {
    const data = await read('mod_assign_get_assignments', { courseids: ids });
    if (!Array.isArray(data.courses)) throw new MonitorError('site', 'Ödev bölümü beklenen yapıda değil.');
    for (const course of data.courses) {
      if (!Array.isArray(course.assignments)) throw new MonitorError('site', 'Ödev listesi eksik; eski kapsam korundu.');
      for (const assignment of course.assignments) add(assignment.id, 'assignment', assignment.name, {
        course: names[course.id], body: htmlText(assignment.intro), dueAt: timestamp(assignment.duedate),
        url: `${platform.base_url}/mod/assign/view.php?id=${assignment.cmid}`, files: fileList(assignment.introattachments, platform.base_url),
      });
    }
  });
  if (ids.length && features.quizzes !== false && can('mod_quiz_get_quizzes_by_courses')) await section('quizzes', async (add) => {
    const data = await read('mod_quiz_get_quizzes_by_courses', { courseids: ids });
    if (!Array.isArray(data.quizzes)) throw new MonitorError('site', 'Quiz bölümü beklenen yapıda değil.');
    for (const quiz of data.quizzes) add(quiz.id, 'quiz', quiz.name, { course: names[quiz.course], body: htmlText(quiz.intro), dueAt: timestamp(quiz.timeclose), url: `${platform.base_url}/mod/quiz/view.php?id=${quiz.coursemodule}` });
  });
  if (ids.length && features.calendar !== false && can('core_calendar_get_calendar_events')) await section('calendar', async (add) => {
    const data = await read('core_calendar_get_calendar_events', calendarArgs);
    if (!Array.isArray(data.events)) throw new MonitorError('site', 'Takvim bölümü beklenen yapıda değil.');
    for (const event of data.events) add(event.id, 'event', event.name, { course: names[event.courseid] || '', body: htmlText(event.description), dueAt: timestamp(event.timestart), url: event.url ? cleanURL(event.url) : `${platform.base_url}/calendar/view.php` });
  });
  if (features.grades !== false && can('gradereport_user_get_grade_items')) for (const id of ids) await section(`grades/${id}`, async (add) => {
    const data = await read('gradereport_user_get_grade_items', { courseid: id, userid: info.userid });
    if (!Array.isArray(data.usergrades)) throw new MonitorError('site', 'Not bölümü beklenen yapıda değil.');
    for (const user of data.usergrades) {
      if (!Array.isArray(user.gradeitems)) throw new MonitorError('site', 'Not kalemleri eksik; eski kapsam korundu.');
      for (const grade of user.gradeitems) add(grade.id, 'grade', grade.itemname || 'Ders toplamı', {
        course: names[id], fields: { Not: grade.gradeformatted || '-', Yüzde: grade.percentageformatted || '-', Aralık: grade.rangeformatted || '', GeriBildirim: htmlText(grade.feedback) },
        url: `${platform.base_url}/grade/report/user/index.php?id=${id}`,
      });
    }
  });
  if (ids.length && (features.announcements !== false || features.forums) && can('mod_forum_get_forums_by_courses')) {
    try {
    const forums = await read('mod_forum_get_forums_by_courses', { courseids: ids });
    if (!Array.isArray(forums)) throw new MonitorError('site', 'Forum listesi beklenen yapıda değil.');
    await reader.prefetch(forums.filter((forum) => (forum.type === 'news' && features.announcements !== false) || (forum.type !== 'news' && features.forums))
      .map((forum) => ['mod_forum_get_forum_discussions', { forumid: forum.id, perpage: platform.discussions_per_forum || 15, page: 0 }]));
    for (const forum of forums) if ((forum.type === 'news' && features.announcements !== false) || (forum.type !== 'news' && features.forums)) await section(`forum/${forum.id}`, async (add) => {
      const data = await read('mod_forum_get_forum_discussions', { forumid: forum.id, perpage: platform.discussions_per_forum || 15, page: 0 });
      if (!Array.isArray(data.discussions)) throw new MonitorError('site', 'Duyuru listesi beklenen yapıda değil.');
      for (const post of data.discussions) add(post.discussion || post.id, forum.type === 'news' ? 'announcement' : 'forum_post', post.subject || post.name, {
        course: names[forum.course], body: htmlText(post.message), url: `${platform.base_url}/mod/forum/discuss.php?d=${post.discussion || post.id}`, files: fileList(post.attachments, platform.base_url),
      });
    });
    } catch (error) { if (['auth', 'deadline', 'quota'].includes(error.code)) throw error; errors.push({scope: 'forums', code: error.code || 'site'}); }
  }
  return { items, complete, errors };
}

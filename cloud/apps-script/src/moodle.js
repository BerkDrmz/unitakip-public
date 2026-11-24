import { MonitorError, cleanURL, hash, htmlText, makeItem, safeURL } from './shared.js';

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

export function moodleCall(client, fn, args = {}) {
  if (!READ_ONLY.has(fn)) throw new MonitorError('unsafe', 'Moodle yazma işlevi engellendi.');
  const platform = client.platform;
  if (!platform.token) throw new MonitorError('auth', 'Sanal Öğrenme tokenı eksik.');
  const response = client.request(`${platform.base_url.replace(/\/$/, '')}/webservice/rest/server.php`, {
    method: 'post', moodle: true,
    payload: { wstoken: platform.token, wsfunction: fn, moodlewsrestformat: 'json', ...flatten(args) },
  });
  let data;
  try { data = JSON.parse(response.text); } catch { throw new MonitorError('maintenance', 'Moodle JSON yerine beklenmedik bir sayfa döndürdü.'); }
  if (data?.errorcode || data?.exception) {
    if (['invalidtoken', 'accessexception', 'requireloginerror', 'invalidsession', 'invalidsesskey'].includes(data.errorcode)) throw new MonitorError('auth', 'Sanal Öğrenme oturumu doldu; yeniden giriş gerekiyor.');
    throw new MonitorError('site', 'Bir Moodle bölümü okunamadı; o bölümün eski verisi korundu.');
  }
  return data;
}

const timestamp = (seconds) => seconds ? Number(seconds) * 1000 : null;
const fileList = (files, root) => (files || []).filter((file) => file.fileurl && file.filename && file.type !== 'folder').map((file) => ({
  url: cleanURL(safeURL(file.fileurl, root)), name: file.filename, size: Number(file.filesize || 0),
  version: hash([file.filename, file.filesize || 0, file.timemodified || 0]),
}));

export function moodleSnapshot(platform, client, now) {
  const items = [], complete = [], errors = [];
  const info = moodleCall(client, 'core_webservice_get_site_info');
  if (!info.userid) throw new MonitorError('site', 'Moodle kullanıcı bilgisi beklenen yapıda değil.');
  const available = new Set((info.functions || []).map((entry) => entry.name));
  const can = (fn) => !available.size || available.has(fn);
  const section = (scope, action) => {
    const staged = [];
    try { action((...args) => staged.push(makeItem(scope, ...args))); items.push(...staged); complete.push(scope); }
    catch (error) {
      if (error.code === 'auth' || error.code === 'deadline') throw error;
      errors.push({ scope, code: error.code || 'site' });
    }
  };
  let courses;
  if (platform.course_classification !== 'all' && can('core_course_get_enrolled_courses_by_timeline_classification')) {
    courses = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const data = moodleCall(client, 'core_course_get_enrolled_courses_by_timeline_classification', { classification: 'inprogress', limit: 100, offset });
      if (!Array.isArray(data.courses)) throw new MonitorError('site', 'Moodle ders listesi beklenen yapıda değil.');
      courses.push(...data.courses);
      if (!data.nextoffset || data.nextoffset <= offset || data.courses.length < 100) break;
      offset = data.nextoffset;
      if (page === 19) throw new MonitorError('site', 'Ders listesi sayfalama sınırına ulaştı; kısmi veri işlenmedi.');
    }
  } else courses = moodleCall(client, 'core_enrol_get_users_courses', { userid: info.userid });
  if (!Array.isArray(courses)) throw new MonitorError('site', 'Moodle ders listesi beklenen yapıda değil.');
  courses = courses.filter((course) => (!platform.include_course_ids?.length || platform.include_course_ids.includes(course.id)) && !platform.exclude_course_ids?.includes(course.id));
  const ids = courses.map((course) => course.id);
  const names = Object.fromEntries(courses.map((course) => [course.id, course.fullname]));
  const features = platform.features || {};
  section('courses', (add) => { for (const course of courses) add(course.id, 'course', course.fullname, { url: `${platform.base_url}/course/view.php?id=${course.id}`, body: htmlText(course.summary || '') }); });
  if (features.contents !== false) for (const course of courses) section(`contents/${course.id}`, (add) => {
    const contents = moodleCall(client, 'core_course_get_contents', { courseid: course.id });
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
  if (ids.length && features.assignments !== false && can('mod_assign_get_assignments')) section('assignments', (add) => {
    const data = moodleCall(client, 'mod_assign_get_assignments', { courseids: ids });
    if (!Array.isArray(data.courses)) throw new MonitorError('site', 'Ödev bölümü beklenen yapıda değil.');
    for (const course of data.courses) {
      if (!Array.isArray(course.assignments)) throw new MonitorError('site', 'Ödev listesi eksik; eski kapsam korundu.');
      for (const assignment of course.assignments) add(assignment.id, 'assignment', assignment.name, {
        course: names[course.id], body: htmlText(assignment.intro), dueAt: timestamp(assignment.duedate),
        url: `${platform.base_url}/mod/assign/view.php?id=${assignment.cmid}`, files: fileList(assignment.introattachments, platform.base_url),
      });
    }
  });
  if (ids.length && features.quizzes !== false && can('mod_quiz_get_quizzes_by_courses')) section('quizzes', (add) => {
    const data = moodleCall(client, 'mod_quiz_get_quizzes_by_courses', { courseids: ids });
    if (!Array.isArray(data.quizzes)) throw new MonitorError('site', 'Quiz bölümü beklenen yapıda değil.');
    for (const quiz of data.quizzes) add(quiz.id, 'quiz', quiz.name, { course: names[quiz.course], body: htmlText(quiz.intro), dueAt: timestamp(quiz.timeclose), url: `${platform.base_url}/mod/quiz/view.php?id=${quiz.coursemodule}` });
  });
  if (ids.length && features.calendar !== false && can('core_calendar_get_calendar_events')) section('calendar', (add) => {
    const data = moodleCall(client, 'core_calendar_get_calendar_events', { events: { courseids: ids }, options: { timestart: Math.floor(now / 1000) - 86400, timeend: Math.floor(now / 1000) + (platform.calendar_days_ahead || 90) * 86400 } });
    if (!Array.isArray(data.events)) throw new MonitorError('site', 'Takvim bölümü beklenen yapıda değil.');
    for (const event of data.events) add(event.id, 'event', event.name, { course: names[event.courseid] || '', body: htmlText(event.description), dueAt: timestamp(event.timestart), url: event.url ? cleanURL(event.url) : `${platform.base_url}/calendar/view.php` });
  });
  if (features.grades !== false && can('gradereport_user_get_grade_items')) for (const id of ids) section(`grades/${id}`, (add) => {
    const data = moodleCall(client, 'gradereport_user_get_grade_items', { courseid: id, userid: info.userid });
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
    const forums = moodleCall(client, 'mod_forum_get_forums_by_courses', { courseids: ids });
    if (!Array.isArray(forums)) throw new MonitorError('site', 'Forum listesi beklenen yapıda değil.');
    for (const forum of forums) if ((forum.type === 'news' && features.announcements !== false) || (forum.type !== 'news' && features.forums)) section(`forum/${forum.id}`, (add) => {
      const data = moodleCall(client, 'mod_forum_get_forum_discussions', { forumid: forum.id, perpage: platform.discussions_per_forum || 15, page: 0 });
      if (!Array.isArray(data.discussions)) throw new MonitorError('site', 'Duyuru listesi beklenen yapıda değil.');
      for (const post of data.discussions) add(post.discussion || post.id, forum.type === 'news' ? 'announcement' : 'forum_post', post.subject || post.name, {
        course: names[forum.course], body: htmlText(post.message), url: `${platform.base_url}/mod/forum/discuss.php?d=${post.discussion || post.id}`, files: fileList(post.attachments, platform.base_url),
      });
    });
  }
  return { items, complete, errors };
}

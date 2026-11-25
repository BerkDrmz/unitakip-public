const UNITAKIP = __UNITAKIP_SCRIPT_CONFIG__;

function startUniTakip() {
  startClassroom_(false);
}

function startClassroom_(onlyOnce) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('UniTakip kurulumu sürüyor. Sayfayı biraz sonra yenile.');
  try {
    const properties = PropertiesService.getUserProperties();
    const previous = ScriptApp.getProjectTriggers().filter((trigger) => trigger.getHandlerFunction() === 'syncUniTakip');
    const scheduled = previous.length === 1 && previous[0].getUniqueId() === properties.getProperty('UNITAKIP_TEN_MINUTE_TRIGGER');
    if (onlyOnce && scheduled && properties.getProperty('UNITAKIP_SETUP_REVISION') === UNITAKIP.revision) return;
    syncClassroomSnapshot_(properties);
    if (!scheduled) {
      const trigger = ScriptApp.newTrigger('syncUniTakip').timeBased().everyMinutes(10).create();
      for (const old of previous) ScriptApp.deleteTrigger(old);
      properties.setProperty('UNITAKIP_TEN_MINUTE_TRIGGER', trigger.getUniqueId());
    }
    if (UNITAKIP.revision) properties.setProperty('UNITAKIP_SETUP_REVISION', UNITAKIP.revision);
  } finally {
    lock.releaseLock();
  }
}

function syncUniTakip() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    syncClassroomSnapshot_(PropertiesService.getUserProperties());
  } finally {
    lock.releaseLock();
  }
}

function syncClassroomSnapshot_(properties) {
  const source = properties.getProperty('UNITAKIP_SOURCE') || Utilities.getUuid();
  properties.setProperty('UNITAKIP_SOURCE', source);
  const capturedAt = Date.now();
  const active = classroomPages(
    (params) => Classroom.Courses.list(params),
    'courses',
    { studentId: 'me', courseStates: ['ACTIVE'], fields: 'nextPageToken,courses(id,name,alternateLink)' },
  );
  const courses = [];
  let entries = 0;
  if (active.length > 80) throw new Error('UniTakip bir aktarımda en fazla 80 etkin Classroom dersi alabilir.');
  for (const course of active) {
    const courseWork = classroomPages(
      (params) => Classroom.Courses.CourseWork.list(course.id, params),
      'courseWork',
      { courseWorkStates: ['PUBLISHED'], fields: 'nextPageToken,courseWork(id,title,description,alternateLink,dueDate,dueTime)' },
    ).map((entry) => ({ ...entry, description: String(entry.description || '').slice(0, 12000) }));
    const announcements = classroomPages(
      (params) => Classroom.Courses.Announcements.list(course.id, params),
      'announcements',
      { announcementStates: ['PUBLISHED'], fields: 'nextPageToken,announcements(id,text,alternateLink,creationTime)' },
    ).map((entry) => ({ ...entry, text: String(entry.text || '').slice(0, 12000) }));
    entries += courseWork.length + announcements.length;
    if (entries > 2000) throw new Error('UniTakip bir aktarımda en fazla 2.000 Classroom kaydı alabilir.');
    courses.push({ id: String(course.id), name: course.name, alternateLink: course.alternateLink, courseWork, announcements });
  }
  const body = JSON.stringify({ source, capturedAt, courses });
  if (Utilities.newBlob(body).getBytes().length > 1024 * 1024) throw new Error('Classroom aktarımı 1 MB sınırını aştı.');
  sendClassroomSnapshot(body);
}

function classroomPages(list, field, query) {
  const rows = [], seen = new Set();
  let pageToken;
  do {
    const params = { ...query, pageSize: 100, ...(pageToken ? { pageToken } : {}) };
    let page;
    try {
      page = list(params);
    } catch (error) {
      if (!/temporar(?:y|ily)|service unavailable|internal error|backend error|rate limit|too many requests|\b(?:429|50[0234])\b/i.test(String(error.message || ''))) throw error;
      Utilities.sleep(1500);
      page = list(params);
    }
    rows.push(...(page[field] || []));
    pageToken = page.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new Error('Classroom sayfalaması tamamlanamadı.');
    seen.add(pageToken);
  } while (pageToken);
  return rows;
}

function sendClassroomSnapshot(payload) {
  for (const delay of [0, 4000, 10000, 22000, 40000]) {
    if (delay) Utilities.sleep(delay);
    const response = UrlFetchApp.fetch(UNITAKIP.url, {
      method: 'post', contentType: 'application/json', payload,
      headers: { Authorization: 'Bearer ' + UNITAKIP.token },
      followRedirects: false, muteHttpExceptions: true,
    });
    let result;
    try { result = JSON.parse(response.getContentText()); } catch { result = {}; }
    const status = response.getResponseCode();
    if (status === 200 && result.ok) {
      console.log(result.paused ? 'UniTakip takibi duraklatılmış.' : 'Classroom aktarımı tamamlandı.');
      return;
    }
    if (status === 401 || result.error === 'classroom_source') throw new Error('UniTakip eşleştirmesi geçersiz. Panelden yeniden hazırla.');
    if (result.error !== 'busy' && status < 500 && status !== 429) throw new Error('UniTakip aktarımı kabul etmedi (' + status + ').');
  }
  throw new Error('UniTakip şu anda meşgul veya erişilemiyor. Bir sonraki zamanlamada yeniden denenecek.');
}

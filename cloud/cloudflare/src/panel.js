import { isClassroomURL } from './classroom.js';
import { announcementDateKey, PUBLIC_ANNOUNCEMENTS_FORMAT } from './web-announcements.js';
import { reportStatus } from './health.js';
import { cleanURL, MonitorError, htmlText, usageStatus, fetchableURL, isBartinAnnouncementArchive, bartinAnnouncementLink } from "./core.js";
import { isExam, gradeStatus } from "./academic.js";
import { hash } from "./hash.js";
import {
  PRESETS,
  classroomConnection,
  ensureSites,
  effectiveSites,
  credentialStatus,
  panelLogin,
  capabilities,
  localPages,
  sameBase,
  saveSite,
  setPaused,
  removeSite,
} from "./sites.js";
export { addActivity, activityEntry } from "./core.js";

const safeLink = (value, root) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname === new URL(root).hostname &&
      !u.username &&
      !u.password
      ? cleanURL(u.href)
      : "";
  } catch {
    return "";
  }
};
const short = (value, max = 300) => String(value || "").slice(0, max);
const fileId = (site, item, index) => short(`${site}/${item.id}/file/${index}`, 550);
/** Moodle servis adresi (anahtar ister) yerine tarayıcı oturumuyla açılan adres. */
const browserFileLink = (url) => fetchableURL(url).replace("/webservice/pluginfile.php", "/pluginfile.php");
/** Paneldeki dosya kimliğinden takip edilen dosyanın kaynağı. Yalnızca kayıtlı dosyalar; serbest adres kabul edilmez. */
export function fileSource(state, id) {
  for (const site of state.sites || []) {
    if (!String(id).startsWith(`${site.id}/`)) continue;
    for (const entry of Object.values(state.platforms[site.id]?.items || {})) {
      if (entry.missingSince) continue;
      for (const [index, file] of (entry.item.files || []).entries())
        if (fileId(site.id, entry.item, index) === id) return { site: site.id, url: file.url, name: String(file.name || entry.item.title || "dosya") };
    }
  }
  return null;
}
const resourceLink = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.hostname.includes(".") &&
      !/^(?:localhost|127\.|0\.|10\.|192\.168\.)/.test(u.hostname)
      ? cleanURL(u.href)
      : "";
  } catch {
    return "";
  }
};
/**
 * Duyurularda tarih yalnızca metinde geçer (ör. "1. quiz'ini 30/10/2026 tarihinde", "teslim zamanı 6/11/2026 günü
 * saat 14:00"). Panel için metindeki ilk tarih okunur; saat aynı cümlede verilmişse o, verilmemişse gün sonu
 * (23.59) kullanılır. Kayıt değişmez, yalnızca görünüme eklenir: yeniden bildirim üretmez.
 */
export function textDue(item) {
  if (Number.isFinite(item.dueAt) && item.dueAt > 0) return { dueAt: item.dueAt, fromText: false };
  if (!["announcement", "notice", "page", "forum_post"].includes(item.kind)) return { dueAt: null, fromText: false };
  const source = `${item.title || ""}. ${item.body || ""}`;
  const match = /(?<![\d/.A-Za-z])(\d{1,2})[./](\d{1,2})[./](20\d\d)(?![\d/.A-Za-z])/.exec(source);
  if (!match) return { dueAt: null, fromText: false };
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return { dueAt: null, fromText: false };
  const sentence = source.slice(match.index + match[0].length).split(/[.!?](?:\s|$)/)[0];
  const time = /saat\s*(\d{1,2})[:.](\d{2})/i.exec(sentence);
  const [hour, minute] = time ? [Number(time[1]), Number(time[2])] : [23, 59];
  const dueAt = Date.UTC(year, month - 1, day, hour - 3, minute);
  return Number.isFinite(dueAt) && new Date(dueAt + 3 * 3600000).getUTCDate() === day ? { dueAt, fromText: true } : { dueAt: null, fromText: false };
}
const CHECK_INTERVALS = [10, 30, 60, 120];
export const intervalMinutes = (state) =>
  CHECK_INTERVALS.includes(state.intervalMinutes) ? state.intervalMinutes : 60;
/** Explicit projection: never serialize state/config objects containing cookies, tokens or SMTP secrets. */
export function dashboard(
  config,
  state,
  { liveEnabled = false, checking = false, checkProgress = null, storage = null, macProjectDirectory = null } = {},
) {
  const tasks = [],
    exams = [],
    grades = [],
    materials = [],
    platforms = [],
    sites = [];
  // Kayıt yalnızca bellekte türetilir; GET isteği durumu kaydetmez (geçiş ilk takipte kalıcı olur).
  ensureSites(state, config);
  const { problems } = effectiveSites(state, config);
  for (const site of state.sites) {
    const id = site.id,
      pcfg = { display_name: site.name, base_url: site.base_url };
    const record = state.platforms[id],
      // Kaybolmuş (missingSince) kayıtlar yalnızca yeniden bildirimi önlemek için tutulur; panelde gösterilmez.
      items = Object.values(record?.items || {}).filter((entry) => !entry.missingSince).map((entry) => entry.item);
    const surveyGrades = new Set(record?.surveyGrades || []);
    const detailedGrades = new Set(items.filter(item => item.kind === "grade" && item.summaryId).map(item => item.summaryId));
    const counts = {
      items: items.length,
      assignments: 0,
      quizzes: 0,
      files: 0,
    };
    for (const item of items) {
      if (item.kind === "file") counts.files++;
      if (item.kind === "material" && item.material) {
        counts.files++;
        materials.push({
          id: short(`${id}/${item.id}`, 550),
          platform: id,
          title: short(item.title),
          course: short(item.course),
          url: item.material.opensSource
            ? safeLink(item.url, pcfg.base_url)
            : resourceLink(item.material.url),
          sourceUrl: safeLink(item.url, pcfg.base_url),
          size: Number(item.material.size) || null,
          opensSource: Boolean(item.material.opensSource),
          extension: short(item.material.extension, 12),
          archived: false,
          publishedAt: Number.isFinite(item.material.publishedAt)
            ? item.material.publishedAt
            : null,
        });
      }
      const common = {
        id: short(`${id}/${item.id}`, 500),
        platform: id,
        kind: item.kind,
        title: short(item.title),
        course: short(item.course),
        body: short(item.body, 2500),
        ...(({ dueAt, fromText }) => ({ dueAt, dueFromText: fromText }))(textDue(item)),
        url: safeLink(item.url, pcfg.base_url),
      };
      if (isExam(item)) exams.push(common);
      if (item.kind === "grade" && !detailedGrades.has(item.id)) {
        const fields = Object.fromEntries(
          Object.entries(item.fields || {})
            .slice(0, 40)
            .map(([key, value]) => [short(htmlText(key), 100), short(htmlText(value), 500)]),
        );
        const ubysExam = site.preset === "bartin-ubys" && Boolean(fields["Sütun 1"] || fields["Sınav Tipi"]);
        const surveyRequired = surveyGrades.has(item.summaryId || item.id);
        const status = gradeStatus(fields);
        grades.push({ ...common, fields, status: surveyRequired && status === "pending" ? "record" : status,
          ...(ubysExam ? { ubysExam, surveyRequired } : {}) });
      }
      if (item.kind === "file" || item.files?.length) {
        for (const [index, file] of (item.files || []).entries()) {
          const url = safeLink(file.url, pcfg.base_url);
          if (!url) continue;
          const archived =
            state.archive[hash(`${id}/${file.url}/${file.version}`)];
          const moodle = site.type === "moodle";
          materials.push({
            id: fileId(id, item, index),
            platform: id,
            title: short(file.name || item.title),
            course: short(item.course),
            url: moodle ? browserFileLink(url) : url,
            // Moodle dosyaları bulutun kendi anahtarıyla panelden iner; siteye giriş gerekmez.
            download: moodle ? `/api/file?id=${encodeURIComponent(fileId(id, item, index))}` : null,
            sourceUrl: common.url,
            size: Number(file.size || archived?.size) || null,
            archived: Boolean(archived),
            extension: String(file.name || "")
              .split(".")
              .pop()
              .toLowerCase()
              .slice(0, 12),
          });
        }
      }
      if (item.kind !== "assignment" && item.kind !== "quiz") continue;
      // Sayfanın düz metin özeti (…/text) ödev değildir; yalnızca sayfa değişimini izler.
      if (item.id.endsWith("/text") && !item.dueAt) continue;
      counts[item.kind === "assignment" ? "assignments" : "quizzes"]++;
      const fields = {};
      if (item.kind === "assignment") {
        for (const key of ["Konu", "Tarih", "Dosya", "Ekler"]) {
          if (item.fields?.[key]) fields[key] = short(item.fields[key], 2000);
        }
        if (item.files?.length && !fields.Ekler) fields.Ekler = item.files.map(file => short(file.name)).filter(Boolean).join(", ");
      }
      tasks.push({
        ...common,
        body: short(item.body, 12000),
        fields,
      });
    }
    const classroom = isClassroomURL(site.base_url);
    const classroomBridge = classroom ? state.classroomBridges?.[id] : null;
    const login = classroom
      ? (classroomBridge?.receivedAt || classroomConnection(state, site, config)) && record?.error !== 'auth' ? 'ok' : 'missing'
      : credentialStatus(site, config.platforms?.[id], panelLogin(state, site, config.platforms?.[id]));
    const error =
      problems[id] ||
      (!site.paused && login === "missing" ? "auth" : null) ||
      record?.error ||
      null;
    let host = "",
      publicURL = "";
    try {
      const u = new URL(site.base_url);
      host = u.hostname;
      publicURL = `${u.origin}${u.pathname}`;
    } catch {}
    platforms.push({
      id,
      name: site.name,
      url: publicURL,
      hostname: host,
      paused: Boolean(site.paused),
      error,
      lastSuccess: record?.lastSuccess || null,
      // Oturumun en son doğrulandığı an (tam okuma ya da oturum yoklaması).
      lastSessionCheck: record?.lastConnectivityAt || null,
      partialCount: record?.partial?.length || 0,
      initialized: Boolean(record?.lastSuccess),
      counts,
    });
    const test = state.siteTests?.[id];
    const archives = new Set((site.pages || []).filter((page) => isBartinAnnouncementArchive(page.url)).map((page) => page.id));
    const detected = new Set(Object.entries(record?.formats || {}).filter(([, format]) => format.startsWith(PUBLIC_ANNOUNCEMENTS_FORMAT)).map(([scope]) => scope));
    const announcements = items.filter((item) => item.kind === 'announcement' && (classroom || archives.has(item.scope) || detected.has(item.scope)))
      .map((item) => ({
        id: short(item.id), title: short(item.title), date: short(item.fields?.Tarih, 35),
        url: item.url && (archives.has(item.scope) ? bartinAnnouncementLink(item.url, site.base_url) : safeLink(item.url, site.base_url)),
      }))
      .sort((a, b) => announcementDateKey(b.date).localeCompare(announcementDateKey(a.date)))
      .slice(0, 100);
    sites.push({
      id,
      name: site.name,
      url: publicURL,
      hostname: host,
      type: classroom ? "classroom" : site.type,
      ...(classroom ? { googleReady: Boolean(config.classroomOAuth || config.classroomBroker),
        classroomBroker: !config.classroomOAuth && config.classroomBroker || null, classroomSyncAt: classroomBridge?.receivedAt || null,
        classroomScriptConfigured: Boolean(classroomBridge) } : {}),
      preset: site.preset || null,
      origin: site.origin || "panel",
      paused: Boolean(site.paused),
      login,
      error,
      wants: site.wants || [],
      capabilities: capabilities(site, { detectedAnnouncements: detected.size > 0 || test?.detectedAnnouncements }),
      pagesCount: (site.pages || []).length,
      // Sayfa listesi bilgisayardaki yapılandırmadan geliyorsa panelden düzenlenmez (bir sonraki aktarımda ezilirdi).
      localPages: localPages(site, config.platforms?.[id]),
      // Panelde eklenen sayfaların adresleri sahibine gösterilir; yerel keşiften gelenler kişisel sorgu içerebilir.
      pages:
        (site.origin || "panel") === "panel"
          ? (site.pages || []).map((page) => short(page.url, 300))
          : [],
      lastSuccess: record?.lastSuccess || null,
      // Oturumun en son doğrulandığı an (tam okuma ya da oturum yoklaması).
      lastSessionCheck: record?.lastConnectivityAt || null,
      partialCount: record?.partial?.length || 0,
      items: counts.items,
      ...(announcements.length ? { announcements } : {}),
      lastTest: test
        ? {
            at: test.at,
            ok: Boolean(test.ok),
            code: test.code || null,
            items: test.items || 0,
            counts: test.counts || {},
            preview: (test.preview || []).slice(0, 8),
            scopes: test.scopes || { complete: 0, failed: 0 },
          }
        : null,
    });
  }
  const activity = (state.activity || []).map((entry) => ({
    id: short(entry.id, 500),
    platform: short(entry.platform, 30),
    type: short(entry.type, 30),
    title: short(entry.title),
    course: short(entry.course),
    category: ["exam", "grade", "material"].includes(entry.category)
      ? entry.category
      : "other",
    detail: short(entry.detail, 1800),
    detectedAt: entry.detectedAt || null,
    sentAt: entry.sentAt || null,
  }));
  // Backfill only notice deliveries actually persisted by the existing monitor.
  for (const [notice, sentAt] of Object.entries(state.notices || {})) {
    const platform = notice.startsWith("weekly/")
      ? "system"
      : notice.split("/")[1];
    if (
      activity.some(
        (entry) =>
          entry.id === `legacy/${notice}` ||
          (entry.sentAt === sentAt &&
            entry.platform === platform &&
            entry.type === "notice"),
      )
    )
      continue;
    if (notice.startsWith("weekly/"))
      activity.push({
        id: `legacy/${notice}`,
        platform: "system",
        type: "notice",
        title: "Haftalık durum raporu gönderildi",
        sentAt,
      });
    else if (notice.startsWith("error/"))
      activity.push({
        id: `legacy/${notice}`,
        platform: notice.split("/")[1],
        type: "notice",
        title: "Bağlantı bildirimi gönderildi",
        sentAt,
      });
  }
  return {
    ...reportStatus(state),
    // Bağlantı geçmişi: kesinti başlangıç/bitişleri ve bugüne kadar gönderilmiş bağlantı uyarılarının zamanları.
    connectionLog: Array.isArray(state.connectionLog) ? state.connectionLog : [],
    loginLog: Array.isArray(state.loginLog) ? state.loginLog.map(({ at, site, mode, result }) => ({ at, site, mode, result })) : [],
    incidentMails: Object.entries(state.notices || {})
      .filter(([key]) => /^(?:incident|stale|error)\//.test(key))
      .map(([key, at]) => ({ kind: key.split("/")[0], site: key.split("/")[1], at }))
      .sort((a, b) => a.at - b.at),
    usage: usageStatus(state, Date.now(), storage),
    profile: { email: config.to },
    macProjectDirectory,
    liveEnabled,
    armed: Boolean(state.armed),
    checking,
    checkProgress: checking && checkProgress ? {
      startedAt: checkProgress.startedAt,
      full: Boolean(checkProgress.full),
      completed: checkProgress.completed,
      total: checkProgress.total,
      current: sites.some((site) => site.id === checkProgress.current) ? checkProgress.current : null,
    } : null,
    lastTick: state.lastTick || null,
    lastFullAt:
      state.lastFullAt ||
      Math.max(0, ...platforms.map((p) => p.lastSuccess || 0)) ||
      null,
    nextFullAt: state.nextFullAt || null,
    intervalMinutes: intervalMinutes(state),
    manualRequestedAt: state.manualRequestedAt || null,
    lastScheduledAt: state.lastScheduledAt || null,
    scheduledRuns: state.scheduledRuns || 0,
    pending: Object.keys(state.pending).length,
    archivedFiles: Object.keys(state.archive).length,
    platforms,
    sites,
    presets: Object.entries(PRESETS).map(([id, preset]) => ({
      id,
      name: preset.name,
      url: preset.base_url,
      type: preset.type,
      description: preset.description,
      added: state.sites.some((site) => site.preset === id || sameBase(site.base_url, preset.base_url)),
    })),
    tasks,
    exams: exams.slice(0, 1000),
    grades: grades.slice(0, 2000),
    materials: [
      ...materials
        .reduce((found, item) => {
          if (!item.url) return found;
          const key = item.opensSource
              ? item.id
              : `${item.platform}/${item.url}`,
            previous = found.get(key);
          if (!previous) found.set(key, item);
          else if (!previous.course && item.course)
            found.set(key, { ...previous, course: item.course });
          return found;
        }, new Map())
        .values(),
    ].slice(0, 2000),
    activity: activity
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))
      .slice(0, 200),
  };
}

export async function panelAction(
  action,
  payload,
  state,
  store,
  storage,
  now = Date.now(),
) {
  if (action === "pause") {
    state.armed = false;
    state.manualRequestedAt = null;
    await storage.deleteAlarm();
  } else if (action === "resume" || action === "check") {
    if (!state.startedAt)
      throw new MonitorError("setup", "Önce ilk kurulum tamamlanmalı.");
    if (action === "check" && !state.armed)
      throw new MonitorError("paused", "Takip duraklatılmış.");
    state.armed = true;
    state.manualRequestedAt = now;
    // Duraklama sırasında önceki turda okunmuş bir siteye de yeni içerik eklenmiş olabilir.
    delete state.fullRound;
  } else if (action === "settings") {
    if (!CHECK_INTERVALS.includes(payload.intervalMinutes))
      throw new MonitorError("config", "Kontrol aralığı geçersiz.");
    state.intervalMinutes = payload.intervalMinutes;
    state.nextFullAt = Math.min(
      state.nextFullAt || Infinity,
      now + payload.intervalMinutes * 60000,
    );
  } else throw new MonitorError("config", "İşlem geçersiz.");
  await store.save(state);
  if (action === "resume" || action === "check")
    await storage.setAlarm(now + 1000);
  return { ok: true };
}

/** Site kaydı işlemleri (ekle/düzenle, duraklat, sürdür, kaldır). Çağıran durumu kaydeder. */
export function siteAction(action, payload, state, config, now = Date.now()) {
  ensureSites(state, config, now);
  if (action === "save") return { ok: true, site: saveSite(state, payload, now).id };
  if (action === "pause" || action === "resume") {
    setPaused(state, String(payload.id || ""), action === "pause", now);
    return { ok: true };
  }
  if (action === "remove") {
    removeSite(state, String(payload.id || ""), now);
    return { ok: true };
  }
  throw new MonitorError("config", "İşlem geçersiz.");
}

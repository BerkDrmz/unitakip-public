import { queueNotice } from './core.js';

/** "Yeniden bağlandı" raporları arasındaki en kısa süre (bağlantısı gidip gelen site posta yağdırmasın). */
export const STATUS_REPORT_INTERVAL = 3 * 60 * 60 * 1000;
/** Günlük özet İstanbul saatiyle bu saatten sonraki ilk kontrolde, günde yalnızca bir kez gider. */
export const DAILY_SUMMARY_HOUR = 21;
const DAYTIME_HOURS = [9, 15];
const date = (value) => value ? new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short',
}).format(value) : 'henüz başarılı kontrol yok';
const reasons = {
  classroom_setup: 'Classroom bağlantısı yapılandırılmamış',
  classroom_waiting: 'Classroom ilk aktarımı bekleniyor',
  classroom_sync: 'Classroom aktarımı bir süredir gelmiyor',
  classroom_policy: 'Google Classroom API erişimi reddedildi',
  auth: 'Yeniden giriş gerekiyor', network: 'Siteye ulaşılamıyor',
  partial: 'Bazı bölümler okunamadı', maintenance: 'Site bakımda',
  deadline: 'Kontrol süresi doldu', config: 'Site yapılandırması geçersiz',
  size: 'Sayfa boyutu sınırı aşıldı', site: 'Site kontrolünde hata var',
  quota: 'Site tek kontrolde okunamayacak kadar çok sayfa izliyor',
  gate: 'Site anket veya onay ekranı gösteriyor',
};
const OK = 'Son kontrolde hata yok';
const CHANGE_LABELS = { new: 'yeni', updated: 'güncellendi', removed: 'kaldırıldı', file_ready: 'dosya hazır' };
const DUE_KINDS = new Set(['assignment', 'quiz', 'event', 'exam']);
/** Bağlantı geçmişi: her kesintinin başlangıcı ve bitişi (son 100 olay). Yalnızca site kimliği, hata kodu ve zaman tutulur. */
function logConnection(state, site, code, now) {
  state.connectionLog = [...(Array.isArray(state.connectionLog) ? state.connectionLog : []), { site, code, at: now }].slice(-100);
}
const FAILURES = new Set([...Object.values(reasons), 'Kontrol hatası']);

function discardPendingIncident(state, name) {
  for (const [id, change] of Object.entries(state.pending)) {
    if (change.platform === name && change.noticeKey?.startsWith('incident/')) delete state.pending[id];
  }
}

/**
 * A recovered site starts a new incident even if it fails again on the same day.
 * Erişim, giriş ve okuma hataları ilk tespitte bildirilir. Aynı kesinti sürdükçe yinelenmez.
 */
export function platformFailure(state, name, code, now) {
  const record = state.platforms[name];
  const safeCode = Object.hasOwn(reasons, code) ? code : 'site';
  if (!record.healthIncident || record.healthIncident.code !== safeCode) {
    discardPendingIncident(state, name);
    // Hata türü değişse de kesinti aynı kesintidir: başlangıç zamanı korunur.
    record.healthIncident = { code: safeCode, key: `incident/${name}/${++state.sequence}`, startedAt: record.healthIncident?.startedAt ?? now, since: now, announced: false };
    logConnection(state, name, safeCode, now);
  }
  record.error = safeCode;
  const incident = record.healthIncident;
  incident.announced = true;
  const advice = safeCode === 'auth' ? (state.panelURL
    ? `Yeniden bağlanmak için bu bağlantıyı aç ve siteye giriş yap (telefondan da olur):\n${state.panelURL}/#/baglan/${encodeURIComponent(name)}`
    : 'Panelde Siteler bölümünden yeniden giriş yapabilirsin.') +
    (() => {
      const site = state.sites?.find((entry) => entry.id === name);
      if (!site || site.type === 'moodle') return '';
      return '\n\ne-Devlet ile giriyorsan yeniden bağlanma ekranındaki bilgisayar komutunu kullan. Açılan okul sayfasında ' +
        'e-Devlet girişini tamamla ve okul sitesine dön. Telefonda bağlanmak için okul hesabının kullanıcı adı ve şifresini kullan.' +
        (/^https:\/\//.test(site.url || '') ? `\nGiriş sayfası: ${site.url}` : '');
    })()
    : safeCode === 'gate' ? 'Site bütün sayfalarında aynı ekranı (zorunlu anket, sözleşme onayı vb.) gösterdiği için içerik okunamıyor.\n' +
      'Takip sisteminin oturumu açık; panelden yeniden bağlanman gerekmiyor.\n' +
      'Siteye kendi tarayıcından girip ekrandaki formu tamamla. Tamamlayınca takip en geç 20 dakika içinde kendiliğinden devam eder;\n' +
      'beklemek istemezsen panelde "Şimdi kontrol et"e bas. Eski kayıtlar korunuyor.'
    : safeCode === 'classroom_sync' ? 'Apps Script projesinde UniTakip aktarım işlevini yeniden çalıştır ve yürütme geçmişini kontrol et.'
    : 'Bu bir oturum sorunu değil; yeniden giriş yapman gerekmiyor.\nEski kayıtlar korunuyor. Sistem her kontrolde yeniden deniyor.';
  queueNotice(state, incident.key, name, reasons[safeCode],
    `Tespit: ${date(incident.startedAt)} (İstanbul).\nSon başarılı tam kontrol: ${date(record.lastSuccess)}.\n${advice}` +
    '\nDurum değişmedikçe bu uyarı yinelenmez; site düzelince haber verilir.', now, { once: true });
}

export function platformRecovered(state, name, now, { full = false } = {}) {
  const record = state.platforms[name];
  record.lastConnectivityAt = now;
  // A session check cannot prove that a previously failing content section recovered.
  if (full || ['auth', 'network'].includes(record.healthIncident?.code)) {
    discardPendingIncident(state, name);
    if (record.healthIncident) logConnection(state, name, 'ok', now);
    record.healthIncident = null;
    record.error = null;
  }
}

export function reportStatus(state) {
  const delivered = Object.entries(state.notices || {}).filter(([key]) => key.startsWith('status/')).map(([, at]) => at);
  return { statusReportIntervalHours: 24, statusReportMode: 'daily', daytimeReportHours: DAYTIME_HOURS, statusReportHour: DAILY_SUMMARY_HOUR, lastStatusReportSentAt: Math.max(0, ...delivered) || null,
    nextStatusReportAt: null };
}

const PAUSED = 'Duraklatıldı';
function siteStatus(state, site, now) {
  const record = state.platforms[site.id] || {};
  const stale = !record.lastSuccess || now - record.lastSuccess > Math.max(state.intervalMinutes || 60, 60) * 120000;
  // Önceki sürümden kalmış, henüz duyurulmamış hatalar da raporda sağlıklı diye gösterilmez.
  const failing = !site.paused && Boolean(record.error) && record.healthIncident?.announced !== false;
  const unconfirmed = !site.paused && Boolean(record.error) && !failing;
  return { name: site.name, count: Object.keys(record.items || {}).filter((id) => !record.items[id]?.missingSince).length, failing, unconfirmed,
    label: site.paused ? PAUSED : failing ? reasons[record.error] || 'Kontrol hatası' : unconfirmed ? 'Kontrol sorunu yeniden doğrulanıyor' : stale ? 'Tam kontrol güncel değil' : OK };
}
const istanbul = (now) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

/** Sabah ve öğleden sonra kısa durum bildirimi, akşam günlük özet. Tümü kalıcı posta kuyruğunu kullanır. */
export function queueStatusReport(state, config, now) {
  if (Object.values(state.pending).some((change) => change.noticeKey?.startsWith('status/'))) return;
  delete state.statusTroubled;
  for (const [key, at] of Object.entries(state.notices || {})) if (key.startsWith('status/') && now - at > 30 * 86400000) delete state.notices[key];
  const sites = state.sites || Object.entries(config.platforms).map(([id, platform]) => ({ id, name: platform.display_name || id }));
  const current = Object.fromEntries(sites.map((site) => [site.id, siteStatus(state, site, now)]));
  const snapshot = () => Object.fromEntries(Object.entries(current).map(([id, { label, count }]) => [id, { label, count }]));
  const lines = (selected = sites) => selected.map((site) => `${site.name}: ${current[site.id].label}\nSon başarılı tam kontrol: ${date(state.platforms[site.id]?.lastSuccess)}\nTakip edilen kayıt: ${current[site.id].count}`).join('\n\n');
  const previous = state.lastStatusSnapshot;
  const recovered = previous ? Object.entries(current).filter(([id, site]) => FAILURES.has(previous[id]?.label) && !site.failing && site.label !== PAUSED) : [];
  if (recovered.length) {
    const last = state.lastStatusReportAt;
    // Pencere içindeyse fark kaybolmaz: önceki durum saklı kalır, pencere dolunca gönderilir.
    if (last && now >= last - 300000 && now - last < STATUS_REPORT_INTERVAL) return;
    queueNotice(state, `status/${now}`, 'system', 'Durum raporu',
      `Rapor: ${date(now)} (İstanbul).\nDüzelen siteler:\n${recovered.map(([id, site]) => `• ${site.name}: ${previous[id].label} → ${site.label}`).join('\n')}\n\n${lines(sites.filter((site) => recovered.some(([id]) => id === site.id)))}`, now);
    state.lastStatusReportAt = now;
    state.lastStatusSnapshot = snapshot();
    return;
  }
  state.lastStatusSnapshot = snapshot();
  const { day, hour } = istanbul(now);
  if (!sites.length || state.lastDailySummary === day) return;
  if (hour < DAILY_SUMMARY_HOUR) {
    const slot = DAYTIME_HOURS.findLast(start => hour >= start);
    if (slot === undefined) return;
    const key = `status/daytime/${day}/${slot}`;
    if (state.notices?.[key]) return;
    const midnight = Date.parse(`${day}T00:00:00+03:00`);
    const changedToday = [...(state.activity || []), ...Object.values(state.pending)].some(entry =>
      Object.hasOwn(CHANGE_LABELS, entry.type) && (entry.detectedAt ?? entry.sentAt) >= midnight);
    const healthy = sites.every(site => current[site.id].label === OK);
    const title = healthy ? 'Takip çalışıyor · tüm siteler güncel' : 'Takip çalışıyor · site durumları';
    const changes = changedToday ? 'Bugün içerik değişikliği tespit edildi.' : 'Bugünkü kontrollerde içerik değişikliği tespit edilmedi.';
    queueNotice(state, key, 'system', title, `Kontrol zamanı ${date(now)} (İstanbul).\n${changes}\n\n${lines()}`, now, { once: true });
    return;
  }
  const names = Object.fromEntries(sites.map((site) => [site.id, site.name]));
  const isContent = (entry) => Object.hasOwn(CHANGE_LABELS, entry.type);
  const recent = (entry) => (entry.detectedAt ?? entry.sentAt) > now - 86400000;
  const waiting = Object.values(state.pending).filter(isContent);
  const changed = [
    ...(state.activity || []).filter((entry) => isContent(entry) && recent(entry)),
    ...waiting.filter(recent).map(({ platform, type, item }) => ({ platform, type, course: item.course, title: item.title, waiting: true })),
  ];
  const due = [];
  for (const site of sites) if (!site.paused) for (const record of Object.values(state.platforms[site.id]?.items || {})) {
    const item = record?.item;
    if (!record.missingSince && item?.dueAt > now && item.dueAt - now <= 7 * 86400000 && DUE_KINDS.has(item.kind)) due.push({ site: site.name, item });
  }
  // Moodle takvimi ödevin teslimini ayrı bir etkinlik olarak da verir: aynı ders ve aynı anda tek satır gösterilir.
  due.sort((a, b) => a.item.dueAt - b.item.dueAt || (a.item.kind === 'event') - (b.item.kind === 'event'));
  const seenDue = new Set();
  const upcoming = due.filter(({ site, item }) => { const key = `${site}|${item.course || ''}|${item.dueAt}`; return !seenDue.has(key) && seenDue.add(key); });
  const troubled = sites.filter((site) => current[site.id].failing).length;
  const unconfirmed = sites.filter((site) => current[site.id].unconfirmed).length;
  const healthy = sites.every((site) => current[site.id].label === OK);
  const entry = (site, item) => `${site}${item.course ? ` · ${item.course}` : ''} — ${item.title}`;
  const title = `Günlük özet · ${changed.length ? `${changed.length} yeni içerik/değişiklik` : 'bugün yeni içerik yok'}${troubled ? ` · ${troubled} sitede sorun` : ''}`;
  queueNotice(state, `status/daily/${day}`, 'system', title,
    `Özet: ${date(now)} (İstanbul).\n\n` +
    'SON 24 SAATTE YENİ İÇERİK\n' +
    (changed.length
      ? `${changed.slice(0, 15).map((change) => `• ${entry(names[change.platform] || change.platform, change)} (${CHANGE_LABELS[change.type]}${change.waiting ? ', e-posta bekliyor' : ''})`).join('\n')}` +
        `${changed.length > 15 ? `\n… ve ${changed.length - 15} kayıt daha` : ''}`
      : 'Başarılı kontrollerde yeni ödev, dosya, duyuru, sınav ya da not tespit edilmedi.' +
        `${state.lastFullAt ? ` Son tam kontrol ${date(state.lastFullAt)}.` : ''}`) +
    (waiting.length ? `\n${waiting.length} içerik bildirimi gönderim kuyruğunda.` : '') +
    '\n\nÖNÜMÜZDEKİ 7 GÜNDE SON TARİHİ OLANLAR\n' +
    (upcoming.length ? upcoming.slice(0, 10).map(({ site, item }) => `• ${date(item.dueAt)} · ${entry(site, item)}`).join('\n') + (upcoming.length > 10 ? `\n… ve ${upcoming.length - 10} kayıt daha` : '')
      : 'Takip edilen sitelerde önümüzdeki 7 gün içinde son tarihi olan ödev ya da sınav yok.') +
    '\n\nSİTELERİN DURUMU\n' +
    (healthy ? `${sites.length} sitenin hepsi hatasız okundu.`
      : `${troubled ? `${troubled} sitede sorun var.` : unconfirmed ? `${unconfirmed} sitede kontrol sorunu yeniden doğrulanıyor.` : 'Bazı sitelerin kontrolü güncel değil.'}\n\n${lines()}`) +
    `\n\nBu özet her akşam ${DAILY_SUMMARY_HOUR}:00'den sonra bir kez gelir. UniTakip, yeni içerik ve bağlantı sorunları için ayrıca e-posta gönderir.`, now);
  state.lastDailySummary = day;
}

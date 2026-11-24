import { MonitorError, mergeSnapshot, text } from './core.js';
import { classroomItem, classroomRandomToken } from './classroom.js';
import { platformRecovered } from './health.js';
import { hash } from './hash.js';
import { clearSiteRecords } from './sites.js';

export const CLASSROOM_SCRIPT_PATH = '/sync/classroom/';
export const CLASSROOM_SCRIPT_LIMIT = 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,120}$/;
const SOURCE = /^[a-f0-9-]{36}$/i;
const TOKEN = /^([a-zA-Z0-9_-]{43})\.([a-zA-Z0-9_-]{43})$/;
export const validClassroomScriptKey = (token) => TOKEN.test(token || '');
const encoder = new TextEncoder();
const signingKey = (secret) => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const message = (site, nonce) => encoder.encode(`unitakip/classroom-script/v1/${site}/${nonce}`);

export async function issueClassroomScriptKey(site, secret) {
  const nonce = classroomRandomToken();
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), message(site, nonce)));
  const encoded = btoa(String.fromCharCode(...signature)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${nonce}.${encoded}`;
}

export async function verifyClassroomScriptKey(token, site, secret) {
  const match = TOKEN.exec(token || '');
  if (!match || typeof secret !== 'string' || secret.length < 32) return false;
  const [, nonce, encoded] = match;
  const signature = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='), (letter) => letter.charCodeAt(0));
  return crypto.subtle.verify('HMAC', await signingKey(secret), signature, message(site, nonce));
}

export function matchesClassroomScriptKey(token, digest) {
  if (!validClassroomScriptKey(token) || typeof digest !== 'string' || digest.length !== 64) return false;
  const actual = hash(token);
  let diff = 0;
  for (let index = 0; index < digest.length; index++) diff |= digest.charCodeAt(index) ^ actual.charCodeAt(index);
  return diff === 0;
}

const invalid = () => new MonitorError('bad_request', 'Classroom aktarım paketi okunamadı.');
export function readClassroomScriptSnapshot(payload, now) {
  const { source, capturedAt, courses } = payload;
  if (typeof source !== 'string' || !SOURCE.test(source) || !Number.isSafeInteger(capturedAt) ||
      capturedAt < now - 15 * 60000 || capturedAt > now + 120000 ||
      !Array.isArray(courses) || courses.length > 80) throw invalid();
  const items = [], complete = ['classroom/courses'];
  const courseIds = new Set();
  for (const course of courses) {
    if (typeof course?.id !== 'string' || !ID.test(course.id) || courseIds.has(course.id) || typeof course.name !== 'string' || !text(course.name)) throw invalid();
    courseIds.add(course.id);
    for (const [resource, kind] of [['courseWork', 'assignment'], ['announcements', 'announcement']]) {
      const scope = `classroom/${course.id}/${resource}`;
      if (!Array.isArray(course[resource]) || items.length + course[resource].length > 2000) throw invalid();
      const seen = new Set();
      for (const entry of course[resource]) {
        if (typeof entry?.id !== 'string' || !ID.test(entry.id) || seen.has(entry.id)) throw invalid();
        for (const field of ['title', 'description', 'text', 'alternateLink', 'creationTime']) {
          if (entry[field] !== undefined && typeof entry[field] !== 'string') throw invalid();
        }
        seen.add(entry.id);
        items.push(classroomItem({ ...course, name: text(course.name).slice(0, 250) }, kind, scope, entry));
      }
      complete.push(scope);
    }
  }
  return { source, capturedAt, items, complete, errors: [] };
}

export function importClassroomScriptSnapshot(state, site, bridge, update, now) {
  if (bridge.source === update.source && bridge.capturedAt >= update.capturedAt) return { ok: true, duplicate: true };
  if (bridge.source && bridge.source !== update.source && !bridge.allowNewSource) throw new MonitorError('classroom_source', 'Apps Script için yeniden eşleştirme gerekli.');
  if (bridge.source !== update.source) {
    clearSiteRecords(state, site.id);
    (state.classroomBridges ||= {})[site.id] = bridge;
  } else {
    const scopes = new Set(update.complete);
    for (const scope of Object.keys(state.platforms[site.id]?.scopes || {})) {
      if (scope.startsWith('classroom/') && !scopes.has(scope)) update.complete.push(scope);
    }
  }
  const previousIncident = state.platforms[site.id]?.healthIncident?.key;
  mergeSnapshot(state, site.id, update, now);
  const record = state.platforms[site.id];
  delete record.classroom;
  if (previousIncident) for (const [key, change] of Object.entries(state.pending || {})) {
    if (change.noticeKey === previousIncident) delete state.pending[key];
  }
  if (state.siteTests) delete state.siteTests[site.id];
  Object.assign(bridge, { source: update.source, capturedAt: update.capturedAt, receivedAt: now, allowNewSource: false });
  platformRecovered(state, site.id, now, { full: true });
  return { ok: true, items: update.items.length };
}

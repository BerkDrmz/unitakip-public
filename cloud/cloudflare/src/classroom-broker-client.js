import { classroomJSON } from './classroom.js';
import { MonitorError } from './core.js';

export const brokerToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function httpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.origin === value && url.protocol === 'https:' && !url.port &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname)) return url.origin;
  } catch {}
  return null;
}

export const classroomBroker = (env) => httpsOrigin(env.CLASSROOM_BROKER_URL);

function brokerHeaders(key) {
  return { Authorization: `Bearer ${key}` };
}

export async function startBrokerConnection(broker, origin, key, options) {
  const data = await classroomJSON(broker + '/v1/start', {
    method: 'POST', headers: { ...brokerHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify({ origin }),
  }, options);
  if (!brokerToken(data.ticket)) throw new MonitorError('network', 'Google bağlantı servisi başlatılamadı.');
  return data.ticket;
}

export async function brokerConnectionStatus(broker, { ticket, key }, options) {
  const data = await classroomJSON(`${broker}/v1/claim/${ticket}`, { method: 'POST', headers: brokerHeaders(key) }, options);
  if (data.status !== 'linked') return { status: ['pending', 'denied', 'expired', 'policy', 'failed'].includes(data.status) ? data.status : 'failed' };
  if (typeof data.account !== 'string' || !data.account || data.account.length > 100) return { status: 'failed' };
  return { status: 'linked', connection: { broker, ticket, key, account: data.account } };
}

export async function brokerSnapshot({ connection }, options) {
  const { broker, ticket, key } = connection;
  const data = await classroomJSON(`${broker}/v1/snapshot/${ticket}`, { method: 'POST', headers: brokerHeaders(key) }, { ...options, timeout: 45000 });
  if (['deadline', 'quota', 'size', 'network', 'classroom_policy', 'site'].includes(data.error)) {
    throw new MonitorError(data.error, 'Ortak Classroom kontrolü tamamlanamadı.');
  }
  if (![data.items, data.complete, data.errors].every(Array.isArray)) throw new MonitorError('site', 'Classroom yanıtı geçersiz.');
  return data;
}

export async function removeBrokerConnection(broker, connection) {
  if (connection?.broker !== broker || !brokerToken(connection?.ticket) || !brokerToken(connection?.key)) return;
  const response = await fetch(`${broker}/v1/disconnect/${connection.ticket}`, {
    method: 'POST', headers: brokerHeaders(connection.key), redirect: 'manual', signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 401) throw new MonitorError('network', 'Google bağlantısı şu anda kaldırılamadı.');
}

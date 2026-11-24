import { MonitorError, emptyState } from './core.js';

export function b64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
export const unb64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export class Vault {
  constructor(key) {
    try {
      const bytes = unb64(key || '');
      if (bytes.length !== 32) throw new Error();
      this.key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } catch { throw new MonitorError('config', 'Durum şifreleme anahtarı eksik.'); }
  }
  async seal(bytes, label) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(label) }, await this.key, bytes);
    return `${b64(iv)}.${b64(new Uint8Array(data))}`;
  }
  async open(value, label) {
    try {
      const [iv, data] = value.split('.');
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(label) }, await this.key, unb64(data)));
    } catch { throw new MonitorError('storage', 'Şifreli kayıt doğrulanamadı; durum sıfırlanmadı.'); }
  }
}

/** SQLite rows remain well below the platform row limit; replacement is atomic. */
export class Store {
  constructor(storage, key) {
    this.storage = storage; this.sql = storage.sql; this.vault = new Vault(key);
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (name TEXT, part INTEGER, data TEXT NOT NULL, PRIMARY KEY(name, part))');
    // Tek satırlık günlük yazım sayacı: Cloudflare'ın ölçtüğü rowsWritten (ücretsiz plan: günde 100.000, 00.00 UTC'de sıfırlanır).
    this.sql.exec('CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, day TEXT, rows INTEGER, prev_day TEXT, prev_rows INTEGER)');
  }
  /** Yazımın Cloudflare tarafından sayılan satırları (indeks güncellemeleri dahil). */
  written(...args) { const cursor = this.sql.exec(...args); cursor.toArray(); return cursor.rowsWritten; }
  /** Aynı işlem içinde çağrılır. Gün değişince bugünkü toplam dünün yerine geçer; SET ifadeleri eski değerleri görür. */
  count(rows, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    // +1: bu upsert'in kendisi de bir satır yazımıdır (Miniflare ile ölçüldü; test/storage-usage.test.mjs doğrular).
    this.sql.exec(`INSERT INTO usage (id, day, rows) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET
      prev_day = CASE WHEN day = excluded.day THEN prev_day ELSE day END,
      prev_rows = CASE WHEN day = excluded.day THEN prev_rows ELSE rows END,
      rows = CASE WHEN day = excluded.day THEN rows + excluded.rows ELSE excluded.rows END,
      day = excluded.day`, day, rows + 1);
  }
  /** Bugünkü (UTC) ölçülen satır yazımı, dünün toplamı ve veritabanı boyutu. Yalnızca okur. */
  usage(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10), yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
    const row = this.sql.exec('SELECT day, rows, prev_day, prev_rows FROM usage WHERE id = 1').toArray()[0];
    const previous = row?.day === yesterday ? row.rows : row?.prev_day === yesterday ? row.prev_rows : null;
    return { rowsWritten: row?.day === day ? row.rows : 0, yesterdayRows: previous, databaseSize: this.sql.databaseSize ?? null };
  }
  async read(name) {
    const rows = this.sql.exec('SELECT part, data FROM records WHERE name = ? ORDER BY part', name).toArray();
    if (!rows.length) return null;
    if (rows.some((row, i) => row.part !== i)) throw new MonitorError('storage', 'Kalıcı kayıt eksik.');
    return this.vault.open(rows.map((row) => row.data).join(''), name);
  }
  async write(name, bytes) {
    if (name === 'state') this.savedState = null;
    const encrypted = await this.vault.seal(bytes, name);
    this.storage.transactionSync(() => {
      let rows = this.written('DELETE FROM records WHERE name = ?', name);
      for (let i = 0; i < encrypted.length; i += 400000) rows += this.written('INSERT INTO records VALUES (?, ?, ?)', name, i / 400000, encrypted.slice(i, i + 400000));
      this.count(rows);
    });
  }
  async load() {
    const bytes = await this.read('state');
    if (!bytes) return emptyState();
    const serialized = new TextDecoder().decode(bytes);
    let state;
    try { state = JSON.parse(serialized); } catch { throw new MonitorError('storage', 'Takip kaydı bozuk.'); }
    if (state.schema !== 1 || !state.platforms || !state.pending || !state.fileJobs || !state.archive) throw new MonitorError('storage', 'Takip şeması geçersiz.');
    this.savedState = serialized;
    return state;
  }
  async save(state) {
    const serialized = JSON.stringify(state);
    // Only skip a checkpoint already confirmed durable by this Store instance.
    if (serialized === this.savedState) return;
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.length > 8 * 1024 * 1024) throw new MonitorError('storage', 'Takip kaydı uygulama sınırını aşıyor.');
    await this.write('state', bytes);
    this.savedState = serialized;
  }
  async archive(key, bytes) {
    const used = this.sql.exec("SELECT coalesce(sum(length(data)),0) AS size FROM records WHERE name LIKE 'file/%'").one().size;
    if (used + bytes.length * 1.4 > 400 * 1024 * 1024) throw new MonitorError('storage', 'Dosya arşivi dolu.');
    await this.write(`file/${key}`, bytes);
  }
}

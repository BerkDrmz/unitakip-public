const encoder = new TextEncoder();
export const SESSION_COOKIE = "__Host-unitakip";
// Bu sürüm yalnızca panel çerezlerini geçersiz kılar. Site oturumları aynı anahtarla okunmaya devam eder.
const SESSION_VERSION = 2;
// Oturum 30 gün geçerlidir ve panel kullanıldıkça uzar: düzenli kullanılan cihazda yeniden kod istenmez.
const DAYS = 30 * 86400;
/** Oturum en az bu kadar eskidiyse bir sonraki panel açılışında sessizce yenilenir. */
const RENEW_AFTER = 86400 * 1000;
const encode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const decode = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
async function key(secret) {
  if (!secret || secret.length < 32) throw new Error("Missing signing key");
  const derived = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`unitakip/panel/signing/v1/${secret}`),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
const sign = async (secret, value) =>
  new Uint8Array(
    await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(value)),
  );
export class AuthError extends Error {
  constructor(code, status, retryAfter = 0) {
    super(code);
    Object.assign(this, { code, status, retryAfter });
  }
}
export const sameOrigin = (request) =>
  request.headers.get("Origin") === new URL(request.url).origin;
export function cookie(value, maxAge = DAYS) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
export async function issueSession(secret, now = Date.now(), nonce = encode(crypto.getRandomValues(new Uint8Array(16)))) {
  const payload = encode(
    encoder.encode(
      JSON.stringify({
        v: SESSION_VERSION,
        exp: now + DAYS * 1000,
        nonce,
      }),
    ),
  );
  return `${payload}.${encode(await sign(secret, `session/${payload}`))}`;
}
export const validSession = async (request, secret, now = Date.now()) =>
  Boolean(await sessionExpiry(request, secret, now));
/** Yenileme zamanı gelmiş mi: son yenilemenin üzerinden RENEW_AFTER geçtiyse evet. */
export const renewable = (expiry, now = Date.now()) =>
  expiry > now && expiry - now < DAYS * 1000 - RENEW_AFTER;
/** İmzası doğrulanan oturumun kimliği ve bitiş zamanı. Sunucu iptali ayrıca denetlenir. */
export async function readPanelSession(request, secret, now = Date.now()) {
  try {
    const token = (request.headers.get("Cookie") || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (!token || token.length > 1000) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const verified = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      decode(signature),
      encoder.encode(`session/${payload}`),
    );
    if (!verified) return null;
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    return data.v === SESSION_VERSION &&
      Number.isFinite(data.exp) &&
      data.exp > now &&
      data.exp <= now + DAYS * 1000 &&
      typeof data.nonce === "string" && /^[A-Za-z0-9_-]{22}$/.test(data.nonce)
      ? { id: data.nonce, expiry: data.exp }
      : null;
  } catch {
    return null;
  }
}
export const sessionExpiry = async (request, secret, now = Date.now()) =>
  (await readPanelSession(request, secret, now))?.expiry ?? 0;

/** Only the configured owner receives codes. Neither code nor SMTP credentials are returned. */
export class PanelAuth {
  constructor(storage, secret, send, clock = Date.now) {
    Object.assign(this, { storage, secret, send, clock });
    this.busy = false;
  }
  isSessionRevoked(id) {
    const sql = this.storage.sql;
    if (this.revocationsReady === undefined) {
      this.revocationsReady = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'panel_revoked_sessions'").toArray().length !== 0;
    }
    return this.revocationsReady && sql.exec(
      "SELECT 1 FROM panel_revoked_sessions WHERE id = ? AND expires_at > ?", id, this.clock(),
    ).toArray().length !== 0;
  }
  revokeSession(id) {
    const now = this.clock(), sql = this.storage.sql;
    if (!this.revocationsReady) {
      sql.exec("CREATE TABLE IF NOT EXISTS panel_revoked_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID");
      this.revocationsReady = true;
    }
    // Yenilemeden önceki ve eşzamanlı yenilenen çerezler aynı kimliği taşır.
    this.storage.transactionSync(() => {
      sql.exec("DELETE FROM panel_revoked_sessions WHERE expires_at <= ?", now);
      sql.exec("INSERT INTO panel_revoked_sessions VALUES (?, ?) ON CONFLICT(id) DO NOTHING", id, now + DAYS * 1000);
    });
  }
  async locked(action) {
    if (this.busy) throw new AuthError("busy", 429, 5);
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  async requestCode() {
    return this.locked(async () => {
      const now = this.clock(),
        old = (await this.storage.get("panel-auth")) || {};
      if (old.lastSentAt && now - old.lastSentAt < 60000)
        throw new AuthError(
          "cooldown",
          429,
          Math.ceil((60000 - now + old.lastSentAt) / 1000),
        );
      const sameHour = old.windowAt && now - old.windowAt < 3600000;
      if (sameHour && old.sent >= 5)
        throw new AuthError(
          "rate_limit",
          429,
          Math.ceil((3600000 - now + old.windowAt) / 1000),
        );
      let random;
      do {
        random = crypto.getRandomValues(new Uint32Array(1))[0];
      } while (random >= 4294000000);
      const code = String(random % 1000000).padStart(6, "0");
      const nonce = encode(crypto.getRandomValues(new Uint8Array(16)));
      const record = {
        windowAt: sameHour ? old.windowAt : now,
        sent: sameHour ? old.sent + 1 : 1,
        lastSentAt: now,
        expiresAt: now + 600000,
        attempts: 0,
        nonce,
        digest: encode(await sign(this.secret, `code/${nonce}/${code}`)),
      };
      await this.storage.put("panel-auth", record);
      try {
        await this.send({
          subject: "[UniTakip] Giriş kodun",
          body: `UniTakip kontrol paneli için bir giriş kodu istendi. Kod 10 dakika boyunca geçerli ve yalnızca bir kez kullanılabilir.\nBu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.\n\nGiriş kodun: ${code}`,
        });
      } catch {
        await this.storage.put("panel-auth", { ...record, digest: null });
        throw new AuthError("mail", 503);
      }
      return { ok: true, expiresIn: 600, retryAfter: 60 };
    });
  }
  async verify(code) {
    return this.locked(async () => {
      const now = this.clock(),
        record = await this.storage.get("panel-auth");
      if (!record?.digest || record.expiresAt <= now || record.attempts >= 5)
        throw new AuthError("code_expired", 400);
      record.attempts++;
      await this.storage.put("panel-auth", record);
      const matches =
        typeof code === "string" &&
        /^\d{6}$/.test(code) &&
        (await crypto.subtle.verify(
          "HMAC",
          await key(this.secret),
          decode(record.digest),
          encoder.encode(`code/${record.nonce}/${code}`),
        ));
      if (!matches) throw new AuthError("invalid_code", 400);
      await this.storage.put("panel-auth", {
        ...record,
        digest: null,
        consumedAt: now,
      });
      return issueSession(this.secret, now);
    });
  }
}

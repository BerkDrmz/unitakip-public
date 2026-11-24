// Panelden yeniden giriş: oturumu düşen bir siteye kullanıcı panelde kullanıcı adı/şifre (ve varsa SMS kodu)
// girer, giriş isteğini bulut kendisi yapar ve yeni oturumu şifreli takip durumuna yazar.
//
// Güvenlik kuralları:
// - Şifre ve SMS kodu yalnızca o istekte kullanılır; durum kaydına, loga veya yanıta asla yazılmaz.
// - İstekler yalnızca sitenin kendi adresine gider (safeURL); yönlendirme başka alan adına çıkamaz.
// - Yalnızca tanınan giriş uç noktalarına POST yapılır (Moodle token.php, ÜBYS /Account/Login ve
//   /Account/LoginCode, sayfadaki tek şifreli formun kendi adresi).
// - SMS bekleyen yarım giriş yalnızca Durable Object belleğinde, en fazla LOGIN_TTL süre tutulur.
// - CAPTCHA veya e-Devlet gibi adımlar atlanmaya çalışılmaz; böyle bir site "unsupported" döner.
// - e-Devlet girişi aktarılamaz: ÜBYS e-Devlet dönüş kodunu girişi tamamlayan tarayıcıda hemen kullanır (21.11.2026'da
//   canlı denemeyle doğrulandı; dönüş adresi kodsuz ana sayfaya yönlenir). e-Devlet kullananlar ÜBYS'de bir kez şifre oluşturur.
import { load } from 'cheerio/slim';
import { MonitorError, safeURL, cookieHeader, updateCookies, assertLoggedIn } from './core.js';

export const LOGIN_TTL = 5 * 60 * 1000;
export const LOGIN_REQUEST_TIMEOUT = 20000;
export const LOGIN_RESPONSE_LIMIT = 2 * 1024 * 1024;
/** Daha uzun sayfalardan yalnızca son LOGIN_RESPONSE_LIMIT bayt tutulur (ÜBYS giriş sayfası ≈4,6 MB; formlar sondadır). */
export const LOGIN_READ_LIMIT = 12 * 1024 * 1024;
/** Sınırı aşan sayfadan tutulan son bölüm (ÜBYS'de giriş formları ve e-Devlet düğmesi son ≈60 KB'ta). */
export const LOGIN_TAIL = 512 * 1024;

const UA = 'Mozilla/5.0 (UniTakip; personal monitor)';

/** Bound both the response headers and its body; a stalled login must release the monitor lock. */
async function loginResponse(fetcher, url, options, timeoutMs) {
  const abort = new AbortController();
  let reader, response, timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reader?.cancel().catch(() => {});
      reject(new MonitorError('network', 'Giriş isteği zaman aşımına uğradı. Yeniden deneyebilirsin.'));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([timeout, (async () => {
      response = await fetcher(url, { ...options, signal: abort.signal });
      if (abort.signal.aborted) { response.body?.cancel().catch(() => {}); throw new Error('aborted'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        return { response, text: '' };
      }
      if (Number(response.headers.get('content-length')) > LOGIN_READ_LIMIT) throw new MonitorError('site', 'Giriş yanıtı boyut sınırını aştı.');
      reader = response.body?.getReader();
      // Uzun sayfada baştaki parçalar bırakılır: bellekte en çok LOGIN_RESPONSE_LIMIT (+ bir parça) kalır.
      const chunks = []; let size = 0, kept = 0;
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > LOGIN_READ_LIMIT) throw new MonitorError('site', 'Giriş yanıtı boyut sınırını aştı.');
        chunks.push(value); kept += value.length;
        // Sayfa sınırı aştıysa yalnızca son LOGIN_TAIL bayt tutulur (parçalar tek tek bırakılır).
        if (size > LOGIN_RESPONSE_LIMIT) while (chunks.length > 1 && kept - chunks[0].length >= LOGIN_TAIL) kept -= chunks.shift().length;
      }
      const bytes = new Uint8Array(kept); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { response, text: new TextDecoder().decode(bytes) };
    })()]);
  } catch (error) {
    abort.abort();
    reader?.cancel().catch(() => {});
    if (!reader) response?.body?.cancel().catch(() => {});
    if (error instanceof MonitorError) throw error;
    throw new MonitorError('network', 'Giriş yanıtı alınamadı. Yeniden deneyebilirsin.');
  } finally {
    clearTimeout(timer);
    // A pending read is cancelled above before releasing its lock.
    try { reader?.releaseLock(); } catch {}
  }
}

/** Yalnızca sitenin kendi alan adına istek atan, çerez saklayan küçük istemci. */
class LoginSession {
  constructor(base, fetcher, cookies = [], { timeoutMs = LOGIN_REQUEST_TIMEOUT } = {}) {
    Object.assign(this, { base, fetcher, cookies: structuredClone(cookies), host: new URL(base).hostname });
    this.timeoutMs = timeoutMs;
    this.deadline = Date.now() + 60000;
  }
  async request(url, { method = 'GET', form = null, ajax = false } = {}) {
    let target = safeURL(url, this.base), verb = method;
    for (let hops = 0; hops <= 5; hops++) {
      if (Date.now() >= this.deadline) throw new MonitorError('network', 'Giriş işlemi zaman aşımına uğradı.');
      const { response, text } = await loginResponse(this.fetcher, target, {
        method: verb, redirect: 'manual',
        headers: {
          'User-Agent': UA, Accept: ajax ? 'application/json, text/javascript, */*' : 'text/html,application/xhtml+xml,*/*',
          Cookie: cookieHeader(this.cookies, target),
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: new URL(this.base).origin, Referer: target } : {}),
          ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
        },
        ...(form && verb === 'POST' ? { body: new URLSearchParams(form).toString() } : {}),
      }, Math.min(this.timeoutMs, this.deadline - Date.now()));
      this.cookies = updateCookies(this.cookies, { 'set-cookie': response.headers.getSetCookie?.() || [] }, target);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new MonitorError('site', 'Giriş yönlendirmesi okunamadı.');
        target = safeURL(new URL(location, target).href, this.base);
        // Form gönderiminden sonraki yönlendirme her zaman GET'tir; gövde yeniden gönderilmez.
        verb = 'GET'; form = null;
        continue;
      }
      if (response.status === 429 || response.status >= 500) throw new MonitorError('network', 'Site geçici olarak erişilemiyor.');
      return { status: response.status, url: target, text };
    }
    throw new MonitorError('site', 'Çok fazla yönlendirme.');
  }
  /** Yalnızca sitenin kendi alan adındaki çerezler, alan adı siteye sabitlenmiş olarak saklanır. */
  siteCookies() {
    return this.cookies.filter((cookie) => {
      const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
      return domain === this.host || this.host.endsWith(`.${domain}`);
    }).map((cookie) => ({ ...cookie, domain: this.host }));
  }
}

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const fail = (code, message) => new MonitorError(code, message);

/** Giriş sonrası oturumun gerçekten açıldığını sitenin kendi kontrol sayfasıyla doğrular. */
async function verify(session, platform) {
  const page = await session.request(platform.session_check_url || platform.pages?.[0]?.url || platform.base_url);
  try { assertLoggedIn(page.text, platform); } catch { throw fail('credentials', 'Giriş tamamlanamadı.'); }
  return { status: 'ok', cookies: session.siteCookies() };
}

async function moodleLogin(platform, { username, password }, fetcher, { timeoutMs = LOGIN_REQUEST_TIMEOUT } = {}) {
  const base = platform.base_url.replace(/\/$/, '');
  const { response, text } = await loginResponse(fetcher, safeURL(`${base}/login/token.php`, platform.base_url), {
    method: 'POST', redirect: 'manual',
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, service: platform.ws_service || 'moodle_mobile_app' }).toString(),
  }, timeoutMs);
  if (response.status >= 500 || response.status === 429) throw fail('network', 'Site geçici olarak erişilemiyor.');
  const data = json(text);
  if (data?.token && /^[a-zA-Z0-9]{16,64}$/.test(data.token)) return { status: 'ok', token: data.token };
  if (data?.errorcode === 'invalidlogin' || data?.error) throw fail('credentials', 'Kullanıcı adı veya şifre hatalı.');
  throw fail('unsupported', 'Bu Moodle sitesi mobil uygulama girişini desteklemiyor.');
}

/** ÜBYS (ve aynı yazılımı kullanan siteler): kullanıcı adı + parola, ardından gerekirse SMS kodu. */
async function ubysStart(session, platform, home, { username, password }) {
  // ÜBYS giriş sayfası ≈4,6 MB; formlar en sondadır. Yalnızca giriş formundan sonrası ayrıştırılır (hızlı ve sabit maliyetli).
  const at = home.text.indexOf('data-ajax-url="/Account/Login"');
  const $ = load(at < 0 ? home.text : home.text.slice(Math.max(0, home.text.lastIndexOf('<form', at)))),
    token = $('#loginForm input[name="__RequestVerificationToken"]').attr('value');
  if (!token) throw fail('unsupported', 'Giriş formu tanınmadı.');
  const result = await session.request(new URL('/Account/Login', platform.base_url).href, { method: 'POST', ajax: true, form: { __RequestVerificationToken: token, username, password } });
  const data = json(result.text);
  if (!data) throw fail('credentials', 'Kullanıcı adı veya şifre hatalı.');
  if (data.errorMessage) throw fail('credentials', 'Kullanıcı adı veya şifre hatalı.');
  if (data.twoFactorAuthenticationIsActive) {
    const codeToken = $('#loginCodeForm input[name="__RequestVerificationToken"]').attr('value') || token;
    return { status: 'code', pending: { kind: 'ubys', cookies: session.cookies, codeToken, ajaxToken: $('#__AjaxAntiForgeryForm input[name="__RequestVerificationToken"]').attr('value') || token } };
  }
  return ubysFinish(session, platform, data, $('#__AjaxAntiForgeryForm input[name="__RequestVerificationToken"]').attr('value') || token);
}

async function ubysFinish(session, platform, data, ajaxToken) {
  // Birden çok kullanıcı grubu varsa (ör. öğrenci + personel) öğrenci grubu seçilir; tek grupta ÜBYS doğrudan açar.
  if (!data.direct && Array.isArray(data.userGroups) && data.userGroups.length) {
    const groups = data.userGroups.filter((group) => ![5001, 5002, 5003].includes(Number(group.id)));
    const student = groups.find((group) => /öğrenci|ogrenci|student/i.test(String(group.name))) || groups[0];
    if (student) await session.request(new URL('/Account/SetCurrentUsersGroup', platform.base_url).href, { method: 'POST', ajax: true, form: { __RequestVerificationToken: ajaxToken, userGroupId: String(student.id) } });
  }
  return verify(session, platform);
}

/** Tek şifre alanlı basit form (ör. Öğreniyorum.net). Ek doğrulama adımı varsa desteklenmez. */
async function formLogin(session, platform, page, { username, password }) {
  const $ = load(page.text);
  const forms = $('form').filter((_, form) => $(form).find('input[type="password"]').length === 1);
  if (forms.length !== 1) throw fail('unsupported', 'Giriş formu tanınmadı.');
  const form = forms.first();
  if (form.find('.g-recaptcha, [data-sitekey], iframe[src*="captcha"]').length || /captcha/i.test(form.html() || '')) throw fail('unsupported', 'Bu sitede CAPTCHA var; panelden giriş yapılamaz.');
  const fields = {};
  form.find('input[name]').each((_, input) => {
    const type = String($(input).attr('type') || 'text').toLowerCase(), name = $(input).attr('name');
    if (type === 'hidden') fields[name] = $(input).attr('value') || '';
    if (type === 'checkbox' && /remember|hatirla|hatırla/i.test(name)) fields[name] = 'on';
  });
  const user = form.find('input[type="email"], input[type="text"]').filter((_, input) => $(input).attr('name')).first().attr('name');
  const pass = form.find('input[type="password"]').attr('name');
  if (!user || !pass) throw fail('unsupported', 'Giriş formu tanınmadı.');
  fields[user] = username; fields[pass] = password;
  if (String(form.attr('method') || 'get').toLowerCase() !== 'post') throw fail('unsupported', 'Giriş formu tanınmadı.');
  await session.request(new URL(form.attr('action') || page.url, page.url).href, { method: 'POST', form: fields });
  return verify(session, platform);
}

/**
 * Girişi başlatır. Sonuç: { status: 'ok', cookies } | { status: 'ok', token } | { status: 'code', pending }.
 * pending yalnızca bellekte tutulmalıdır (çerez içerir).
 */
export async function startLogin(platform, credentials, fetcher = (...args) => fetch(...args), options = {}) {
  const username = String(credentials.username || '').trim(), password = String(credentials.password || '');
  if (!username || !password || username.length > 200 || password.length > 200) throw fail('bad_request', 'Kullanıcı adı ve şifre gerekli.');
  if (platform.type === 'moodle') return moodleLogin(platform, { username, password }, fetcher, options);
  const session = new LoginSession(platform.base_url, fetcher, [], options);
  const start = platform.login_url || platform.session_check_url || platform.pages?.[0]?.url || platform.base_url;
  const isUbys = (html) => /data-ajax-url="\/Account\/Login"/.test(html);
  let page = await session.request(start);
  // Kontrol sayfası giriş formu göstermiyorsa (ör. oturum hâlâ açık sanılıyorsa) ana sayfadaki formu dene.
  if (!isUbys(page.text) && !/type=["']?password/i.test(page.text)) page = await session.request(platform.base_url);
  return isUbys(page.text) ? ubysStart(session, platform, page, { username, password }) : formLogin(session, platform, page, { username, password });
}

/** SMS kodu adımı. */
export async function finishLogin(platform, pending, code, fetcher = (...args) => fetch(...args), options = {}) {
  const value = String(code || '').trim();
  if (!/^[0-9A-Za-z]{4,10}$/.test(value)) throw fail('code', 'Doğrulama kodu geçersiz.');
  if (pending?.kind !== 'ubys') throw fail('expired', 'Giriş süresi doldu.');
  const session = new LoginSession(platform.base_url, fetcher, pending.cookies, options);
  let result;
  // ÜBYS yanlış kodu HTTP hatasıyla bildirir; bu durumda kullanıcıya "kod hatalı" denir.
  try { result = await session.request(new URL('/Account/LoginCode', platform.base_url).href, { method: 'POST', ajax: true, form: { __RequestVerificationToken: pending.codeToken, code: value } }); }
  catch (error) { if (error.code === 'network') throw fail('code', 'Doğrulama kodu hatalı ya da site yanıt vermedi.'); throw error; }
  const data = json(result.text);
  if (!data || data.errorMessage || result.status >= 400) throw fail('code', 'Doğrulama kodu hatalı.');
  return ubysFinish(session, platform, data, pending.ajaxToken);
}

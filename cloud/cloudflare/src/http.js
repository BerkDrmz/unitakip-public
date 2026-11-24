import { MonitorError, safeURL, cookieHeader, updateCookies } from './core.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class SiteClient {
  constructor(platform, { fetcher = (...args) => fetch(...args), clock = Date.now, pause = sleep, deadline = Date.now() + 240000, budget = null, minIntervalMs = 1500 } = {}) {
    // budget: aynı çalışmadaki bütün sitelerin paylaştığı { used, limit } sayacı (Cloudflare alt istek sınırı).
    Object.assign(this, { platform, fetcher, clock, pause, deadline, budget });
    this.minIntervalMs = Number.isFinite(minIntervalMs) ? Math.max(1000, minIntervalMs) : 1500;
    this.cookies = structuredClone(platform.cookies || []);
    this.last = 0;
    // Art arda yanıt vermeyen istek sayısı. Site çökmüşse her sayfayı üçer kez denemek hem siteyi yorar hem de
    // dış istek payını tüketip "site çok büyük" diye yanlış uyarıya yol açar; ikinci başarısızlıktan sonra tek deneme yapılır.
    this.failures = 0;
  }

  async request(url, options = {}) {
    let target = safeURL(url, this.platform.base_url);
    const method = (options.method || 'GET').toUpperCase();
    // Moodle bir alt dizinde de kurulu olabilir (ör. /moodle/webservice/...). Yalnızca okuma servis uç noktası.
    if (method !== 'GET' && !(method === 'POST' && options.moodle && new URL(target).pathname.endsWith('/webservice/rest/server.php'))) {
      throw new MonitorError('unsafe', 'Yazma isteği engellendi.');
    }
    let retries = 0;
    for (let redirects = 0; redirects <= 4;) {
      if (this.clock() > this.deadline - 20000) throw new MonitorError('deadline', 'Çalışma süresi doldu.');
      // Yönlendirmeler ve yeniden denemeler de birer dış istektir. Pay dolunca site hatası üretmeden durulur.
      if (this.budget) {
        if (this.budget.used >= this.budget.limit) throw new MonitorError('quota', 'Bu çalışmanın dış istek payı doldu; kalanlar sonraki kontrolde okunur.');
        this.budget.used++;
      }
      await this.pause(Math.max(0, this.minIntervalMs - (this.clock() - this.last)));
      this.last = this.clock();
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 25000);
      let response;
      try {
        response = await this.fetcher(target, {
          method, redirect: 'manual', signal: abort.signal,
          headers: { Accept: options.moodle ? 'application/json' : '*/*',
            'User-Agent': this.platform.user_agent || 'UniTakip/0.1 (personal read-only monitor)',
            Cookie: cookieHeader(this.cookies, target, this.clock()),
            ...(options.payload ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
          ...(options.payload ? { body: new URLSearchParams(options.payload).toString() } : {}),
        });
        this.cookies = updateCookies(this.cookies, { 'set-cookie': response.headers.getSetCookie() }, target, this.clock());
        if ([401, 403].includes(response.status)) throw new MonitorError('auth', 'Yeniden giriş gerekiyor.');
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || method !== 'GET' || ++redirects > 4) throw new MonitorError('auth', 'Giriş yönlendirmesi alındı.');
          target = safeURL(new URL(location, target).href, this.platform.base_url);
          continue;
        }
        if (response.status === 429 || response.status >= 500) throw new MonitorError('network', 'Site geçici olarak erişilemiyor.');
        if (response.status >= 400) throw new MonitorError('site', 'Sayfa erişilemiyor.');
        const limit = (options.binary ? 20 : 8) * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) throw new MonitorError('size', 'Yanıt boyutu sınırı aşıldı.');
        const reader = response.body?.getReader(), chunks = [];
        let size = 0;
        if (reader) try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) { await reader.cancel(); throw new MonitorError('size', 'Yanıt boyutu sınırı aşıldı.'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        this.failures = 0;
        return { status: response.status, url: target, headers: response.headers, bytes,
          text: options.binary ? '' : new TextDecoder().decode(bytes) };
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        if (error.code && error.code !== 'network') throw error;
        // Platformun kendi sınırı: yeniden denemek payı daha da tüketir ve "siteye ulaşılamıyor" diye yanlış uyarı üretir.
        if (/subrequest/i.test(String(error?.message || ''))) throw new MonitorError('quota', 'Cloudflare dış istek sınırına ulaşıldı.');
        if (++retries >= (this.failures >= 2 ? 1 : 3)) { this.failures++; throw new MonitorError('network', 'Siteye bağlanılamadı.'); }
        await this.pause(1000 * 2 ** (retries - 1));
      } finally { clearTimeout(timer); }
    }
    throw new MonitorError('network', 'Site yanıtı alınamadı.');
  }
}

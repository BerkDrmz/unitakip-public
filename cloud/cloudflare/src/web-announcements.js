import { load } from 'cheerio/slim';

export const PUBLIC_ANNOUNCEMENTS_FORMAT = 'public-announcements-v1:';
const LIST_PATH = /(?:^|\/)(?:(?:duyuru(?:lar)?|announcements?|notices?|ilanlar)(?:[-_]arsiv)?|(?:announcement|notice)[-_]archive)(?:\.[a-z0-9]+)?\/?$/i;
const DETAIL_PATH = /(?:^|\/)(?:duyuru(?:lar)?|announcements?|notices?|ilanlar|duyuru[-_]detay)\/[^/]/i;
const ANNOUNCEMENT_LABEL = /duyuru|announcements?|\bnotices?\b|\bilanlar\b/i;
const IGNORE = 'nav, header, footer, [role="navigation"], .sidebar, .pagination, .kategoriler, .quickMenu';
const ROW = 'li, tr, article, .duyuru, .announcement-item, .notice-item, .list-item';
const EXCLUDED_LINK = /(?:^|\/)(?:logout|log-out|signout|delete|remove|cikis|sil)(?:[/.\-_]|$)/i;
const FILE_PATH = /\.(?:pdf|docx?|xlsx?|zip|jpg|png)$/i;

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function sameSiteURL(value, base) {
  if (!value) return null;
  try {
    const root = new URL(base);
    const url = new URL(value, root);
    if (url.protocol !== 'https:' || url.origin !== root.origin || url.username || url.password || EXCLUDED_LINK.test(url.pathname)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

function htmlDate($, link) {
  const row = link.closest(ROW);
  const time = row.find('time').first();
  const date = row.find('.tarih, .calendar, .date, [itemprop="datePublished"]').first();
  return text(time.attr('datetime') || time.text() || date.attr('content') || date.text() ||
    row.text().match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})\b/)?.[0]);
}

function feedEntries(html, base) {
  // Read feed text with the HTML/XML parser. Entity declarations are never expanded or fetched.
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:rss|feed)(?:\s|>)/i.test(html)) return null;
  const $ = load(html, { xml: true }, false);
  const feed = $('rss > channel, feed').first();
  if (!feed.length) return null;
  return feed.children('item, entry').slice(0, 100).toArray().flatMap((entry) => {
    const item = $(entry);
    const link = item.children('link').filter((_, element) => !$(element).attr('rel') || $(element).attr('rel') === 'alternate').first();
    const url = sameSiteURL(link.attr('href') || text(link.text()), base);
    const title = text(item.children('title').first().text());
    const rawDate = text(item.children('pubDate, published, updated, dc\\:date').first().text());
    const millis = Date.parse(rawDate);
    const date = Number.isFinite(millis) ? new Date(millis).toISOString().slice(0, 10) : '';
    return title && url ? [{ title, url: url.href, date }] : [];
  });
}

// Known routes identify detail links. On a listing page a dated row can point directly to a document or another path.
export function readPublicAnnouncements(html, base) {
  const feed = feedEntries(html, base);
  if (feed !== null) return { entries: feed, next: null };

  const $ = load(html);
  const root = new URL(base);
  root.hash = '';
  const onList = LIST_PATH.test(root.pathname);
  const entries = new Map();
  let archive = null;
  $('a[href]').each((_, element) => {
    const link = $(element);
    const url = sameSiteURL(link.attr('href'), root);
    const title = text(link.text());
    if (!url || url.href === root.href || !title) return;
    const isListing = LIST_PATH.test(url.pathname);
    if (isListing) {
      if (!onList && !archive && !url.search) archive = url.href;
      return;
    }
    if (link.closest(IGNORE).length || title.length < 5 || /^\d{1,2}\s+\p{L}+$/u.test(title) || /^\d+$/u.test(title)) return;
    const date = htmlDate($, link);
    const inAnnouncementList = link.closest('.duyurular, .duyurular_liste, .announcements, .notices').length > 0;
    if (!DETAIL_PATH.test(url.pathname) && !((onList || inAnnouncementList) && date && link.closest(ROW).length)) return;
    entries.set(url.href, { title, url: url.href, date });
  });

  const feeds = new Map();
  $('link[rel~="alternate"]').each((_, element) => {
    const link = $(element);
    const type = String(link.attr('type') || '').toLowerCase();
    const url = sameSiteURL(link.attr('href'), root);
    if (!url || !['application/rss+xml', 'application/atom+xml'].includes(type) ||
        (url.search && !/^\?feed=(?:rss2?|atom)$/i.test(url.search))) return;
    const label = `${link.attr('title') || ''} ${url.pathname}`;
    if (/comments?|yorum/i.test(label)) return;
    feeds.set(url.href, ANNOUNCEMENT_LABEL.test(label));
  });
  const primaryFeed = [...feeds].find(([, isAnnouncement]) => isAnnouncement)?.[0] ||
    (feeds.size === 1 ? feeds.keys().next().value : null);
  const next = archive || primaryFeed;
  return {
    entries: entries.size >= 2 || (onList && entries.size) ? [...entries.values()].slice(0, 100) : null,
    next: next && next !== root.href && !FILE_PATH.test(new URL(next).pathname) ? next : null,
  };
}

export function announcementDateKey(date) {
  const short = String(date || '').match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (short) return `${short[3]}-${short[2].padStart(2, '0')}-${short[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(date || '') ? date.slice(0, 10) : '';
}

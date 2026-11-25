import { daysUntil } from "../dates.js";

const TZ = "Europe/Istanbul";
const fmt = (options) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, ...options });
const timeFmt = fmt({ hour: "2-digit", minute: "2-digit" });
const dayFmt = fmt({ day: "numeric", month: "short" });
const longDayFmt = fmt({ day: "numeric", month: "long", year: "numeric" });
const weekdayFmt = fmt({ weekday: "long" });
const shortWeekdayFmt = fmt({ weekday: "short" });
const numberFmt = fmt({ day: "numeric" });
const monthFmt = fmt({ month: "short" });

export const time = (v) => (v ? timeFmt.format(v) : "—");
export const day = (v) => (v ? dayFmt.format(v) : "Tarih yok");
export const longDay = (v) => (v ? longDayFmt.format(v) : "Tarih belirtilmemiş");
export const weekday = (v) => weekdayFmt.format(v);
export const shortWeekday = (v) => shortWeekdayFmt.format(v).replace(".", "");
export const dayNumber = (v) => numberFmt.format(v);
export const month = (v) => monthFmt.format(v).replace(".", "");

export function todayHeading(now = Date.now()) {
  return fmt({ weekday: "long", day: "numeric", month: "long" }).format(now);
}

export function relative(v, now = Date.now()) {
  if (!v) return "henüz yok";
  const mins = Math.round((now - v) / 60000);
  if (mins < 0) {
    const ahead = -mins;
    return ahead < 60 ? `${ahead} dk sonra` : ahead < 1440 ? `${Math.round(ahead / 60)} sa sonra` : day(v);
  }
  return mins < 1 ? "az önce" : mins < 60 ? `${mins} dk önce` : mins < 1440 ? `${Math.floor(mins / 60)} sa önce` : day(v);
}

/** Son tarihin aciliyeti: ton (renk), kısa etiket ve gün farkı. */
export function urgency(dueAt, now = Date.now()) {
  if (!dueAt) return { tone: "none", label: "Tarih yok", days: null, past: false };
  const days = daysUntil(dueAt, now);
  const past = dueAt < now;
  if (past) return { tone: "past", label: days === 0 ? "Bugün geçti" : `${-days} gün önce`, days, past };
  if (days === 0) return { tone: "hot", label: `Bugün ${time(dueAt)}`, days, past };
  if (days === 1) return { tone: "hot", label: `Yarın ${time(dueAt)}`, days, past };
  if (days <= 3) return { tone: "warm", label: `${days} gün kaldı`, days, past };
  if (days <= 7) return { tone: "calm", label: `${days} gün kaldı`, days, past };
  return { tone: "calm", label: day(dueAt), days, past };
}

/** Zaman kovaları: ajanda listelerinde gruplama için. */
export function bucketOf(dueAt, now = Date.now()) {
  if (!dueAt) return "undated";
  if (dueAt < now) return "past";
  const d = daysUntil(dueAt, now);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d <= 7) return "week";
  return "later";
}
export const BUCKETS = [
  ["today", "Bugün"],
  ["tomorrow", "Yarın"],
  ["week", "Bu hafta"],
  ["later", "Daha sonra"],
  ["undated", "Tarihi belirtilmemiş"],
  ["past", "Tarihi geçenler"],
];

export function intervalLabel(minutes) {
  if (minutes === 10 || minutes === 30) return `${minutes} dakikada bir`;
  return minutes === 120 ? "2 saatte bir" : "saatte bir";
}

export function fileSize(bytes) {
  if (!bytes) return "";
  return bytes >= 1048576
    ? `${(bytes / 1048576).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let parser;
/** Platformlardan gelen metinlerdeki HTML varlıklarını (ör. "0&ndash;100") güvenle çöz. */
export function clean(value) {
  const text = String(value ?? "");
  if (!text.includes("&")) return text;
  try {
    parser ??= new DOMParser();
    return parser.parseFromString(text, "text/html").documentElement.textContent ?? text;
  } catch {
    return text;
  }
}

export const search = (value) => clean(value).toLocaleLowerCase("tr");

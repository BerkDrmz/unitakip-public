import { Bell, CalendarClock, FolderOpen, Globe, GraduationCap, Settings2, Sun } from "lucide-react";

/*
  Site kaydı panel verisinden (data.sites) beslenir; site sayısı ve adları kuruluma göre değişir.
  Hazır Bartın şablonları kendi renklerini kullanır; diğer siteler kimliklerinden türetilen
  kararlı bir renk alır (liste sırası değişse de aynı site aynı renkte kalır).
*/
const PRESET_COLORS = {
  "bartin-sanal": "var(--sanal)",
  "bartin-ogreniyorum": "var(--ogreniyorum)",
  "bartin-ubys": "var(--ubys)",
};
const LEGACY_COLORS = { sanal: "var(--sanal)", ogreniyorum: "var(--ogreniyorum)", ubys: "var(--ubys)" };
const PALETTE = ["#c2410c", "#0e7490", "#a21caf", "#4d7c0f", "#be123c", "#7c3aed", "#b45309", "#0f766e", "#1d4ed8"];

const hashIndex = (id) => [...String(id)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length;
const shortName = (name) => {
  const clean = String(name || "").replace(/\s*\(.*?\)\s*/g, " ").trim();
  return clean.length > 16 ? `${clean.slice(0, 15)}…` : clean;
};

let registry = new Map();

/** Panel verisi her geldiğinde çağrılır (App). */
export function setSites(list) {
  registry = new Map(
    (list || []).map((site) => [
      site.id,
      {
        id: site.id,
        name: site.name,
        short: shortName(site.name),
        paused: Boolean(site.paused),
        color: PRESET_COLORS[site.preset] || LEGACY_COLORS[site.id] || PALETTE[hashIndex(site.id)],
      },
    ]),
  );
}
export const siteList = () => [...registry.values()];
export const platformLabel = (id) => registry.get(id)?.name || (id === "system" ? "UniTakip" : id || "");
export const platformColor = (id) => registry.get(id)?.color || LEGACY_COLORS[id] || "var(--ink-3)";
/** Süzgeç seçenekleri: [id, kısa ad, nokta rengi için id]. Tek site varsa süzgeç gereksizdir. */
export const platformOptions = () => [["all", "Tümü"], ...siteList().map((site) => [site.id, site.short, site.id])];

export const ROUTES = [
  { id: "bugun", label: "Bugün", icon: Sun, title: "Bugün" },
  { id: "teslimler", label: "Teslimler", icon: CalendarClock, title: "Ödevler ve sınavlar" },
  { id: "notlar", label: "Notlar", icon: GraduationCap, title: "Notlar" },
  { id: "dosyalar", label: "Dosyalar", icon: FolderOpen, title: "Ders dosyaları" },
  { id: "siteler", label: "Siteler", icon: Globe, title: "Takip edilen siteler" },
  { id: "bildirimler", label: "Bildirimler", icon: Bell, title: "Bildirimler" },
  { id: "ayarlar", label: "Ayarlar", icon: Settings2, title: "Ayarlar" },
];
// Mobil alt çubukta 5 sekme; bildirimler üst çubuktaki zilden, siteler Ayarlar ve Bugün sayfasından açılır
export const MOBILE_ROUTES = ROUTES.filter((r) => !["bildirimler", "siteler"].includes(r.id));

export const FEATURE_KEYS = ["announcements", "files", "assignments", "exams", "grades"];
export const FEATURE_NAMES = {
  announcements: "Duyuru",
  files: "Dosya",
  assignments: "Ödev",
  exams: "Sınav",
  grades: "Not",
  pageChanges: "Sayfa değişimi",
};

/** Yeni başarılı kontrol, eski başarısız bağlantı testinin güncel uyarı olmasını engeller. */
export function siteTestFailure(site) {
  const test = site.lastTest;
  if (!test || test.ok || (test.at && site.lastSuccess > test.at)) return null;
  if (test.code === "auth" && test.at && site.lastSessionCheck > test.at) return null;
  return test.code || null;
}

export function platformHealth(platform, active) {
  if (platform.paused) return { tone: "idle", label: "Duraklatıldı" };
  if (!active) return { tone: "idle", label: "Takip kapalı" };
  if (platform.error === "auth") return { tone: "hot", label: "Giriş gerekli" };
  if (platform.error === "gate") return { tone: "hot", label: "Anket/onay bekliyor" };
  if (platform.error === "config") return { tone: "warm", label: "Kurulum eksik" };
  if (platform.error === "site") return { tone: "warm", label: "Yapı tanınmadı" };
  if (platform.error === "quota") return { tone: "warm", label: "Çok fazla sayfa" };
  if (platform.error) return { tone: "warm", label: "Kontrol gerekli" };
  if (!platform.initialized) return { tone: "warm", label: "İlk kontrol bekleniyor" };
  return { tone: "cool", label: "Bağlı" };
}

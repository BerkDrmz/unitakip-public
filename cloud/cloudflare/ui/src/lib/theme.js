import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

/*
  Tema durumu: "system" | "light" | "dark".
  - Seçim localStorage'da saklanır; "system" seçilince kayıt silinir ve cihaz ayarı izlenir.
  - <html data-theme> özniteliği CSS değişkenlerini değiştirir (styles.css).
  - İlk çizimdeki tema public/theme-init.js ile önceden uygulanır (parlama olmaz).
*/
const KEY = "unitakip-theme";
const listeners = new Set();
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readMode() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const resolveTheme = (mode) => (mode === "system" ? (media?.matches ? "dark" : "light") : mode);

let mode = readMode();
let snapshot = { mode, resolved: resolveTheme(mode) };

function syncMeta() {
  const meta = typeof document !== "undefined" && document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", snapshot.resolved === "dark" ? "#0e1014" : "#f4f0e8");
}
syncMeta();

function refresh() {
  snapshot = { mode, resolved: resolveTheme(mode) };
  syncMeta();
  listeners.forEach((l) => l());
}

media?.addEventListener("change", () => mode === "system" && refresh());
// Başka bir sekmede tema değişirse bu sekme de uysun
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    mode = readMode();
    writeAttribute(mode);
    refresh();
  });

function writeAttribute(next) {
  const root = document.documentElement;
  if (next === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", next);
}

function apply(next) {
  mode = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* gizli sekme vb.: yalnızca bu oturum için uygulanır */
  }
  writeAttribute(next);
  flushSync(refresh); // simgeler de geçişin "yeni" görüntüsüne dahil olsun
}

/** Temayı değiştir. origin: tıklanan öğe; dairesel geçiş o noktadan yayılır. */
export function setTheme(next, origin) {
  if (next === mode) return;
  const changesLook = resolveTheme(next) !== snapshot.resolved;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!changesLook || reduce || !document.startViewTransition) {
    apply(next);
    return;
  }
  const rect = origin?.getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : 0;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(() => apply(next));
  transition.ready
    .then(() =>
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 560, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
      ),
    )
    .catch(() => {});
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTheme() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

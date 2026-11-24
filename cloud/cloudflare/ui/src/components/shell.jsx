import { motion } from "motion/react";
import { Bell, LogOut, RefreshCw } from "lucide-react";
import { Brand } from "./brand.jsx";
import { ThemeSwitch, ThemeToggle } from "./theme-switch.jsx";
import { Button, PlatformDot } from "./ui/primitives.jsx";
import { MOBILE_ROUTES, ROUTES, platformHealth } from "../lib/meta.js";
import { relative } from "../lib/format.js";
import { cn } from "../lib/utils.js";

function NavCount({ value }) {
  if (!value) return null;
  return (
    <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-hot px-1.5 text-[0.6875rem] font-bold text-paper tabular">
      {value > 99 ? "99+" : value}
    </span>
  );
}

function StatusCard({ data, active, working }) {
  const issues = data.platforms.filter((p) => !p.paused && platformHealth(p, active).tone !== "cool").length;
  return (
    <div className="rounded-2xl border border-rule bg-card/80 p-4">
      <div className="flex items-center gap-2 text-[0.8125rem] font-semibold">
        <span
          className={cn(
            "size-2 rounded-full",
            !active ? "bg-ink-3" : issues ? "bg-warm text-warm" : "bg-cool text-cool",
            active && "live-dot",
          )}
          aria-hidden
        />
        {!active ? "Takip duraklatıldı" : working ? "Şu an kontrol ediliyor" : issues ? `${issues} site ilgi bekliyor` : "Takip açık"}
      </div>
      <ul className="mt-3 space-y-1.5">
        {data.platforms.slice(0, 5).map((p) => {
          const h = platformHealth(p, active);
          return (
            <li key={p.id} className="flex items-center gap-2 text-xs text-ink-2">
              <PlatformDot platform={p.id} />
              <span className="truncate">{p.name}</span>
              <span className={cn("ml-auto shrink-0", h.tone === "cool" ? "text-ink-3" : h.tone === "hot" ? "text-hot" : "text-warm")}>
                {h.tone === "cool" ? relative(p.lastSuccess) : h.label}
              </span>
            </li>
          );
        })}
      </ul>
      {data.platforms.length > 5 && <p className="mt-2 text-xs text-ink-3">+{data.platforms.length - 5} site daha</p>}
      {!data.platforms.length && <p className="mt-2 text-xs text-ink-3">Henüz site eklenmedi.</p>}
    </div>
  );
}

export function Shell({ route, navigate, data, active, working, onCheck, checkBusy, onLogout, preview, children }) {
  const counts = { bildirimler: data.pending };
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-ink px-4 py-2 text-paper focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        İçeriğe geç
      </a>

      {/* Masaüstü kenar çubuğu */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-rule px-5 py-7 lg:flex">
        <Brand className="px-2" />
        <nav aria-label="Ana menü" className="mt-10 flex flex-col gap-1">
          {ROUTES.map((r, i) => {
            const current = route === r.id;
            return (
              <button
                key={r.id}
                onClick={() => navigate(r.id)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "group row-sweep relative flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                  current ? "text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {current && (
                  <motion.span
                    layoutId="rail-active"
                    className="absolute inset-0 rounded-xl bg-wash"
                    transition={{ type: "spring", stiffness: 480, damping: 38 }}
                  />
                )}
                <span className={cn("relative font-mono text-[0.6875rem] tabular", current ? "text-accent" : "text-ink-3")}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="relative transition-transform duration-300 ease-[var(--ease-out)] group-hover:translate-x-1">{r.label}</span>
                <span className="relative ml-auto">
                  <NavCount value={counts[r.id]} />
                </span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto space-y-3">
          <div className="flex items-center justify-between px-2">
            <span className="text-xs font-semibold text-ink-3">Görünüm</span>
            <ThemeSwitch layoutId="theme-rail" />
          </div>
          <StatusCard data={data} active={active} working={working} />
          <div className="flex items-center gap-3 rounded-2xl px-2 py-1">
            <span className="grid size-9 place-items-center rounded-full bg-wash font-display text-sm font-semibold uppercase">
              {(data.profile.email || "u").slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[0.8125rem] font-semibold">Hesabım</p>
              <p className="truncate text-xs text-ink-3" title={data.profile.email}>
                {data.profile.email}
              </p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onLogout} aria-label="Çıkış yap" icon={LogOut} />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Mobil üst çubuk */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-rule/70 bg-paper/85 px-4 backdrop-blur-md lg:hidden">
          <Brand />
          {preview && <span className="ml-1 rounded-full bg-warm-soft px-2 py-0.5 text-[0.625rem] font-bold text-warm">ÖNİZLEME</span>}
          <div className="ml-auto flex items-center gap-0.5">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              aria-label={working ? "Kontrol ediliyor" : "Şimdi kontrol et"}
              onClick={onCheck}
              disabled={!active || checkBusy || working}
            >
              <RefreshCw className={cn("size-[1.15rem]", (working || checkBusy) && "spin")} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={data.pending ? `Bildirimler, ${data.pending} bekleyen` : "Bildirimler"}
              onClick={() => navigate("bildirimler")}
              className="relative"
            >
              <Bell className="size-[1.15rem]" />
              {data.pending > 0 && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-hot ring-2 ring-paper" />}
            </Button>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-[76rem] px-4 pt-6 pb-32 sm:px-6 lg:px-12 lg:pt-12 lg:pb-16">
          {working && (
            <div role="status" className="mb-6 rounded-2xl bg-wash px-4 py-3 text-sm">
              <p className="flex items-center gap-2 font-semibold">
                <RefreshCw className="size-4 shrink-0 spin" aria-hidden />
                {data.checkProgress ? `${data.checkProgress.completed}/${data.checkProgress.total} site kontrolü tamamlandı` : "Kontrol başlatılıyor"}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">
                {data.checkProgress?.current
                  ? `${data.platforms.find((site) => site.id === data.checkProgress.current)?.name || "Site"} okunuyor.`
                  : data.checkProgress && data.checkProgress.completed >= data.checkProgress.total
                    ? "Sonuçlar ve bildirimler tamamlanıyor."
                    : "Sonuçlar kendiliğinden yenilenir; bu sayfayı açık tutman gerekmez."}
              </p>
            </div>
          )}
          {children}
        </main>
      </div>

      {/* Mobil alt sekme çubuğu: içerik altında pb-32 ile rezerve edilmiş alan, üstüne binmez */}
      <nav
        aria-label="Ana menü"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-rule bg-paper/90 px-2 pt-1 pb-safe backdrop-blur-xl lg:hidden"
      >
        {MOBILE_ROUTES.map((r) => {
          const current = route === r.id;
          return (
            <button
              key={r.id}
              onClick={() => navigate(r.id)}
              aria-current={current ? "page" : undefined}
              className={cn(
                "relative flex h-14 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors",
                current ? "text-ink" : "text-ink-3",
              )}
            >
              <r.icon className="relative size-5" strokeWidth={current ? 2.1 : 1.7} aria-hidden />
              <span className="relative">{r.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

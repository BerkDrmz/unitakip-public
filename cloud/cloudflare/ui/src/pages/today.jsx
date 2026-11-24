import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, ArrowRight, PauseCircle, RefreshCw } from "lucide-react";
import { daysUntil } from "../dates.js";
import { AgendaStrip, ActivityFeed, DayPanel, DeadlineList, PlatformList } from "../components/agenda.jsx";
import { Button, Card, SectionTitle } from "../components/ui/primitives.jsx";
import { relative, time, todayHeading } from "../lib/format.js";
import { platformHealth } from "../lib/meta.js";
import { cn } from "../lib/utils.js";
import { CornerMarks, CountUp, DrawRule, Magnetic, Reveal, RevealText, Scramble } from "../components/motion.jsx";

const WEEK = 7;

function Headline({ active, issues, todayCount, weekCount }) {
  if (!active)
    return (
      <>
        Takip şu an <em className="text-ink-3">duraklatıldı.</em>
      </>
    );
  if (issues.some((p) => p.error === "auth"))
    return (
      <>
        {issues.find((p) => p.error === "auth").name} <em className="text-hot">seni bekliyor.</em>
      </>
    );
  if (todayCount)
    return (
      <>
        Bugün <em className="text-hot">{todayCount} teslimin</em> var.
      </>
    );
  if (weekCount)
    return (
      <>
        Bu hafta <em className="text-accent">{weekCount} teslim</em> var.
      </>
    );
  return (
    <>
      Önün açık. <em className="text-cool">Derslerine odaklan.</em>
    </>
  );
}

function Figure({ value, label, hint }) {
  return (
    <div className="min-w-0 py-1 pr-6 last:pr-0 sm:border-l sm:border-rule sm:pl-6 sm:first:border-l-0 sm:first:pl-0">
      <p className="font-display text-[2rem] leading-none font-semibold tabular">
        <CountUp value={value} />
      </p>
      <p className="mt-1.5 text-[0.8125rem] font-semibold">{label}</p>
      <p className="text-xs text-ink-3">{hint}</p>
    </div>
  );
}

export function TodayPage({ data, tasks, active, working, checkBusy, onCheck, onOpen, navigate, now }) {
  // Bugün boşsa ajanda ilk dolu günü açar (14 gün içinde)
  const [selectedDay, setSelectedDay] = useState(() => {
    const offsets = tasks.filter((t) => t.dueAt && t.dueAt >= now).map((t) => daysUntil(t.dueAt, now)).filter((d) => d >= 0 && d < 14);
    return offsets.length ? Math.min(...offsets) : 0;
  });
  const issues = data.platforms.filter((p) => active && !p.paused && platformHealth(p, active).tone !== "cool");
  const upcoming = useMemo(
    () => tasks.filter((t) => t.dueAt && t.dueAt >= now).sort((a, b) => a.dueAt - b.dueAt),
    [tasks, now],
  );
  const todayCount = upcoming.filter((t) => daysUntil(t.dueAt, now) === 0).length;
  const weekCount = upcoming.filter((t) => daysUntil(t.dueAt, now) < WEEK).length;
  const published = (data.grades || []).filter((g) => g.status === "published").length;
  const recentFiles = (data.materials || []).filter((m) => m.publishedAt && now - m.publishedAt < WEEK * 86400000).length;

  return (
    <div className="space-y-12 lg:space-y-14">
      <header className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <div className="flex items-center gap-2">
            <span className="chip-ink">01</span>
            <Scramble className="tag" text={todayHeading(now)} delay={0.15} />
            <DrawRule dotted className="ml-1 hidden min-w-6 flex-1 sm:block" />
          </div>
          <h1 className="mt-5 max-w-[20ch] font-display text-[2.4rem] leading-[0.98] font-semibold tracking-[-0.045em] text-balance sm:text-[3.25rem] lg:text-[4rem]">
            <RevealText>{Headline({ active, issues, todayCount, weekCount })}</RevealText>
          </h1>
          <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
            <span className="inline-flex items-center gap-2">
              <span className={cn("size-1.5 rounded-full", working ? "live-dot bg-accent text-accent" : active ? "bg-cool" : "bg-ink-3")} />
              {working ? "Şu an kontrol ediliyor" : `Son kontrol ${relative(data.lastFullAt, now)}`}
            </span>
            {active && data.nextFullAt && !working && <span>· Sonraki {time(data.nextFullAt)}</span>}
          </p>
        </div>
        <Magnetic className="hidden w-fit lg:inline-flex">
          <Button size="lg" className="w-fit" icon={RefreshCw} busy={working || checkBusy} disabled={!active} onClick={onCheck}>
            {working ? "Kontrol ediliyor" : "Şimdi kontrol et"}
          </Button>
        </Magnetic>
      </header>

      {(!active || issues.length > 0) && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          role="status"
          className={cn(
            "flex flex-col gap-3 rounded-[1.25rem] border px-5 py-4 sm:flex-row sm:items-center",
            !active ? "border-rule bg-card" : issues.some((p) => p.error === "auth") ? "border-hot/30 bg-card" : "border-warm/30 bg-card",
          )}
        >
          {!active ? <PauseCircle className="size-5 shrink-0 text-ink-2" /> : <AlertTriangle className={cn("size-5 shrink-0", issues.some((p) => p.error === "auth") ? "text-hot" : "text-warm")} />}
          <p className="text-sm leading-relaxed">
            {!active
              ? "Siteler şu an kontrol edilmiyor. Yeni ödev ve notlardan haberin olmaz."
              : issues.map((p) => `${p.name}: ${platformHealth(p, active).label.toLocaleLowerCase("tr")}`).join(" · ") +
                ". Diğer platformlar normal çalışıyor."}
          </p>
          <Button variant="outline" size="sm" className="sm:ml-auto" onClick={() => navigate("siteler")}>
            Ayrıntılar
          </Button>
        </motion.div>
      )}

      <Reveal className="relative grid grid-cols-3 gap-y-4 border-y border-rule py-6">
        <CornerMarks />
        <Figure value={weekCount} label="Bu hafta" hint="yaklaşan teslim" />
        <Figure value={published} label="Açıklanan" hint="not kaydı" />
        <Figure value={recentFiles || (data.materials || []).length} label={recentFiles ? "Yeni dosya" : "Dosya"} hint={recentFiles ? "son 7 gün" : "takip ediliyor"} />
      </Reveal>

      <section aria-labelledby="agenda-title">
        <SectionTitle id="agenda-title" index="01" title="Ajanda" aside={<span className="text-xs text-ink-3">14 gün</span>} />
        <AgendaStrip tasks={tasks} selected={selectedDay} onSelect={setSelectedDay} now={now} />
        <div className="mt-6">
          <DayPanel offset={selectedDay} tasks={tasks} onOpen={onOpen} now={now} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.35fr_1fr]">
        <Card className="p-5 sm:p-7" aria-labelledby="next-title">
          <SectionTitle
            id="next-title"
            index="02"
            title="Sıradaki"
            aside={
              <button
                onClick={() => navigate("teslimler")}
                className="hit-area inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink-2 hover:text-ink"
              >
                Tüm teslimler <ArrowRight className="size-3.5" />
              </button>
            }
          />
          {upcoming.length ? (
            <DeadlineList tasks={upcoming.slice(0, 6)} onOpen={onOpen} now={now} />
          ) : (
            <p className="py-6 text-sm text-ink-3">Yaklaşan bir teslim görünmüyor.</p>
          )}
        </Card>
        <div className="space-y-6">
          <Card className="p-5 sm:p-7" aria-labelledby="feed-title">
            <SectionTitle
              id="feed-title"
              index="03"
              title="Son değişiklikler"
              aside={
                <button
                  onClick={() => navigate("bildirimler")}
                  className="hit-area inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink-2 hover:text-ink"
                >
                  Tümü <ArrowRight className="size-3.5" />
                </button>
              }
            />
            <ActivityFeed activity={data.activity.slice(0, 4)} compact />
          </Card>
          <Card className="p-5 sm:p-7" aria-labelledby="platforms-title">
            <SectionTitle
              id="platforms-title"
              index="04"
              title="Siteler"
              aside={
                <button
                  onClick={() => navigate("siteler")}
                  className="hit-area inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink-2 hover:text-ink"
                >
                  Yönet <ArrowRight className="size-3.5" />
                </button>
              }
            />
            <PlatformList platforms={data.platforms} active={active} />
          </Card>
        </div>
      </div>
    </div>
  );
}

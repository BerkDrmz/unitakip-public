import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  Bell,
  BookMarked,
  CalendarClock,
  ChevronRight,
  ClipboardCheck,
  FileText,
  GraduationCap,
  Mail,
  Megaphone,
  Sparkles,
} from "lucide-react";
import { daysUntil } from "../dates.js";
import { BUCKETS, bucketOf, clean, day, dayNumber, month, relative, shortWeekday, time, urgency, weekday } from "../lib/format.js";
import { platformHealth, platformLabel } from "../lib/meta.js";
import { cn } from "../lib/utils.js";
import { Chip, Empty, PlatformDot } from "./ui/primitives.jsx";

export const kindLabel = (kind) =>
  kind === "quiz" ? "Sınav" : kind === "assignment" ? "Ödev" : kind === "grade" ? "Not" : "Duyuru";
const KindIcon = ({ kind, className }) => {
  const Icon = kind === "quiz" ? ClipboardCheck : kind === "assignment" ? FileText : kind === "grade" ? GraduationCap : Megaphone;
  return <Icon className={className} aria-hidden strokeWidth={1.7} />;
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035 } },
};
const rise = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } },
};

/* ------------------------------------------------------------------ Ajanda şeridi */
export function AgendaStrip({ tasks, selected, onSelect, days = 14, now = Date.now() }) {
  const columns = useMemo(() => {
    const byDay = new Map();
    for (const t of tasks) {
      if (!t.dueAt || t.dueAt < now - 86400000) continue;
      const d = daysUntil(t.dueAt, now);
      if (d < 0 || d >= days) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }
    return Array.from({ length: days }, (_, i) => {
      const at = now + i * 86400000;
      return { offset: i, at, items: byDay.get(i) || [] };
    });
  }, [tasks, days, now]);

  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ol className="grid min-w-[46rem] grid-cols-14 gap-1.5" aria-label="Önümüzdeki 14 gün">
        {columns.map((c) => {
          const isToday = c.offset === 0;
          const isSelected = selected === c.offset;
          const weekend = ["Cmt", "Paz"].includes(shortWeekday(c.at));
          const hot = c.items.some((t) => urgency(t.dueAt, now).tone === "hot");
          return (
            <li key={c.offset}>
              <button
                onClick={() => onSelect(c.offset)}
                aria-pressed={isSelected}
                aria-label={`${dayNumber(c.at)} ${month(c.at)} ${weekday(c.at)}${c.items.length ? `, ${c.items.length} teslim` : ", teslim yok"}`}
                className={cn(
                  "group relative isolate flex h-[4.75rem] w-full flex-col items-center justify-between rounded-2xl px-1 pt-2 pb-1.5 transition-colors duration-300",
                  isSelected ? "text-paper" : isToday ? "ring-1 ring-rule-strong ring-inset hover:bg-wash" : "hover:bg-wash",
                )}
              >
                {isSelected && (
                  <motion.span
                    layoutId="agenda-selected"
                    aria-hidden
                    className="absolute inset-0 -z-10 rounded-2xl bg-ink"
                    transition={{ type: "spring", stiffness: 420, damping: 36 }}
                  />
                )}
                <span
                  className={cn(
                    "text-[0.6875rem] font-medium",
                    isSelected ? "text-paper/70" : "text-ink-3",
                  )}
                >
                  {isToday ? "Bugün" : shortWeekday(c.at)}
                </span>
                <span className={cn("text-xl leading-none font-semibold tabular", !isSelected && weekend && "text-ink-3")}>
                  {dayNumber(c.at)}
                </span>
                <span className="flex h-2 items-center gap-1" aria-hidden>
                  {c.items.slice(0, 3).map((t) => (
                    <span
                      key={t.id}
                      className={cn(
                        "size-1.5 rounded-full",
                        isSelected ? "bg-paper" : hot ? "bg-hot" : t.kind === "quiz" ? "bg-accent" : "bg-ink-2",
                      )}
                    />
                  ))}
                  {c.items.length > 3 && (
                    <span className={cn("text-[0.625rem] font-bold", isSelected ? "text-paper" : "text-ink-3")}>+{c.items.length - 3}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ Teslim satırı */
export function DeadlineRow({ task, onOpen, now = Date.now() }) {
  const u = urgency(task.dueAt, now);
  return (
    <motion.li variants={rise} layout="position">
      <button
        onClick={() => onOpen(task)}
        className={cn(
          // Dar ekranda süre etiketi başlığın altına iner; yan yana durunca başlığa yer kalmıyordu.
          "group row-sweep grid w-full grid-cols-[3.25rem_1fr] items-center gap-x-4 gap-y-2 rounded-2xl px-3 py-3.5 text-left sm:grid-cols-[3.75rem_1fr_auto_1.25rem] sm:gap-y-1 sm:px-4",
          u.past && "opacity-70",
        )}
      >
        <span className="row-span-2 flex flex-col items-center justify-center self-stretch border-r border-rule pr-3 sm:row-span-1 sm:self-auto sm:pr-4">
          {task.dueAt ? (
            <>
              <span className="font-display text-xl leading-none font-semibold tabular">{dayNumber(task.dueAt)}</span>
              <span className="mt-0.5 font-mono text-[0.625rem] tracking-[0.08em] text-ink-3 uppercase">{month(task.dueAt)}</span>
            </>
          ) : (
            <span className="font-display text-lg text-ink-3">—</span>
          )}
        </span>
        <span className="min-w-0">
          <span className="line-clamp-2 block font-medium break-words text-ink transition-transform duration-300 ease-[var(--ease-out)] group-hover:translate-x-1 sm:line-clamp-1">{clean(task.title)}</span>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-[0.8125rem] text-ink-3">
            <PlatformDot platform={task.platform} />
            <span className="truncate">{clean(task.course) || platformLabel(task.platform)}</span>
            <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
              <span aria-hidden>·</span>
              <KindIcon kind={task.kind} className="size-3.5" />
              {kindLabel(task.kind)}
            </span>
          </span>
        </span>
        <Chip tone={u.tone === "calm" ? "calm" : u.tone} className="col-start-2 justify-self-start sm:col-start-auto sm:justify-self-end">
          {u.label}
        </Chip>
        <ChevronRight className="hidden size-4 text-ink-3 transition-transform group-hover:translate-x-0.5 sm:block" aria-hidden />
      </button>
    </motion.li>
  );
}

export function DeadlineList({ tasks, onOpen, now = Date.now() }) {
  return (
    <motion.ul variants={stagger} initial="hidden" animate="show" className="-mx-1 divide-y divide-rule/60 sm:-mx-2">
      {tasks.map((t) => (
        <DeadlineRow key={t.id} task={t} onOpen={onOpen} now={now} />
      ))}
    </motion.ul>
  );
}

/** Zaman kovalarına göre gruplanmış ajanda listesi. */
export function DeadlineGroups({ tasks, onOpen, showPast = false, onTogglePast, now = Date.now() }) {
  const groups = useMemo(() => {
    const map = new Map(BUCKETS.map(([id]) => [id, []]));
    for (const t of tasks) map.get(bucketOf(t.dueAt, now)).push(t);
    for (const [id, list] of map)
      list.sort((a, b) => (id === "past" ? (b.dueAt || 0) - (a.dueAt || 0) : (a.dueAt || Infinity) - (b.dueAt || Infinity)));
    return BUCKETS.map(([id, label]) => ({ id, label, items: map.get(id) })).filter((g) => g.items.length);
  }, [tasks, now]);

  if (!tasks.length)
    return (
      <Empty icon={CalendarClock} title="Bu görünümde kayıt yok">
        Filtreleri değiştirebilirsin. Sitelerde yeni bir ödev veya sınav göründüğünde burada belirir.
      </Empty>
    );
  // Görünümde yalnızca tarihi geçmiş kayıt varsa (ör. tek site süzgeci) liste boş görünmesin diye açık gelir.
  const onlyPast = groups.length === 1 && groups[0].id === "past";
  return (
    <div className="space-y-8">
      {groups.map((g) =>
        g.id === "past" && !showPast && !onlyPast ? (
          <button
            key={g.id}
            onClick={onTogglePast}
            className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-rule-strong px-5 py-4 text-left text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            <span className="font-display text-[0.9375rem]">Tarihi geçenler</span>
            <span className="tabular text-ink-3">{g.items.length}</span>
            <span className="ml-auto text-[0.8125rem] font-medium">Göster</span>
          </button>
        ) : (
          <section key={g.id} aria-labelledby={`bucket-${g.id}`}>
            <div className="mb-1 flex items-baseline gap-3 px-1">
              <h2 id={`bucket-${g.id}`} className="font-display text-base font-semibold">
                {g.label}
              </h2>
              <span className="text-sm text-ink-3 tabular">{g.items.length}</span>
              <span className="rule-dashed h-px flex-1 self-center" aria-hidden />
              {g.id === "past" && !onlyPast && (
                <button onClick={onTogglePast} className="text-[0.8125rem] font-medium text-ink-3 hover:text-ink">
                  Gizle
                </button>
              )}
            </div>
            <DeadlineList tasks={g.items} onOpen={onOpen} now={now} />
          </section>
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Akış */
function ActivityIcon({ entry }) {
  const Icon =
    entry.type === "test"
      ? Mail
      : entry.category === "grade"
        ? GraduationCap
        : entry.category === "exam"
          ? ClipboardCheck
          : entry.category === "material"
            ? BookMarked
            : entry.type === "notice"
              ? Bell
              : Sparkles;
  const tone =
    entry.category === "grade"
      ? "bg-cool-soft text-cool"
      : entry.category === "exam"
        ? "bg-accent-soft text-accent"
        : entry.type === "notice"
          ? "bg-warm-soft text-warm"
          : "bg-wash text-ink-2";
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-2xl", tone)}>
      <Icon className="size-[1.05rem]" strokeWidth={1.8} aria-hidden />
    </span>
  );
}

export function ActivityFeed({ activity, compact = false }) {
  if (!activity.length)
    return (
      <Empty icon={Bell} title="Şimdilik sessiz" className={compact ? "py-8" : undefined}>
        Bir şey değiştiğinde burada ve e-posta kutunda görünecek.
      </Empty>
    );
  return (
    <motion.ol variants={stagger} initial="hidden" animate="show" className="relative space-y-1">
      {activity.map((e) => (
        <motion.li key={e.id} variants={rise} className="flex gap-3.5 rounded-2xl px-2 py-3">
          <ActivityIcon entry={e} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm leading-snug font-medium">{clean(e.title)}</p>
              <time className="shrink-0 text-xs text-ink-3 tabular" dateTime={e.sentAt ? new Date(e.sentAt).toISOString() : undefined}>
                {compact ? relative(e.sentAt) : time(e.sentAt)}
              </time>
            </div>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
              {e.platform && e.platform !== "system" && <PlatformDot platform={e.platform} />}
              <span className="truncate">
                {platformLabel(e.platform)}
                {e.course ? ` · ${clean(e.course)}` : ""}
              </span>
            </p>
            {e.detail && !compact && (
              <p className="mt-2 rounded-2xl border-l-2 border-rule-strong bg-wash/60 px-3 py-2 text-[0.8125rem] leading-relaxed whitespace-pre-line text-ink-2 tabular">
                {clean(e.detail)}
              </p>
            )}
          </div>
        </motion.li>
      ))}
    </motion.ol>
  );
}

/* ------------------------------------------------------------------ Platform listesi */
export function PlatformList({ platforms, active }) {
  return (
    <ul className="divide-y divide-rule/70">
      {platforms.map((p) => {
        const h = platformHealth(p, active);
        return (
          <li key={p.id} className="flex items-center gap-3 py-3.5">
            <PlatformDot platform={p.id} className="size-2.5" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{p.name}</p>
              <p className="text-xs text-ink-3">
                {p.lastSuccess ? `Son kontrol ${relative(p.lastSuccess)}` : "Henüz kontrol edilmedi"}
                {p.partialCount ? ` · ${p.partialCount} bölüm eksik` : ""}
              </p>
            </div>
            <Chip tone={h.tone} dot>
              {h.label}
            </Chip>
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`${p.name} sitesini aç`}
              className="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-wash hover:text-ink"
            >
              <ArrowUpRight className="size-4" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function DayPanel({ offset, tasks, onOpen, now = Date.now() }) {
  const at = now + offset * 86400000;
  const items = tasks
    .filter((t) => t.dueAt && t.dueAt >= now - 86400000 && daysUntil(t.dueAt, now) === offset)
    .sort((a, b) => a.dueAt - b.dueAt);
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={offset}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.2 }}
      >
        <p className="mb-1 px-1 text-sm text-ink-3">
          <span className="font-display text-[0.9375rem] text-ink">{offset === 0 ? "Bugün" : offset === 1 ? "Yarın" : weekday(at)}</span>
          {"  "}· {day(at)} · {items.length ? `${items.length} teslim` : "teslim yok"}
        </p>
        {items.length ? (
          <DeadlineList tasks={items} onOpen={onOpen} now={now} />
        ) : (
          <p className="rounded-2xl border border-dashed border-rule px-4 py-5 text-sm text-ink-3">
            Bu gün için takip edilen bir teslim yok.
          </p>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

import { useState } from "react";
import { ArrowUpRight, CalendarClock, Mail } from "lucide-react";
import { Button, Chip, PlatformDot, Sheet, buttonVariants } from "./ui/primitives.jsx";
import { kindLabel } from "./agenda.jsx";
import { clean, longDay, time, urgency } from "../lib/format.js";
import { platformLabel, siteList } from "../lib/meta.js";
import { cn } from "../lib/utils.js";

export function TaskSheet({ task, onClose, now = Date.now() }) {
  const u = urgency(task.dueAt, now);
  const isGrade = task.kind === "grade";
  const fields = Object.entries(task.fields || {}).filter(([, v]) => clean(v).trim());
  return (
    <Sheet
      title={clean(task.title)}
      onClose={onClose}
      eyebrow={
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="calm">
            <PlatformDot platform={task.platform} />
            {platformLabel(task.platform)}
          </Chip>
          <Chip tone="calm">{kindLabel(task.kind)}</Chip>
          {!isGrade && task.dueAt && <Chip tone={u.tone}>{u.label}</Chip>}
        </div>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Kapat
          </Button>
          {task.url && (
            <a href={task.url} target="_blank" rel="noreferrer" className={buttonVariants()}>
              Platformda aç <ArrowUpRight className="size-4" />
            </a>
          )}
        </>
      }
    >
      {task.course && <p className="-mt-1 mb-5 text-[0.9375rem] text-ink-2">{clean(task.course)}</p>}
      {!isGrade && (
        <div className="mb-5 flex items-center gap-4 rounded-2xl bg-wash/70 px-4 py-3.5">
          <CalendarClock className="size-5 shrink-0 text-ink-3" strokeWidth={1.7} />
          <div>
            <p className="text-xs text-ink-3">Son tarih</p>
            <p className="font-display text-[0.9375rem] font-semibold">
              {task.dueAt ? `${longDay(task.dueAt)} · ${time(task.dueAt)}` : "Platformda tarih belirtilmemiş"}
            </p>
          </div>
        </div>
      )}
      {fields.length > 0 && (
        <dl className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-rule bg-rule sm:grid-cols-3">
          {fields.slice(0, 18).map(([k, v]) => (
            <div key={k} className="bg-card px-4 py-3">
              <dt className="truncate text-xs text-ink-3">{clean(k)}</dt>
              <dd className={cn("mt-0.5 font-display text-[0.9375rem] font-semibold tabular", isGrade ? "truncate" : "break-words")} title={clean(v)}>
                {clean(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {task.body ? (
        <p className="max-h-72 overflow-y-auto text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-2">{clean(task.body)}</p>
      ) : (
        !fields.length && <p className="text-sm text-ink-3">Ek açıklama yok. Ayrıntılar kaynak platformda.</p>
      )}
      <p className="mt-5 text-xs leading-relaxed text-ink-3">
        {isGrade ? "Notlar kaynak platformda son okunan kaydı gösterir." : "Teslim ve katılım durumunu kaynak platformdan doğrula."}
      </p>
    </Sheet>
  );
}

export function TestMailSheet({ email, onClose, onSend }) {
  const [choice, setChoice] = useState(() => (siteList().filter((s) => !s.paused).length > 1 ? "all" : siteList()[0]?.id || "all"));
  const [busy, setBusy] = useState(false);
  const sites = siteList().filter((site) => !site.paused);
  const options = [
    ...(sites.length > 1 ? [["all", "Tüm siteler", `${sites.length} deneme e-postası`]] : []),
    ...sites.map((site) => [site.id, site.name, "1 deneme e-postası"]),
  ];
  return (
    <Sheet
      title="Bir deneme gönderelim."
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            icon={Mail}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await onSend(choice);
              setBusy(false);
            }}
          >
            Gönder
          </Button>
        </>
      }
    >
      <p className="mb-5 text-[0.9375rem] leading-relaxed text-ink-2">
        Konusu <strong className="font-semibold text-ink">[DENEME]</strong> ile başlayan bir e-posta gelir. Gerçek kayıtların değişmez.
      </p>
      <fieldset>
        <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">Hangi siteden?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map(([id, label, hint]) => (
            <label
              key={id}
              className={cn(
                "flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors",
                choice === id ? "border-ink bg-card shadow-[0_0_0_3px_var(--accent-soft)]" : "border-rule hover:border-ink-3",
              )}
            >
              <input type="radio" name="test-platform" value={id} checked={choice === id} onChange={() => setChoice(id)} className="sr-only" />
              {id === "all" ? (
                <span className="flex -space-x-1" aria-hidden>
                  {sites.slice(0, 4).map((site) => (
                    <PlatformDot key={site.id} platform={site.id} className="ring-2 ring-card" />
                  ))}
                </span>
              ) : (
                <PlatformDot platform={id} />
              )}
              <span>
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block text-xs text-ink-3">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-5 flex items-center gap-2 truncate rounded-2xl bg-wash px-3 py-2.5 text-sm">
        <Mail className="size-4 shrink-0 text-ink-3" />
        <span className="truncate">{email}</span>
      </p>
    </Sheet>
  );
}

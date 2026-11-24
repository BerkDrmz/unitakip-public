import { useMemo, useState } from "react";
import { Mail, MailCheck } from "lucide-react";
import { ActivityFeed } from "../components/agenda.jsx";
import { Button, Card, Segmented } from "../components/ui/primitives.jsx";
import { longDay } from "../lib/format.js";
import { daysUntil } from "../dates.js";
import { PageHeader } from "./page-header.jsx";

const FILTERS = [
  ["all", "Tümü"],
  ["grade", "Notlar"],
  ["exam", "Sınavlar"],
  ["material", "Dosyalar"],
  ["system", "Sistem"],
];

function dayLabel(at, now) {
  const d = daysUntil(at, now);
  return d === 0 ? "Bugün" : d === -1 ? "Dün" : longDay(at);
}

export function ActivityPage({ data, onTestMail, now }) {
  const [filter, setFilter] = useState("all");
  const groups = useMemo(() => {
    const list = data.activity.filter((e) =>
      filter === "all"
        ? true
        : filter === "system"
          ? e.platform === "system" || e.type === "notice" || e.type === "test"
          : e.category === filter,
    );
    const map = new Map();
    for (const e of list) {
      const key = e.sentAt ? dayLabel(e.sentAt, now) : "Tarihsiz";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return [...map.entries()];
  }, [data.activity, filter, now]);

  return (
    <>
      <PageHeader eyebrow="Gelen kutun" title="Bildirimler">
        E-postana gönderilen her değişiklik burada, gün gün. Aynı içerik iki kez gönderilmez.
      </PageHeader>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div>
          <div className="no-scrollbar -mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <Segmented label="Bildirim türü" layoutId="activity-filter" value={filter} onChange={setFilter} options={FILTERS} />
          </div>
          {groups.length ? (
            <div className="space-y-8">
              {groups.map(([label, items]) => (
                <section key={label} aria-label={label}>
                  <div className="mb-1 flex items-baseline gap-3 px-1">
                    <h2 className="font-display text-base font-semibold">{label}</h2>
                    <span className="text-sm text-ink-3 tabular">{items.length}</span>
                    <span className="rule-dashed h-px flex-1 self-center" aria-hidden />
                  </div>
                  <ActivityFeed activity={items} />
                </section>
              ))}
            </div>
          ) : (
            <ActivityFeed activity={[]} />
          )}
        </div>
        <Card as="aside" className="p-6 lg:sticky lg:top-8">
          <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
            <MailCheck className="size-5" strokeWidth={1.7} />
          </span>
          <h2 className="mt-5 font-display text-lg leading-tight font-semibold">Bir şey değişirse, haberin olur.</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Yeni ödevler, dosyalar, not değişiklikleri ve bağlantı uyarıları şu adrese gelir:
          </p>
          <p className="mt-3 truncate rounded-2xl bg-wash px-3 py-2.5 text-sm font-semibold" title={data.profile.email}>
            {data.profile.email}
          </p>
          <p className="mt-4 flex items-center gap-2 text-xs text-ink-3">
            <span className={data.pending ? "size-1.5 rounded-full bg-warm" : "size-1.5 rounded-full bg-cool"} />
            {data.pending ? `${data.pending} bildirim gönderilmeyi bekliyor` : "Bekleyen bildirim yok"}
          </p>
          <Button variant="outline" className="mt-6 w-full" icon={Mail} onClick={onTestMail}>
            Deneme e-postası gönder
          </Button>
        </Card>
      </div>
    </>
  );
}

import { useMemo, useState } from "react";
import { DeadlineGroups } from "../components/agenda.jsx";
import { FilterChips, SearchField, Segmented } from "../components/ui/primitives.jsx";
import { search } from "../lib/format.js";
import { platformOptions } from "../lib/meta.js";
import { PageHeader, Toolbar } from "./page-header.jsx";


export function DeadlinesPage({ tasks, onOpen, now, initialQuery = "" }) {
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [showPast, setShowPast] = useState(true);

  const counts = useMemo(
    () => ({
      all: tasks.length,
      assignment: tasks.filter((t) => t.kind === "assignment").length,
      exam: tasks.filter((t) => t.kind !== "assignment").length,
    }),
    [tasks],
  );
  const { filtered, partial } = useMemo(() => {
    const terms = [...new Set(search(query).trim().split(/\s+/).filter(Boolean))];
    const matches = [], close = [];
    for (const task of tasks) {
      if (platform !== "all" && platform !== task.platform) continue;
      if (kind !== "all" && (kind === "assignment") !== (task.kind === "assignment")) continue;
      const value = search([task.title, task.course, task.body, ...Object.values(task.fields || {})].join(" "));
      const hitCount = terms.filter(term => value.includes(term)).length;
      if (hitCount === terms.length) matches.push(task);
      else if (terms.length >= 2 && hitCount === terms.length - 1) close.push(task);
    }
    if (!matches.length && close.length) return { filtered: close, partial: true };
    return { filtered: matches, partial: false };
  }, [tasks, kind, platform, query]);
  const past = filtered.filter(t => t.dueAt && t.dueAt < now).length;

  return (
    <>
      <PageHeader eyebrow="Ödevler ve sınavlar" title={<>Teslimler</>}>
        {filtered.length} ödev ve sınav listeleniyor. {past} kaydın teslim tarihi geçti.
      </PageHeader>
      <Toolbar>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <SearchField value={query} onChange={setQuery} placeholder="Ödev, sınav veya ders ara" className="md:max-w-sm md:flex-1" />
          <Segmented
            label="Tür"
            layoutId="deadline-kind"
            value={kind}
            onChange={setKind}
            options={[
              ["all", "Tümü", counts.all],
              ["assignment", "Ödev", counts.assignment],
              ["exam", "Sınav", counts.exam],
            ]}
          />
        </div>
        <FilterChips label="Site" value={platform} onChange={setPlatform} options={platformOptions()} />
      </Toolbar>
      {partial && <p role="status" className="mb-4 text-sm text-ink-2">Tam eşleşme bulunamadı. Aradığın sözcüklerin bir kısmını içeren kayıtlar gösteriliyor.</p>}
      <DeadlineGroups tasks={filtered} onOpen={onOpen} showPast={showPast} onTogglePast={() => setShowPast((v) => !v)} now={now} />
    </>
  );
}

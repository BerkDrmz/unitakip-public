import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, ChevronDown, Download, FolderOpen } from "lucide-react";
import { Chip, Empty, FilterChips, PlatformDot, SearchField, Segmented } from "../components/ui/primitives.jsx";
import { clean, fileSize, search } from "../lib/format.js";
import { platformLabel, platformOptions } from "../lib/meta.js";
import { cn } from "../lib/utils.js";
import { PageHeader, Toolbar } from "./page-header.jsx";

const SLIDES = ["ppt", "pptx", "odp", "key"];
const typeOf = (ext) => (ext === "pdf" ? "pdf" : SLIDES.includes(ext) ? "slides" : "other");
const PREVIEW_COUNT = 6;

function FileTile({ ext }) {
  const t = typeOf(ext);
  return (
    <span
      className={cn(
        "relative grid h-12 w-10 shrink-0 place-items-end rounded-[0.6rem] pb-1.5 text-[0.5625rem] font-bold tracking-wider uppercase",
        t === "pdf" ? "bg-hot-soft text-hot" : t === "slides" ? "bg-warm-soft text-warm" : "bg-wash text-ink-2",
      )}
      aria-hidden
    >
      <span className="absolute top-0 right-0 size-3 rounded-bl-[0.4rem] bg-paper/70" />
      <span className="mx-auto">{(ext || "dosya").slice(0, 4)}</span>
    </span>
  );
}

function CourseGroup({ course, items, now }) {
  const [open, setOpen] = useState(false);
  const visible = open ? items : items.slice(0, PREVIEW_COUNT);
  return (
    <section aria-label={course}>
      <div className="mb-1 flex items-baseline gap-3 px-1">
        <h2 className="font-display text-base font-semibold">{course}</h2>
        <span className="text-sm text-ink-3 tabular">{items.length}</span>
        <span className="rule-dashed h-px flex-1 self-center" aria-hidden />
      </div>
      <motion.ul layout className="divide-y divide-rule/60">
        {visible.map((m) => {
          const fresh = m.publishedAt && now - m.publishedAt < 7 * 86400000;
          return (
            <motion.li layout="position" key={m.id}>
              <a
                // Doğrudan inen dosyalar (Moodle) bulut üzerinden gelir; diğerleri kaynak sitede açılır.
                href={m.download || m.url}
                {...(m.download ? { download: clean(m.title) } : { target: "_blank", rel: "noreferrer" })}
                className="group flex items-center gap-4 rounded-2xl px-2 py-3 transition-colors hover:bg-wash/70 sm:px-3"
              >
                <FileTile ext={m.extension} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{clean(m.title)}</span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                    <PlatformDot platform={m.platform} />
                    {platformLabel(m.platform)}
                    {fileSize(m.size) && <span>· {fileSize(m.size)}</span>}
                    {m.opensSource && <span className="hidden sm:inline">· platformda açılır</span>}
                    {m.download && <span className="hidden sm:inline">· doğrudan iner</span>}
                  </span>
                </span>
                {fresh && <Chip tone="accent">Yeni</Chip>}
                {m.download ? (
                  <Download className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-y-0.5" aria-label="İndir" />
                ) : (
                  <ArrowUpRight
                    className="size-4 shrink-0 text-ink-3 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                    aria-label="Yeni sekmede aç"
                  />
                )}
              </a>
            </motion.li>
          );
        })}
      </motion.ul>
      {items.length > PREVIEW_COUNT && (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 ml-1 inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[0.8125rem] font-semibold text-ink-2 hover:bg-wash hover:text-ink"
        >
          {open ? "Daha az göster" : `${items.length - PREVIEW_COUNT} dosya daha`}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </section>
  );
}

export function FilesPage({ data, now }) {
  const materials = data.materials || [];
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [platform, setPlatform] = useState("all");
  const counts = useMemo(
    () => ({
      all: materials.length,
      pdf: materials.filter((m) => typeOf(m.extension) === "pdf").length,
      slides: materials.filter((m) => typeOf(m.extension) === "slides").length,
      other: materials.filter((m) => typeOf(m.extension) === "other").length,
    }),
    [materials],
  );
  const groups = useMemo(() => {
    const q = search(query);
    const map = new Map();
    for (const m of materials) {
      if (type !== "all" && typeOf(m.extension) !== type) continue;
      if (platform !== "all" && m.platform !== platform) continue;
      if (q && !search(`${m.title} ${m.course}`).includes(q)) continue;
      const course = clean(m.course).trim() || "Ders bilgisi olmayan dosyalar";
      if (!map.has(course)) map.set(course, []);
      map.get(course).push(m);
    }
    for (const list of map.values()) list.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0) || clean(a.title).localeCompare(clean(b.title), "tr", { numeric: true }));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "tr"));
  }, [materials, type, platform, query]);
  const total = groups.reduce((n, [, list]) => n + list.length, 0);

  return (
    <>
      <PageHeader eyebrow="Ders materyalleri" title="Dosyalar">
        Takip edilen sitelerdeki sunumlar ve dokümanlar, derslere göre. İndirme simgeli dosyalar doğrudan buradan iner; diğerleri kaynak platformda açılır ve orada giriş yapman gerekebilir.
      </PageHeader>
      <Toolbar>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <SearchField value={query} onChange={setQuery} placeholder="Dosya veya ders ara" className="md:max-w-sm md:flex-1" />
          <Segmented
            label="Dosya türü"
            layoutId="file-type"
            value={type}
            onChange={setType}
            options={[
              ["all", "Tümü", counts.all],
              ["pdf", "PDF", counts.pdf],
              ["slides", "Sunum", counts.slides],
              ["other", "Diğer", counts.other],
            ]}
          />
        </div>
        <FilterChips label="Site" value={platform} onChange={setPlatform} options={platformOptions()} />
      </Toolbar>
      {total ? (
        <div className="space-y-10">
          {groups.map(([course, items]) => (
            <CourseGroup key={course} course={course} items={items} now={now} />
          ))}
        </div>
      ) : (
        <Empty icon={FolderOpen} title="Bu görünümde dosya yok">
          Yeni yüklenen sunum ve dokümanlar takip edilir; burada ve e-posta kutunda görünür.
        </Empty>
      )}
    </>
  );
}

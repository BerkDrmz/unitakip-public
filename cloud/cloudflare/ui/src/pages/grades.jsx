import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ChevronRight, GraduationCap } from "lucide-react";
import { groupByCourse } from "../grade-groups.js";
import { Card, Chip, Empty, FilterChips, PlatformDot, SearchField, Segmented } from "../components/ui/primitives.jsx";
import { clean, search } from "../lib/format.js";
import { platformLabel, platformOptions } from "../lib/meta.js";
import { cn } from "../lib/utils.js";
import { PageHeader, Toolbar } from "./page-header.jsx";

const isBlank = (v) => !v || ["-", "—", "–"].includes(String(v).trim());

function GradeEntry({ entry, onOpen }) {
  const blank = isBlank(entry.value);
  return (
    <li>
      <button
        onClick={() => onOpen(entry.record)}
        className="group flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-wash/70"
        aria-label={`${entry.label}: ${blank ? "henüz açıklanmadı" : clean(entry.value)} — ayrıntıyı aç`}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{clean(entry.label)}</span>
        {blank ? (
          <Chip tone={entry.status === "record" ? "calm" : "idle"}>{entry.status === "record" ? "Kayıt" : "Bekleniyor"}</Chip>
        ) : entry.value ? (
          <span className="font-display text-lg leading-none font-semibold tabular">{clean(entry.value)}</span>
        ) : (
          <span className="text-[0.8125rem] font-medium text-ink-3">Ayrıntı</span>
        )}
        <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </button>
    </li>
  );
}

function UbysExamTable({ entries, onOpen }) {
  const extra = ["Standart Sapma", "Harf Notu Aralığı"].filter(key =>
    entries.some(({ record }) => !isBlank(record.fields[key])),
  );
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs tabular" aria-label="ÜBYS sınav sonuçları">
        <thead className="border-y border-rule bg-wash/60 text-ink-2">
          <tr>{["Sınav", "Not", "Mazeret", "Sınıf Ortalaması", ...extra].map(label => (
            <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-rule/60">
          {entries.map(({ record, id, label, value, status }) => (
            <tr key={id}>
              <th scope="row" className="px-2 py-3 font-medium">
                <button className="text-left underline-offset-4 hover:underline" onClick={() => onOpen(record)}>
                  {clean(record.fields["Sınav Adı"] || label)}
                </button>
                <span className={cn("mt-1 block text-[0.6875rem] font-normal", status === "published" ? "text-cool" : "text-ink-3")}>
                  {status === "published" ? "İlan Edildi" : record.surveyRequired ? "İlan bilgisi kapalı" : "İlan bekleniyor"}
                </span>
              </th>
              <td className="px-2 py-3 font-semibold">{/^(?:girmedi|gr)$/i.test(value || "") ? "Girmedi (GR)" : clean(value) || "—"}</td>
              {["Mazeret", "Sınıf Ortalaması", ...extra].map(key => (
                <td key={key} className="px-2 py-3">{isBlank(record.fields[key]) ? "—" : clean(record.fields[key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {entries.some(({ record }) => record.surveyRequired) && (
        <p className="mt-2 px-2 text-xs text-ink-2">Güncel sınav ayrıntılarını görmek için ÜBYS’de ders anketini tamamla.</p>
      )}
    </div>
  );
}

export function GradesPage({ data, onOpen }) {
  const grades = data.grades || [];
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [platform, setPlatform] = useState("all");

  const counts = useMemo(
    () => ({
      all: grades.length,
      published: grades.filter((g) => g.status === "published").length,
      pending: grades.filter((g) => g.status === "pending").length,
    }),
    [grades],
  );
  const courses = useMemo(() => {
    const q = search(query);
    return groupByCourse(
      grades.filter(
        (g) =>
          (status === "all" || g.status === status) &&
          (platform === "all" || g.platform === platform) &&
          (!q || search(`${g.title} ${g.course}`).includes(q)),
      ),
    );
  }, [grades, status, platform, query]);

  return (
    <>
      <PageHeader eyebrow="Sonuçlar" title="Notlar">
        {counts.published} açıklanmış, {counts.pending} bekleyen not kaydı. Yeni bir not açıklandığında e-posta ile haber verilir.
      </PageHeader>
      <Toolbar>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <SearchField value={query} onChange={setQuery} placeholder="Ders veya sınav ara" className="md:max-w-sm md:flex-1" />
          <Segmented
            label="Durum"
            layoutId="grade-status"
            value={status}
            onChange={setStatus}
            options={[
              ["all", "Tümü", counts.all],
              ["published", "Açıklanan", counts.published],
              ["pending", "Bekleyen", counts.pending],
            ]}
          />
        </div>
        <FilterChips label="Site" value={platform} onChange={setPlatform} options={platformOptions()} />
      </Toolbar>
      {courses.length ? (
        <motion.div
          className="columns-1 gap-5 md:columns-2 [&>*]:mb-5"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.04 } } }}
        >
          {courses.map((c) => {
            const exams = c.entries.filter(e => e.record.ubysExam);
            const others = c.entries.filter(e => !e.record.ubysExam);
            const published = c.entries.filter(e => e.status === "published").length;
            return (
              <motion.div
                key={c.id}
                className="break-inside-avoid"
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
              >
                <Card as="article" className="p-4 sm:p-5">
                  <header className="mb-2 flex items-start gap-3 px-3 pt-1">
                    <div className="min-w-0 flex-1">
                      <h2 className="font-display text-base leading-snug font-semibold text-balance">{clean(c.course)}</h2>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
                        <PlatformDot platform={c.platform} />
                        {platformLabel(c.platform)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "mt-1 shrink-0 text-xs font-semibold tabular",
                        published === c.entries.length ? "text-cool" : "text-ink-3",
                      )}
                    >
                      {published}/{c.entries.length}
                    </span>
                  </header>
                  {exams.length > 0 && <UbysExamTable entries={exams} onOpen={onOpen} />}
                  <ul className="divide-y divide-rule/60">
                    {others.map((e) => (
                      <GradeEntry key={e.id} entry={e} onOpen={onOpen} />
                    ))}
                  </ul>
                </Card>
              </motion.div>
            );
          })}
        </motion.div>
      ) : (
        <Empty icon={GraduationCap} title="Bu görünümde not yok">
          Notlar sitelerde yayımlandıkça ve kontrol edildikçe burada görünür.
        </Empty>
      )}
    </>
  );
}

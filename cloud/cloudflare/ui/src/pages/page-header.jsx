import { cn } from "../lib/utils.js";
import { DrawRule, Reveal, RevealText, Scramble } from "../components/motion.jsx";
import { ROUTES } from "../lib/meta.js";

/** Geçerli sayfanın menüdeki sırası ("02"); bağlantıyla açılan gizli sayfalarda "—". */
function pageIndex() {
  const id = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "bugun";
  const at = ROUTES.findIndex((r) => r.id === id);
  return at >= 0 ? String(at + 1).padStart(2, "0") : "—";
}

export function PageHeader({ eyebrow, title, children, actions, className }) {
  const index = pageIndex();
  return (
    <header className={cn("mb-10 lg:mb-14", className)}>
      <div className="flex items-center gap-2">
        <span className="chip-ink">{index}</span>
        {eyebrow && <Scramble className="tag" text={eyebrow} delay={0.15} />}
        <DrawRule dotted className="ml-1 min-w-6 flex-1" />
        <span className="font-mono text-[0.6875rem] text-ink-3 tabular">
          {index} / {String(ROUTES.length).padStart(2, "0")}
        </span>
      </div>
      <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[2.4rem] leading-[0.98] font-semibold tracking-[-0.045em] text-balance sm:text-[3.25rem] lg:text-[3.75rem]">
            <RevealText>{title}</RevealText>
          </h1>
          {children && (
            <Reveal as="p" delay={0.25} y={10} className="mt-4 max-w-xl text-[0.9375rem] leading-relaxed text-ink-2">
              {children}
            </Reveal>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Toolbar({ children, className }) {
  return (
    <div
      className={cn(
        "sticky top-16 z-20 -mx-4 mb-6 flex flex-col gap-3 border-b border-rule/70 bg-paper/88 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 lg:top-0 lg:mx-0 lg:rounded-b-[1.25rem] lg:border-x lg:px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

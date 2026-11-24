import { forwardRef, useEffect, useId, useRef } from "react";
import { cva } from "class-variance-authority";
import { motion } from "motion/react";
import { LoaderCircle, Search, X } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { platformColor } from "../../lib/meta.js";
import { DrawRule } from "../motion.jsx";

/* ---------------------------------------------------------------- Button */
export const buttonVariants = cva(
  "relative isolate inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl font-medium whitespace-nowrap select-none transition-[background-color,color,border-color,transform] duration-150 ease-[var(--ease-soft)] active:scale-[0.98] before:absolute before:inset-0 before:-z-10 before:translate-y-[101%] before:transition-transform before:duration-500 before:ease-[var(--ease-out)] hover:before:translate-y-0 disabled:before:hidden disabled:opacity-55 disabled:active:scale-100 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-ink text-paper before:bg-accent hover:text-on-accent",
        accent: "bg-accent text-on-accent before:bg-ink hover:text-paper",
        outline: "border border-rule bg-card text-ink before:bg-wash",
        ghost: "text-ink-2 before:hidden hover:bg-wash hover:text-ink",
        danger: "text-hot before:hidden hover:bg-hot-soft",
      },
      size: {
        sm: "h-9 px-3.5 text-[0.8125rem]",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-5 text-[0.9375rem]",
        icon: "size-10",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export const Button = forwardRef(function Button(
  { className, variant, size, busy = false, disabled, icon: Icon, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle className="spin size-4" aria-hidden /> : Icon ? <Icon className="size-4" aria-hidden /> : null}
      {children}
    </button>
  );
});

/* ---------------------------------------------------------------- Chip / Badge */
export const chipVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full font-mono text-[0.6875rem] font-medium tracking-[0.04em] whitespace-nowrap uppercase tabular",
  {
    variants: {
      tone: {
        hot: "bg-hot-soft text-hot",
        warm: "bg-warm-soft text-warm",
        cool: "bg-cool-soft text-cool",
        calm: "bg-wash text-ink-2",
        accent: "bg-accent-soft text-accent",
        past: "bg-transparent text-ink-3 ring-1 ring-inset ring-rule",
        none: "bg-transparent text-ink-3 ring-1 ring-inset ring-rule",
        idle: "bg-wash text-ink-3",
      },
      size: { sm: "h-6 px-2.5", md: "h-7 px-3" },
    },
    defaultVariants: { tone: "calm", size: "sm" },
  },
);
export function Chip({ tone, size, className, children, dot = false, ...props }) {
  return (
    <span className={cn(chipVariants({ tone, size }), className)} {...props}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function PlatformDot({ platform, className }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: platformColor(platform) }}
      aria-hidden
    />
  );
}

/* ---------------------------------------------------------------- Segmented */
export function Segmented({ value, onChange, options, label, className, layoutId }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-full bg-wash p-1", className)}>
      {options.map(([id, text, count]) => {
        const selected = value === id;
        return (
          <button
            key={id}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(id)}
            className={cn(
              "relative h-8 rounded-full px-3.5 text-[0.8125rem] font-medium transition-colors duration-300 pointer-coarse:h-10",
              selected ? "text-ink" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {selected && (
              <motion.span
                layoutId={layoutId || `seg-${label}`}
                className="absolute inset-0 rounded-full bg-card shadow-[0_1px_3px_var(--shadow-tint)]"
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {text}
              {count !== undefined && <span className="tabular text-ink-3">{count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- SearchField */
export function SearchField({ value, onChange, placeholder, className }) {
  return (
    <label
      className={cn(
        "group flex h-11 min-w-0 items-center gap-2.5 rounded-full border border-rule bg-card px-4 transition-colors focus-within:border-ink-3",
        className,
      )}
    >
      <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Aramayı temizle"
          className="-mr-1.5 grid size-7 place-items-center rounded-full text-ink-3 hover:bg-wash hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
}

/* ---------------------------------------------------------------- FilterChips (platform) */
export function FilterChips({ value, onChange, options, label }) {
  if (options.length <= 2) return null; // tek site: platform süzgecine gerek yok
  return (
    <div role="group" aria-label={label} className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
      {options.map(([id, text, dotPlatform]) => {
        const selected = value === id;
        return (
          <button
            key={id}
            aria-pressed={selected}
            onClick={() => onChange(id)}
            className={cn(
              "flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[0.8125rem] font-medium transition-colors duration-300 pointer-coarse:h-10",
              selected ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-2 hover:bg-wash hover:text-ink",
            )}
          >
            {dotPlatform && <PlatformDot platform={dotPlatform} className={selected ? "ring-2 ring-paper/40" : ""} />}
            {text}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- Switch */
export function Switch({ checked, onChange, label, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "hit-area inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50",
        checked ? "bg-ink" : "bg-rule-strong",
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 600, damping: 38 }}
        className={cn("block size-[1.125rem] rounded-full bg-paper shadow-sm", checked ? "ml-[1.1875rem]" : "ml-[0.1875rem]")}
      />
    </button>
  );
}

/* ---------------------------------------------------------------- Card & section */
export function Card({ as: Tag = "section", className, children, reveal = true, ...props }) {
  const Motion = motion[Tag] || motion.section;
  if (!reveal) return <Tag className={cn("rounded-[1.25rem] border border-rule/70 bg-card", className)} {...props}>{children}</Tag>;
  return (
    <Motion
      className={cn("rounded-[1.25rem] border border-rule/70 bg-card", className)}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -6% 0px" }}
      transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}
      {...props}
    >
      {children}
    </Motion>
  );
}

export function SectionTitle({ index, title, aside, className, id }) {
  return (
    <div className={cn("mb-5 flex items-center gap-3", className)}>
      <h2 id={id} className="flex shrink-0 items-baseline gap-2.5">
        {index && <span className="font-mono text-[0.6875rem] text-ink-3 tabular">[{index}]</span>}
        <span className="text-lg leading-none font-semibold tracking-[-0.025em]">{title}</span>
      </h2>
      <DrawRule dotted className="min-w-4 flex-1" />
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}

export function Empty({ icon: Icon, title, children, className }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      {Icon && (
        <span className="mb-3 grid size-12 place-items-center rounded-2xl bg-wash text-ink-3">
          <Icon className="size-5" strokeWidth={1.75} aria-hidden />
        </span>
      )}
      <p className="text-[0.9375rem] font-semibold">{title}</p>
      {children && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-3">{children}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- Sheet (native dialog) */
export function Sheet({ title, eyebrow, onClose, children, footer }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.__lenis?.stop(); // yumuşak kaydırma açıkken arka sayfa kaymasın
    return () => {
      document.body.style.overflow = prev;
      window.__lenis?.start();
      el.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="sheet"
      data-lenis-prevent
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[1.75rem] border border-rule bg-card shadow-float sm:rounded-[1.75rem]"
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-rule-strong sm:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 sm:px-7 sm:pt-7">
          <div className="min-w-0">
            {eyebrow && <div className="mb-2">{eyebrow}</div>}
            <h2 id={titleId} className="font-display text-lg leading-tight font-semibold text-balance">
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Kapat"
            className="-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-wash hover:text-ink"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-6 pb-6 sm:px-7">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule px-6 py-4 pb-safe sm:px-7">
            {footer}
          </div>
        )}
      </motion.div>
    </dialog>
  );
}

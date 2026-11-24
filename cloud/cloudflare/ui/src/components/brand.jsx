import { cn } from "../lib/utils.js";

/** UniTakip işareti: yuvarlak kare + onay çizgisi (özgün, SVG). */
export function BrandMark({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect x="2.5" y="2.5" width="27" height="27" rx="8" className="fill-ink" />
      <path
        d="m10 16.6 4.1 4.1 8-9.4"
        className="fill-none stroke-paper"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Brand({ className, compact = false }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark className="size-7" />
      {!compact && (
        <span className="text-[1.0625rem] leading-none font-semibold tracking-[-0.015em]">UniTakip</span>
      )}
    </span>
  );
}

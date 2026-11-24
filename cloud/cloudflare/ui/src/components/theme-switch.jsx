import { motion } from "motion/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { setTheme, useTheme } from "../lib/theme.js";
import { cn } from "../lib/utils.js";

const OPTIONS = [
  ["system", "Sistem", Monitor],
  ["light", "Aydınlık", Sun],
  ["dark", "Karanlık", Moon],
];

/** Üç seçenekli görünüm seçici. withLabels: ayarlar sayfasında metinli, kenar çubuğunda yalnız simge. */
export function ThemeSwitch({ withLabels = false, className, layoutId = "theme-switch" }) {
  const { mode } = useTheme();
  return (
    <div role="radiogroup" aria-label="Görünüm" className={cn("inline-flex rounded-full bg-wash p-1", className)}>
      {OPTIONS.map(([id, label, Icon]) => {
        const selected = mode === id;
        return (
          <button
            key={id}
            role="radio"
            aria-checked={selected}
            aria-label={withLabels ? undefined : `Görünüm: ${label}`}
            title={label}
            onClick={(e) => setTheme(id, e.currentTarget)}
            className={cn(
              "relative flex h-8 items-center justify-center gap-1.5 rounded-full text-[0.8125rem] font-medium transition-colors",
              withLabels ? "px-3.5" : "w-9",
              selected ? "text-ink" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {selected && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-full bg-card shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--rule)]"
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
            <Icon className="relative size-4" strokeWidth={1.8} aria-hidden />
            {withLabels && <span className="relative">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Tek dokunuşla aydınlık ↔ karanlık (mobil üst çubuk, giriş sayfası). */
export function ThemeToggle({ className }) {
  const { resolved } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      onClick={(e) => setTheme(next, e.currentTarget)}
      aria-label={next === "dark" ? "Karanlık temaya geç" : "Aydınlık temaya geç"}
      title={next === "dark" ? "Karanlık tema" : "Aydınlık tema"}
      className={cn(
        "relative grid size-11 place-items-center overflow-hidden rounded-full text-ink-2 transition-colors hover:bg-wash hover:text-ink",
        className,
      )}
    >
      <motion.span
        key={resolved}
        initial={{ rotate: -90, scale: 0.6, opacity: 0 }}
        animate={{ rotate: 0, scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 26 }}
        className="grid place-items-center"
      >
        {resolved === "dark" ? <Moon className="size-[1.15rem]" /> : <Sun className="size-[1.15rem]" />}
      </motion.span>
    </button>
  );
}

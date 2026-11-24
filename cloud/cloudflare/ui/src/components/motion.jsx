import { cloneElement, isValidElement, useEffect, useRef, useState } from "react";
import { animate, motion, useInView, useMotionValue, useReducedMotion, useScroll, useSpring } from "motion/react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { cn } from "../lib/utils.js";

/*
  Hareket dili (awwwards'ta ödül alan sitelerden uyarlandı; günlük kullanılan bir panel için kısaltıldı):
  - Eğriler: easeOutQuint girişler için, easeInOutCubic perde/geçişler için.
  - Başlıklar kelime kelime maskeden yükselir; bölümler görünür olunca belirir; sayılar sayarak gelir.
  - Masaüstünde yumuşak (ataletli) kaydırma. Hareket azaltma tercihinde hepsi kapanır (MotionConfig + bu dosyadaki kontroller).
*/
export const EASE_OUT = [0.23, 1, 0.32, 1];
export const EASE_IN_OUT = [0.65, 0, 0.35, 1];

/** Metni kelimelere ayırıp her kelimeyi maskenin altından yükseltir. <em> gibi iç öğeler korunur. */
export function RevealText({ children, delay = 0, stagger = 0.045, duration = 0.8 }) {
  const reduce = useReducedMotion();
  if (reduce) return children;
  let index = 0;
  const wrap = (node) => {
    if (typeof node === "string" || typeof node === "number") {
      return String(node)
        .split(/(\s+)/)
        .map((part, i) => {
          if (!part) return null;
          if (/^\s+$/.test(part)) return part;
          const order = index++;
          return (
            <span key={`w${order}-${i}`} className="inline-block overflow-hidden pb-[0.12em] -mb-[0.12em] align-bottom">
              <motion.span
                className="inline-block will-change-transform"
                initial={{ y: "115%" }}
                animate={{ y: "0%" }}
                transition={{ duration, ease: EASE_OUT, delay: delay + order * stagger }}
              >
                {part}
              </motion.span>
            </span>
          );
        });
    }
    if (Array.isArray(node)) return node.map((child, i) => <WrapKey key={i}>{wrap(child)}</WrapKey>);
    if (isValidElement(node) && node.props?.children !== undefined) return cloneElement(node, {}, wrap(node.props.children));
    return node;
  };
  return <>{wrap(children)}</>;
}
const WrapKey = ({ children }) => children;

/** Görünür alana girince bir kez yumuşakça belirir. */
export function Reveal({ as = "div", children, delay = 0, y = 18, className, ...props }) {
  const Tag = motion[as] || motion.div;
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.7, ease: EASE_OUT, delay }}
      {...props}
    >
      {children}
    </Tag>
  );
}

/** Sayı görünür olunca sıfırdan değerine sayar. */
export function CountUp({ value, duration = 1.1 }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const target = Number(value) || 0;
  const [shown, setShown] = useState(reduce ? target : 0);
  useEffect(() => {
    if (reduce || !inView) {
      if (reduce) setShown(target);
      return undefined;
    }
    const controls = animate(0, target, { duration, ease: EASE_OUT, onUpdate: (v) => setShown(Math.round(v)) });
    return () => controls.stop();
  }, [inView, target, reduce, duration]);
  return (
    <span ref={ref} className="tabular">
      {Number.isFinite(Number(value)) ? shown : value}
    </span>
  );
}

/** Masaüstünde ataletli kaydırma. Dokunmatik cihazlarda ve hareket azaltma tercihinde yerel kaydırma kalır. */
export function useSmoothScroll() {
  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduce) return undefined;
    const lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 1, smoothWheel: true });
    window.__lenis = lenis;
    let frame = requestAnimationFrame(function loop(time) {
      lenis.raf(time);
      frame = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
      if (window.__lenis === lenis) delete window.__lenis;
    };
  }, []);
}

/** Sayfayı en üste taşır; yumuşak kaydırma açıksa onun üzerinden (yoksa çakışır). */
export function scrollToTop(smooth = false) {
  if (window.__lenis) window.__lenis.scrollTo(0, { immediate: !smooth, force: true });
  else window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
}

/**
 * Açılış ekranı (oturum başına bir kez): kenarlarda mono etiketler ve 000→100 sayacı, ortada marka yazısı harf harf
 * yükselir; ardından koyu perde yukarı kalkar (≈1,7 sn). Orchestrated ve Koval SEO'daki yükleme ekranlarından uyarlandı.
 */
export function Intro() {
  const reduce = useReducedMotion();
  const [show, setShow] = useState(() => {
    try {
      return !sessionStorage.getItem("ut-intro");
    } catch {
      return false;
    }
  });
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!show) return undefined;
    try {
      sessionStorage.setItem("ut-intro", "1");
    } catch {
      /* gizli mod: perde yine bir kez görünür */
    }
    const counter = animate(0, 100, { duration: 0.95, ease: EASE_IN_OUT, onUpdate: (v) => setCount(Math.round(v)) });
    const timer = setTimeout(() => setShow(false), 1750);
    return () => {
      counter.stop();
      clearTimeout(timer);
    };
  }, [show]);
  if (!show || reduce) return null;
  const letters = "UniTakip".split("");
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[100] bg-[#0b0b0d] font-mono text-[#f4f4f5]"
      initial={{ clipPath: "inset(0% 0% 0% 0%)" }}
      animate={{ clipPath: "inset(0% 0% 100% 0%)" }}
      transition={{ duration: 0.75, ease: EASE_IN_OUT, delay: 1.0 }}
    >
      <div className="absolute inset-x-5 top-5 flex justify-between text-[0.6875rem] tracking-[0.12em] uppercase opacity-60 sm:inset-x-8 sm:top-7">
        <span>UniTakip / takip konsolu</span>
        <span>İstanbul</span>
      </div>
      <div className="grid h-full place-items-center">
        <span className="flex overflow-hidden font-sans text-[clamp(2.75rem,9vw,6.5rem)] leading-none font-semibold tracking-[-0.05em]">
          {letters.map((letter, i) => (
            <motion.span
              key={i}
              className="inline-block"
              initial={{ y: "110%" }}
              animate={{ y: "0%" }}
              transition={{ duration: 0.65, ease: EASE_OUT, delay: 0.08 + i * 0.04 }}
            >
              {letter}
            </motion.span>
          ))}
        </span>
      </div>
      <div className="absolute inset-x-5 bottom-5 flex items-end justify-between sm:inset-x-8 sm:bottom-7">
        <span className="text-[0.6875rem] tracking-[0.12em] uppercase opacity-60">Siteler okunuyor</span>
        <span className="text-[clamp(1.5rem,4vw,2.5rem)] leading-none tabular">{String(count).padStart(3, "0")}</span>
      </div>
      <motion.span
        className="absolute inset-x-0 bottom-0 h-px origin-left bg-white/50"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.95, ease: EASE_IN_OUT }}
      />
    </motion.div>
  );
}

/** İmleç yaklaştıkça hafifçe ona doğru çekilen sarmalayıcı (yalnızca fareli cihazlarda). */
export function Magnetic({ children, strength = 0.22, className }) {
  const ref = useRef(null);
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 18, mass: 0.4 }), sy = useSpring(y, { stiffness: 260, damping: 18, mass: 0.4 });
  const reduce = useReducedMotion();
  const fine = typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches;
  if (reduce || !fine) return <span className={cn("inline-flex", className)}>{children}</span>;
  return (
    <motion.span
      ref={ref}
      className={cn("inline-flex", className)}
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        const r = ref.current.getBoundingClientRect();
        x.set((e.clientX - (r.left + r.width / 2)) * strength);
        y.set((e.clientY - (r.top + r.height / 2)) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}

const GLYPHS = "ABCDEFGHİJKLMNOPRSTUVYZ0123456789/·_";
/**
 * Harfleri rastgele karakterlerden "çözülerek" yerine oturan metin (Koval SEO'daki etiketler gibi). Ekran okuyucu
 * asıl metni okur; değişen karakterler gizlidir.
 */
export function Scramble({ text, delay = 0, duration = 0.7, className }) {
  const reduce = useReducedMotion();
  const value = String(text ?? "");
  const [shown, setShown] = useState(reduce ? value : "");
  useEffect(() => {
    if (reduce) {
      setShown(value);
      return undefined;
    }
    let frame, start;
    const timer = setTimeout(() => {
      const tick = (time) => {
        start ??= time;
        const progress = Math.min(1, (time - start) / (duration * 1000));
        const settled = Math.floor(progress * value.length);
        setShown(
          value
            .split("")
            .map((ch, i) => (i < settled || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
            .join(""),
        );
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, delay * 1000);
    // Sekme arka plandayken animasyon kareleri durur; metin her durumda süresi dolunca doğru hâline oturur.
    const settle = setTimeout(() => setShown(value), (delay + duration) * 1000 + 120);
    return () => {
      clearTimeout(timer);
      clearTimeout(settle);
      cancelAnimationFrame(frame);
    };
  }, [value, delay, duration, reduce]);
  return (
    <span className={className}>
      <span className="sr-only">{value}</span>
      <span aria-hidden>{shown || " "}</span>
    </span>
  );
}

/**
 * Sayfa geçiş perdesi: koyu panel aşağıdan ekranı kaplar, üzerinde gidilen sayfanın numarası ve adı belirir, ardından
 * yukarı çekilir (≈0,8 sn, CSS animasyonu: styles.css .page-curtain). İçerik perde ekranı kapladığı anda değişir.
 */
export const PAGE_COVER_MS = 330;
export function PageCurtain({ curtain, onDone }) {
  // Animasyon bitiş olayı gelmezse (sekme arka planda vb.) perde ekranda asılı kalmasın.
  useEffect(() => {
    if (!curtain) return undefined;
    const timer = setTimeout(onDone, 1500);
    return () => clearTimeout(timer);
  }, [curtain, onDone]);
  if (!curtain) return null;
  return (
    <div
      key={curtain.id}
      aria-hidden
      className="page-curtain pointer-events-none fixed inset-0 z-[90] flex flex-col justify-between bg-[#0b0b0d] p-5 font-mono text-[#f4f4f5] sm:p-8 lg:pl-[calc(17rem+2rem)]"
      onAnimationEnd={(event) => event.target === event.currentTarget && onDone()}
    >
      <div className="flex justify-between text-[0.6875rem] tracking-[0.12em] uppercase opacity-60">
        <span>UniTakip</span>
        <span>{curtain.index}</span>
      </div>
      <div className="overflow-hidden">
        <p className="page-curtain-text font-sans text-[clamp(2.5rem,8vw,6rem)] leading-[0.95] font-semibold tracking-[-0.05em]">
          {curtain.label}
        </p>
      </div>
    </div>
  );
}

/** Sağ kenarda kaydırma ilerleme rayı (yalnızca geniş ekranda). */
export function ScrollRail() {
  const { scrollYProgress } = useScroll();
  const scaleY = useSpring(scrollYProgress, { stiffness: 220, damping: 30, mass: 0.3 });
  return (
    <div aria-hidden className="pointer-events-none fixed top-1/2 right-4 z-30 hidden h-40 w-[3px] -translate-y-1/2 rounded-full bg-rule xl:block">
      <motion.span className="absolute inset-0 origin-top rounded-full bg-ink" style={{ scaleY }} />
    </div>
  );
}

/** Görününce soldan sağa çizilen ince çizgi (dizin listelerindeki noktalı ayraç gibi). */
export function DrawRule({ className, dotted = false }) {
  return (
    <motion.span
      aria-hidden
      className={cn("block h-px origin-left", dotted ? "rule-dotted" : "bg-rule", className)}
      initial={{ scaleX: 0 }}
      whileInView={{ scaleX: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 1, ease: EASE_IN_OUT }}
    />
  );
}

/** Köşe "+" işaretleri (ince çizgili bloklar için süs; ekran okuyucudan gizli). */
export function CornerMarks({ className }) {
  const mark = "pointer-events-none absolute size-2.5 text-ink-3/60";
  const plus = (
    <svg viewBox="0 0 10 10" className="size-full" aria-hidden>
      <path d="M5 0v10M0 5h10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
  return (
    <span aria-hidden className={cn("pointer-events-none absolute inset-0", className)}>
      <span className={cn(mark, "-top-[5px] -left-[5px]")}>{plus}</span>
      <span className={cn(mark, "-top-[5px] -right-[5px]")}>{plus}</span>
      <span className={cn(mark, "-bottom-[5px] -left-[5px]")}>{plus}</span>
      <span className={cn(mark, "-right-[5px] -bottom-[5px]")}>{plus}</span>
    </span>
  );
}

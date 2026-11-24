import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Mail, ShieldCheck } from "lucide-react";
import { Brand } from "../components/brand.jsx";
import { ThemeToggle } from "../components/theme-switch.jsx";
import { Button } from "../components/ui/primitives.jsx";
import { post } from "../lib/api.js";
import { cn } from "../lib/utils.js";

/** Tek gerçek <input> + 6 görsel hücre: yapıştırma, otomatik doldurma ve ekran okuyucu ile uyumlu. */
function CodeInput({ value, onChange, disabled }) {
  const ref = useRef(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="relative" onClick={() => ref.current?.focus()}>
      <input
        ref={ref}
        id="login-code"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        disabled={disabled}
        aria-label="6 haneli giriş kodu"
        className="absolute inset-0 z-10 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0"
      />
      <div className="grid grid-cols-6 gap-2 sm:gap-2.5" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => {
          const char = value[i];
          const current = focused && (i === value.length || (i === 5 && value.length === 6));
          return (
            <div
              key={i}
              className={cn(
                "grid h-14 place-items-center rounded-2xl border bg-card text-2xl font-semibold tabular transition-[border-color,box-shadow] duration-150",
                current ? "border-ink shadow-[0_0_0_4px_var(--accent-soft)]" : char ? "border-rule-strong" : "border-rule",
              )}
            >
              {char ? (
                <motion.span initial={{ y: 6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.15 }}>
                  {char}
                </motion.span>
              ) : current ? (
                <span className="h-7 w-px animate-pulse bg-ink" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Sol panel: ajanda kartları — farklı sitelerin tek sayfada buluşması (özgün, CSS + Motion) */
function Illustration() {
  const cards = [
    { id: "lms", label: "Ders sitesi", dot: "bg-[#38c2b1]", title: "Veri Yapıları", meta: "Ödev · 2 gün kaldı", tone: "bg-warm" },
    { id: "obs", label: "Öğrenci bilgi sistemi", dot: "bg-[#77a0ff]", title: "Algoritmalar", meta: "Vize notu açıklandı", tone: "bg-cool" },
    { id: "news", label: "Duyuru sayfası", dot: "bg-[#a98bff]", title: "Türk Dili", meta: "Yeni sunum eklendi", tone: "bg-accent" },
  ];
  return (
    <div className="relative mx-auto h-80 w-full max-w-sm" aria-hidden>
      {cards.map((c, i) => (
        <motion.div
          key={c.id}
          initial={{ opacity: 0, y: 30, rotate: 0 }}
          animate={{ opacity: 1, y: 0, rotate: [-5, 3, -1.5][i] }}
          transition={{ delay: 0.25 + i * 0.12, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-x-0 rounded-[1.25rem] border border-white/10 bg-[#202024] p-5"
          style={{ top: i * 100, left: i * 14, right: -i * 14, zIndex: 3 - i }}
        >
          <div className="flex items-center gap-2 text-[0.6875rem] font-semibold tracking-[0.14em] text-white/55 uppercase">
            <span className={cn("size-1.5 rounded-full", c.dot)} />
            {c.label}
          </div>
          <p className="mt-2 text-lg font-semibold text-[#f4f4f5]">{c.title}</p>
          <p className="mt-1 flex items-center gap-2 text-sm text-white/65">
            <span className={cn("size-1.5 rounded-full", c.tone)} />
            {c.meta}
          </p>
        </motion.div>
      ))}
    </div>
  );
}

export function LoginPage({ onLogin, initialError, preview }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || "");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (initialError) setError(initialError);
  }, [initialError]);
  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send() {
    setBusy(true);
    setError("");
    try {
      const result = await post("/auth/code");
      setSent(true);
      setCode("");
      setCooldown(result.retryAfter || 60);
    } catch (e) {
      setError(e.message);
      if (e.retryAfter) setCooldown(e.retryAfter);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e) {
    e?.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    setError("");
    try {
      await post("/auth/verify", { code });
      await onLogin();
    } catch (err) {
      setError(err.message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (code.length === 6 && !busy) verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative m-3 hidden overflow-hidden rounded-[1.75rem] bg-[#151517] p-12 text-[#f4f4f5] lg:flex lg:flex-col">
        <div className="relative flex items-center gap-2.5">
          <Brand className="[&_path]:stroke-[#0b0b0d] [&_rect]:fill-[#f4f4f5]" compact />
          <span className="text-[1.0625rem] leading-none font-semibold tracking-[-0.015em]">UniTakip</span>
        </div>
        <div className="relative my-auto py-10">
          <p className="text-xs font-medium text-white/50">Kişisel akademik ajanda</p>
          <h1 className="mt-3 max-w-[16ch] font-display text-5xl leading-[1.05] font-semibold">
            Derslerin, <em className="text-white/55">tek bir</em> sayfada.
          </h1>
          <p className="mt-6 max-w-md text-[0.9375rem] leading-relaxed text-white/65">
            Ders sitelerin, öğrenci bilgi sistemin ve duyuru sayfaların düzenli kontrol edilir. Yeni ödev, not ve dosyalar sana gelir — sen derse odaklan.
          </p>
          <div className="mt-12">
            <Illustration />
          </div>
        </div>
        <p className="relative flex items-center gap-2 text-xs text-white/50">
          <ShieldCheck className="size-4" /> Okul şifren bu panelde istenmez ve saklanmaz.
        </p>
      </section>

      <section className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center justify-between">
          <Brand className="lg:invisible" />
          <ThemeToggle className="-mr-2" />
        </div>
        <div className="mx-auto my-auto w-full max-w-[25rem] py-12">
          <AnimatePresence mode="wait">
            <motion.div
              key={sent ? "code" : "start"}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            >
              <p className="eyebrow">{sent ? "Adım 2 / 2" : "Güvenli giriş"}</p>
              <h2 className="mt-1.5 font-display text-3xl leading-tight font-semibold">
                {sent ? (
                  <>
                    Gelen kutuna <em>bir bak.</em>
                  </>
                ) : (
                  <>
                    Hoş <em>geldin.</em>
                  </>
                )}
              </h2>
              <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-2">
                {sent
                  ? "Kayıtlı e-postana 6 haneli bir kod gönderdik. Kod 10 dakika geçerli; yazdığın anda giriş yapılır."
                  : "Paneline ulaşmak için kayıtlı e-posta adresine tek kullanımlık bir giriş kodu gönderelim."}
              </p>
              {sent ? (
                <form onSubmit={verify} className="mt-8 space-y-5">
                  <CodeInput value={code} onChange={setCode} disabled={busy} />
                  <Button type="submit" size="lg" className="w-full" busy={busy} disabled={code.length !== 6}>
                    Panelime git <ArrowRight className="size-4" />
                  </Button>
                  <div className="flex items-center justify-between text-sm">
                    <button type="button" className="text-ink-3 hover:text-ink" onClick={() => setSent(false)}>
                      Geri
                    </button>
                    <button
                      type="button"
                      disabled={busy || cooldown > 0}
                      onClick={send}
                      className="font-semibold text-ink-2 hover:text-ink disabled:font-normal disabled:text-ink-3"
                    >
                      {cooldown > 0 ? `Yeni kod · ${cooldown} sn` : "Yeni kod gönder"}
                    </button>
                  </div>
                </form>
              ) : (
                <Button size="lg" className="mt-8 w-full" icon={Mail} busy={busy} onClick={send}>
                  Giriş kodu gönder
                </Button>
              )}
            </motion.div>
          </AnimatePresence>
          {error && (
            <p role="alert" className="mt-5 rounded-xl bg-hot-soft px-4 py-3 text-sm text-hot">
              {error}
            </p>
          )}
          {preview && <p className="mt-5 text-center text-xs text-ink-3">Yerel önizleme · deneme kodu: 123456</p>}
        </div>
        <p className="text-center text-xs text-ink-3 lg:hidden">Okul şifren bu panelde istenmez ve saklanmaz.</p>
      </section>
    </main>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Check, CloudOff, Info, X } from "lucide-react";
import { BrandMark } from "./components/brand.jsx";
import { useReducedMotion } from "motion/react";
import { EASE_OUT, Intro, PAGE_COVER_MS, PageCurtain, ScrollRail, scrollToTop, useSmoothScroll } from "./components/motion.jsx";
import { Shell } from "./components/shell.jsx";
import { TaskSheet, TestMailSheet } from "./components/sheets.jsx";
import { api, post } from "./lib/api.js";
import { ROUTES, setSites, siteList } from "./lib/meta.js";
import { useHashRoute } from "./lib/router.js";
import { cn } from "./lib/utils.js";
import { ActivityPage } from "./pages/activity.jsx";
import { DeadlinesPage } from "./pages/deadlines.jsx";
import { FilesPage } from "./pages/files.jsx";
import { GradesPage } from "./pages/grades.jsx";
import { LoginPage } from "./pages/login.jsx";
import { SettingsPage } from "./pages/settings.jsx";
import { SitesPage } from "./pages/sites.jsx";
import { ReconnectPage } from "./pages/reconnect.jsx";
import { TodayPage } from "./pages/today.jsx";

const PREVIEW = __LOCAL_PREVIEW__;

/** Saniyede bir değil, dakikada bir yenilenen "şimdi": göreli zamanlar ve aciliyet etiketleri güncel kalır. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Toast({ toast, onClose }) {
  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.id}
          role={toast.error ? "alert" : "status"}
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "fixed inset-x-4 bottom-28 z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl px-4 py-3.5 text-sm shadow-float lg:bottom-28",
            toast.error ? "bg-hot text-paper" : "bg-ink text-paper",
          )}
        >
          {toast.error ? <Info className="size-4 shrink-0" /> : <Check className="size-4 shrink-0" />}
          <span className="flex-1">{toast.message}</span>
          <button onClick={onClose} aria-label="Kapat" className="-mr-1 grid size-8 place-items-center rounded-full hover:bg-paper/15">
            <X className="size-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Dashboard({ data, refresh, onLogout }) {
  // Site kaydı (adlar, renkler, süzgeçler) her panel verisiyle güncellenir; site sayısı kuruluma göre değişir.
  setSites(data.sites || data.platforms);
  useSmoothScroll();
  const [target, navigate, routeParam] = useHashRoute(data.sites);
  // Sayfa değişimi: perde ekranı kaplayınca içerik değişir ve sayfa en üste döner (awwwards tarzı geçiş).
  const reduce = useReducedMotion();
  const [route, setRoute] = useState(target);
  const [curtain, setCurtain] = useState(null);
  const closeCurtain = useCallback(() => setCurtain(null), []);
  useEffect(() => {
    if (target === route) return undefined;
    if (reduce) {
      setRoute(target);
      scrollToTop();
      return undefined;
    }
    const at = ROUTES.findIndex((r) => r.id === target);
    setCurtain({
      id: Date.now(),
      label: target === "baglan" ? "Yeniden bağlan" : ROUTES[at]?.label || "UniTakip",
      index: at >= 0 ? `${String(at + 1).padStart(2, "0")} / ${String(ROUTES.length).padStart(2, "0")}` : "—",
    });
    const timer = setTimeout(() => {
      setRoute(target);
      scrollToTop();
    }, PAGE_COVER_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const now = useNow();
  const [task, setTask] = useState(null);
  const [testOpen, setTestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const active = data.armed && data.liveEnabled;
  const working = data.checking || Boolean(data.manualRequestedAt);

  // Sekme başlığı ve tarayıcı geçmişi hangi sayfada olunduğunu göstersin
  useEffect(() => {
    const previous = document.title;
    document.title = `${route === "baglan" ? "Yeniden bağlan" : ROUTES.find((r) => r.id === route)?.title || "Kontrol merkezi"} · UniTakip`;
    return () => {
      document.title = previous;
    };
  }, [route]);

  // Ödevler + sınavlar (sınav duyuruları dahil) tek ajanda listesinde, kimliğe göre tekilleştirilmiş
  const tasks = useMemo(() => {
    const map = new Map();
    for (const t of [...(data.tasks || []), ...(data.exams || [])]) if (!map.has(t.id)) map.set(t.id, t);
    return [...map.values()];
  }, [data.tasks, data.exams]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5500);
    return () => clearTimeout(t);
  }, [toast]);
  const notify = (message, error = false) => setToast({ id: Date.now(), message, error });

  async function action(name, payload = {}) {
    setBusy(true);
    try {
      await post(`/api/${name}`, payload);
      notify(
        name === "check" || name === "resume"
          ? "Kontrol başlatıldı. Sonuçlar bu ekranda kendiliğinden yenilenecek."
          : name === "pause"
            ? "Takip duraklatıldı."
            : "Ayarların kaydedildi.",
      );
      await refresh();
    } catch (e) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  const SITE_MESSAGES = {
    save: "Site kaydedildi.",
    pause: "Site duraklatıldı; diğer siteler takip edilmeye devam eder.",
    resume: "Site yeniden takipte.",
    remove: "Site kaldırıldı.",
  };
  async function siteAction(name, payload, { throwOnError = false, retryBusy = false } = {}) {
    try {
      let result;
      const delays = retryBusy ? [0, 2500, 7500, 15000] : [0];
      for (const [attempt, delay] of delays.entries()) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          result = await post(`/api/sites/${name}`, payload);
          break;
        } catch (error) {
          if (error.code !== "busy" || attempt === delays.length - 1) throw error;
        }
      }
      notify(
        name === "test"
          ? result.ok
            ? `Bağlantı testi başarılı: ${result.items} öğe okundu.`
            : "Bağlantı testi tamamlandı; sorunun ayrıntısı kartta."
          : SITE_MESSAGES[name],
        name === "test" && !result.ok,
      );
      await refresh();
      return result || { ok: true };
    } catch (e) {
      if (throwOnError) throw e;
      notify(e.message, true);
      return null;
    }
  }

  async function sendTest(choice) {
    const names = choice === "all" ? siteList().filter((s) => !s.paused).map((s) => s.id) : [choice];
    let sent = 0;
    for (const name of names) {
      try {
        await post(`/api/test-email?platform=${name}`);
        sent++;
      } catch {
        /* sayım aşağıda bildiriliyor */
      }
    }
    setTestOpen(false);
    notify(
      sent === names.length
        ? `${sent} deneme e-postası gönderildi. Gelen kutuna bakabilirsin.`
        : `${sent}/${names.length} e-posta gönderildi. Kalanları biraz sonra yeniden dene.`,
      sent !== names.length,
    );
    await refresh();
  }

  const common = { data, now, onOpen: setTask };
  return (
    <Shell
      route={target}
      navigate={navigate}
      data={data}
      active={active}
      working={working}
      checkBusy={busy}
      onCheck={() => action("check")}
      onLogout={onLogout}
      preview={PREVIEW}
    >
      <Intro />
      <PageCurtain curtain={curtain} onDone={closeCurtain} />
      <ScrollRail />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={route}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE_OUT, delay: reduce ? 0 : 0.12 } }}
          exit={{ opacity: 0, transition: { duration: 0.01 } }}
        >
          {route === "bugun" && (
            <TodayPage
              {...common}
              tasks={tasks}
              active={active}
              working={working}
              checkBusy={busy}
              onCheck={() => action("check")}
              navigate={navigate}
            />
          )}
          {route === "teslimler" && <DeadlinesPage key={routeParam} initialQuery={routeParam} tasks={tasks} onOpen={setTask} now={now} />}
          {route === "notlar" && <GradesPage {...common} />}
          {route === "dosyalar" && <FilesPage {...common} />}
          {route === "siteler" && <SitesPage data={data} active={active} onSiteAction={siteAction} />}
          {route === "baglan" && (
            <ReconnectPage key={routeParam} data={data} siteId={routeParam} onDone={() => refresh()} onBack={() => navigate("siteler")} />
          )}
          {route === "bildirimler" && <ActivityPage {...common} onTestMail={() => setTestOpen(true)} />}
          {route === "ayarlar" && (
            <SettingsPage
              data={data}
              active={active}
              working={working}
              busy={busy}
              onAction={action}
              onTestMail={() => setTestOpen(true)}
              onLogout={onLogout}
              navigate={navigate}
            />
          )}
          <footer className="mt-24 border-t border-rule pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[0.6875rem] tracking-[0.08em] text-ink-3 uppercase">
              <span>İstanbul saati · veriler {data.lastFullAt ? "bulutta güncel" : "ilk kontrolü bekliyor"}</span>
              <span>UniTakip / takip konsolu</span>
            </div>
            <p aria-hidden className="dot-type mt-6 text-[clamp(4rem,17vw,13rem)] leading-[0.8] font-bold tracking-[-0.06em] text-ink-3/70 select-none">
              UniTakip
            </p>
          </footer>
        </motion.div>
      </AnimatePresence>

      {task && <TaskSheet task={task} onClose={() => setTask(null)} now={now} />}
      {testOpen && <TestMailSheet email={data.profile.email} onClose={() => setTestOpen(false)} onSend={sendTest} />}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </Shell>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [phase, setPhase] = useState("loading");
  const [error, setError] = useState("");
  const [logoutFailed, setLogoutFailed] = useState(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const lastFetch = useRef(0);
  const lastInput = useRef(Date.now());

  const refresh = useCallback(async (signal) => {
    const requestId = ++sequence.current;
    lastFetch.current = Date.now();
    try {
      const result = await api("/api/dashboard", { signal });
      if (mounted.current && requestId === sequence.current) {
        setData(result);
        setPhase("ready");
        setError("");
      }
    } catch (e) {
      if (e.name === "AbortError" || !mounted.current || requestId !== sequence.current) return;
      if (e.code === "unauthorized") {
        setData(null);
        setLogoutFailed(false);
        setPhase("login");
      } else {
        // Geçici bir bağlantı hatası oturumun kapandığı anlamına gelmez: giriş ekranı yalnızca sunucu
        // "oturum yok" dediğinde gösterilir, yoksa kullanıcı gereksiz yere yeni kod ister.
        setError(e.message);
        setPhase((p) => (p === "ready" ? "ready" : "offline"));
      }
    }
  }, []);

  // Panel açılırken sunucuya ulaşılamadıysa birkaç saniyede bir kendiliğinden yeniden denenir.
  useEffect(() => {
    if (phase !== "offline") return;
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 8000);
    return () => clearInterval(timer);
  }, [phase, refresh]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [refresh]);

  // Son etkileşim zamanı: açık unutulan sekme Cloudflare isteği harcamasın diye yenileme seyreltilir.
  useEffect(() => {
    const touch = () => {
      lastInput.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((name) => window.addEventListener(name, touch, { passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, touch));
  }, []);

  // Her yenileme bir Worker isteği ve bir kayıt okumasıdır; veri ise ancak takip çalışınca (en sık 10 dk'da bir) değişir.
  // Kontrol sürerken 3 sn, panel kullanılırken 60 sn, 5 dk dokunulmadıysa 5 dk'da bir; sekme gizliyken hiç.
  useEffect(() => {
    if (phase !== "ready") return;
    const checking = Boolean(data?.checking || data?.manualRequestedAt);
    const controller = new AbortController();
    let timer;
    const delay = () => (checking ? 3000 : Date.now() - lastInput.current < 300000 ? 60000 : 300000);
    const loop = () => {
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await refresh(controller.signal);
        if (!controller.signal.aborted) loop();
      }, delay());
    };
    loop();
    // Sekmeye dönünce güncel veri gösterilir; hızlı sekme değişimleri art arda istek üretmez.
    const onVisible = () => document.visibilityState === "visible" && Date.now() - lastFetch.current > 15000 && refresh(controller.signal);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [phase, data?.checking, data?.manualRequestedAt, refresh]);

  async function logout() {
    setLogoutFailed(false);
    try {
      await post("/auth/logout");
      sequence.current++;
      setData(null);
      setError("");
      setPhase("login");
    } catch {
      setLogoutFailed(true);
    }
  }

  return (
    <MotionConfig reducedMotion="user">
      {phase === "loading" ? (
        <div className="grid min-h-dvh place-items-center" role="status" aria-label="Yükleniyor">
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4 }}
            className="flex flex-col items-center gap-4"
          >
            <BrandMark className="size-12" />
            <span className="font-display text-[0.9375rem] text-ink-3">Ajandan hazırlanıyor…</span>
          </motion.div>
        </div>
      ) : phase === "offline" ? (
        <div className="grid min-h-dvh place-items-center px-6" role="alert">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <CloudOff className="size-8 text-warm" aria-hidden />
            <h1 className="font-display text-lg font-semibold">Panele şu anda ulaşılamıyor</h1>
            <p className="text-sm leading-relaxed text-ink-2">
              Oturumun kapanmadı; bağlantı gelince panel kendiliğinden açılır. Yeniden giriş yapman gerekmiyor.
            </p>
            <button
              onClick={() => refresh()}
              className="rounded-xl border border-rule-strong px-4 py-2 text-sm font-semibold hover:bg-wash"
            >
              Yeniden dene
            </button>
          </div>
        </div>
      ) : phase === "login" ? (
        <LoginPage onLogin={refresh} initialError={error} preview={PREVIEW} />
      ) : (
        <>
          <Dashboard data={data} refresh={refresh} onLogout={logout} />
          {(error || logoutFailed) && (
            <div
              role="alert"
              className="fixed inset-x-4 top-20 z-50 mx-auto flex max-w-lg items-center gap-3 rounded-2xl bg-warm-soft px-4 py-3 text-sm text-warm shadow-float"
            >
              <CloudOff className="size-4 shrink-0" />
              <span className="flex-1">{logoutFailed
                ? "Çıkış tamamlanamadı. Bağlantıyı kontrol edip yeniden dene."
                : "Bağlantı geçici olarak kesildi. Son alınan veriler gösteriliyor."}</span>
              <button onClick={logoutFailed ? logout : () => refresh()} className="font-semibold underline-offset-4 hover:underline">
                Yeniden dene
              </button>
            </div>
          )}
        </>
      )}
    </MotionConfig>
  );
}

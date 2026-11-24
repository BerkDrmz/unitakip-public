import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ClipboardCopy } from "lucide-react";
import { Button, Sheet } from "./ui/primitives.jsx";
import { useCopy } from "./refresh-session-command.jsx";
import { post } from "../lib/api.js";
import { relative } from "../lib/format.js";
import source from "../classroom-script/Code.gs?raw";
import manifest from "../classroom-script/appsscript.json?raw";

function SetupCopy({ label, value }) {
  const [copied, copy] = useCopy();
  const ref = useRef(null);
  return (
    <div className="mt-2">
      <textarea ref={ref} readOnly value={value} rows={2} aria-label={label}
        className="w-full rounded-xl border border-rule bg-paper p-2 font-mono text-xs text-ink-2" />
      <Button variant="outline" size="sm" icon={copied === "ok" ? Check : ClipboardCopy} onClick={() => copy(value, ref.current)}>
        {copied === "ok" ? "Kopyalandı" : `${label} kopyala`}
      </Button>
      {copied === "fail" && <p role="status" className="mt-1 text-xs text-ink-3">Metni seçip elle kopyalayabilirsin.</p>}
    </div>
  );
}

function ClassroomScriptSetup({ site, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  async function prepare() {
    setError("");
    setBusy(true);
    try {
      const { url, token } = await post("/api/sites/classroom-script", { id: site.id });
      setCode(source.replace("__UNITAKIP_SCRIPT_CONFIG__", JSON.stringify({ url, token })));
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(false); }
  }

  return (
    <Sheet title="Classroom’u Apps Script ile bağla" onClose={onClose}>
      <p className="mb-4 text-sm leading-relaxed text-ink-2">
        Classroom derslerini gördüğün Google hesabıyla bir Apps Script projesi aç. Hazırlanan kod bu panele özel bir aktarım anahtarı içerir.
      </p>
      {!code ? (
        <>
          <div className="mb-4 rounded-xl border border-rule p-3 text-sm text-ink-2">
            <p>Projeyi GitHub’dan indirdiysen bu komutu çalıştır. Açılan Google ekranında izin verince ilk aktarım otomatik başlar.</p>
            <SetupCopy label="Kurulum komutunu" value="npm --prefix cloud/cloudflare run classroom:setup" />
          </div>
          {site.classroomScriptConfigured && <p className="mb-3 text-sm text-ink-3">Yeni kod hazırlarsan önceki aktarım anahtarı geçersiz olur.</p>}
          <Button busy={busy} onClick={prepare}>{site.classroomScriptConfigured ? "Yeni kod hazırla" : "Tarayıcıdan elle kur"}</Button>
        </>
      ) : (
        <ol className="list-decimal space-y-4 ps-5 text-sm leading-relaxed text-ink-2">
          <li>
            <a href="https://script.google.com/home" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-4">Apps Script’i aç</a>
            {" "}ve <strong>Yeni proje</strong> oluştur.
          </li>
          <li>
            <strong>Proje ayarları</strong> bölümünde <strong>appsscript.json manifest dosyasını düzenleyicide göster</strong> seçeneğini aç.
            Düzenleyicide <code>appsscript.json</code> dosyasının tamamını şu metinle değiştir.
            <SetupCopy label="appsscript.json" value={manifest} />
          </li>
          <li>
            <code>Code.gs</code> dosyasının tamamını şu kodla değiştir ve projeyi kaydet.
            <SetupCopy label="Code.gs" value={code} />
          </li>
          <li>
            Düzenleyicinin işlev listesinden <strong>startUniTakip</strong>’i seç ve <strong>Çalıştır</strong>’a bas. Google izin ekranında Classroom hesabını seç.
            İlk aktarım tamamlandığında UniTakip’te kartı yenile. Sonraki aktarımlar saatte bir çalışır.
          </li>
        </ol>
      )}
      {error && <p className="mt-3 text-sm text-hot" role="alert">{error}</p>}
      <p className="mt-4 text-xs text-ink-3">Aktarım anahtarını içeren Apps Script projesini özel tut.</p>
    </Sheet>
  );
}

export function ClassroomConnect({ site }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const flowStorageKey = `unitakip-classroom-${site.id}`;
  const [waitingUntil, setWaitingUntil] = useState(() => {
    if (!site.classroomBroker || site.login === "ok") return 0;
    const returning = new URLSearchParams(window.location.hash.split("?")[1]).get("classroom") === "shared";
    return Number(window.sessionStorage.getItem(flowStorageKey)) || (returning ? Date.now() + 45000 : 0);
  });

  useEffect(() => {
    if (!waitingUntil) return;
    let timer, stopped = false;
    function end(message) {
      window.sessionStorage.removeItem(flowStorageKey);
      setWaitingUntil(0);
      setError(message);
    }
    async function poll() {
      if (Date.now() >= waitingUntil) return end("Google izni zamanında tamamlanmadı. Yeniden bağlanabilirsin.");
      try {
        const { status } = await post("/api/sites/google/status", { id: site.id });
        if (stopped) return;
        if (status === "linked") {
          window.sessionStorage.removeItem(flowStorageKey);
          window.location.replace("/#/siteler?classroom=linked");
          window.location.reload();
          return;
        }
        if (status !== "pending") {
          return end(({ denied: "Google izni verilmedi.", expired: "Bağlantı isteğinin süresi doldu.",
            policy: "Classroom erişim izni eksik. Okul hesabının izinlerini kontrol et." })[status] || "Google bağlantısı tamamlanamadı.");
        }
      } catch (failure) {
        if (stopped) return;
        if (failure.code === "unauthorized") return end(failure.message);
      }
      if (!stopped) timer = window.setTimeout(poll, document.hidden ? 7000 : 3000);
    }
    timer = window.setTimeout(poll, 1200);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [flowStorageKey, site.id, waitingUntil]);

  async function connectGoogle() {
    setError("");
    setBusy(true);
    const popup = site.classroomBroker ? window.open("about:blank", "_blank") : null;
    try {
      const result = await post("/api/sites/google", { id: site.id });
      if (site.classroomBroker && result.shared) {
        const until = Date.now() + 590000;
        window.sessionStorage.setItem(flowStorageKey, String(until));
        setWaitingUntil(until);
        if (popup && !popup.closed) popup.location.replace("/oauth/classroom/start");
        else window.location.assign("/oauth/classroom/start");
        return;
      }
      const url = new URL(result.url);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") throw new Error("Google izin ekranı açılamadı.");
      window.location.assign(url.href);
    } catch (failure) {
      popup?.close();
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {site.classroomSyncAt && <p className="mb-2 text-xs text-ink-3">Son Apps Script aktarımı {relative(site.classroomSyncAt)}</p>}
      {site.classroomBroker && site.login !== "ok" && <p className="mb-2 text-xs text-ink-3">
        İzin verdiğinde ortak bağlantı servisi Classroom ödev ve duyurularını bu panele aktarır.{" "}
        <a className="underline" href={`${site.classroomBroker}/privacy`} target="_blank" rel="noreferrer">Gizlilik</a>
      </p>}
      <div className="flex flex-wrap gap-2">
        {site.googleReady && site.login !== "ok" && <Button size="sm" icon={ArrowUpRight} busy={busy || Boolean(waitingUntil)} onClick={connectGoogle}>
          {waitingUntil ? "Google izni bekleniyor" : "Google ile bağlan"}
        </Button>}
        {waitingUntil > 0 && <Button size="sm" variant="outline" onClick={() => {
          window.sessionStorage.removeItem(flowStorageKey);
          setWaitingUntil(0);
        }}>Beklemeyi durdur</Button>}
        <Button size="sm" variant={site.classroomSyncAt || site.googleReady ? "outline" : undefined} onClick={() => setSetup(true)}>
          {site.classroomSyncAt ? "Apps Script ayarları" : "Apps Script ile bağlan"}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-hot" role="alert">{error}</p>}
      {setup && <ClassroomScriptSetup site={site} onClose={() => setSetup(false)} />}
    </div>
  );
}

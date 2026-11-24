import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CircleCheck, ExternalLink, KeyRound, LockKeyhole, MessageSquareText, TriangleAlert } from "lucide-react";
import { Button, Card, Empty } from "../components/ui/primitives.jsx";
import { ClassroomConnect } from "../components/classroom-connect.jsx";
import { RefreshSessionCommand } from "../components/refresh-session-command.jsx";
import { post } from "../lib/api.js";
import { PageHeader } from "./page-header.jsx";

const inputClass =
  "block w-full rounded-2xl border border-rule-strong bg-paper px-3.5 py-3 text-base text-ink placeholder:text-ink-3/70 disabled:bg-wash disabled:text-ink-3";

const MESSAGES = {
  credentials: "Kullanıcı adı veya şifre kabul edilmedi. Kontrol edip yeniden dene.",
  code: "Doğrulama kodu kabul edilmedi. Telefonuna gelen son kodu gir.",
  expired: "Giriş süresi doldu. Kullanıcı adı ve şifreyle baştan başla.",
  unsupported: "Bu site panelden girişi desteklemiyor. Bilgisayarda oturumunu yenilemek için Siteler bölümündeki komutu kullan.",
  network: "Site şu anda yanıt vermiyor. Biraz sonra yeniden dene.",
  rate_limit: "Çok fazla deneme yapıldı. 15 dakika sonra yeniden dene.",
  busy: "Bir kontrol sürüyor. Birkaç saniye sonra yeniden dene.",
  site: "Siteye giriş yapılamadı. Biraz sonra yeniden dene.",
};

/**
 * Oturumu düşen bir siteye panelden yeniden giriş. Uyarı e-postasındaki bağlantı (#/baglan/<site>) burayı açar.
 * Şifre ve kod yalnızca bu istekte buluta gider, hiçbir yerde saklanmaz.
 */
export function ReconnectPage({ data, siteId, onDone, onBack }) {
  const site = (data.sites || []).find((entry) => entry.id === siteId);
  const [step, setStep] = useState("password"); // password | code | done
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!site)
    return (
      <Empty icon={TriangleAlert} title="Site bulunamadı">
        Bağlantıdaki site artık takip edilmiyor olabilir. Siteler sayfasından kontrol edebilirsin.
      </Empty>
    );

  if (site.type === "classroom") {
    return (
      <div className="mx-auto max-w-lg">
        <PageHeader eyebrow="Yeniden bağlan" title={site.name}>Classroom hesabını bağlayıp takibi sürdür.</PageHeader>
        <Card className="p-5"><ClassroomConnect site={site} /></Card>
      </div>
    );
  }

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const payload = step === "code" ? { id: site.id, code } : { id: site.id, username, password };
    setPassword("");
    try {
      const result = await post("/api/sites/login", payload);
      if (result.step === "code") {
        setStep("code");
        setCode("");
      } else {
        setStep("done");
        onDone?.();
      }
    } catch (failure) {
      setError(MESSAGES[failure.code] || failure.message);
      if (failure.code === "expired") setStep("password");
      if (failure.code === "code") setCode("");
    } finally {
      setBusy(false);
    }
  };

  const moodle = site.type === "moodle";
  const ubys = site.preset === "bartin-ubys";
  const projectDirectory = ubys && data.macProjectDirectory?.startsWith("/") ? data.macProjectDirectory : null;
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader eyebrow="Yeniden bağlan" title={site.name}>
        {step === "done"
          ? "Bağlantı yeniden kuruldu."
          : `Takibi sürdürmek için ${site.hostname} oturumunu yenile.`}
      </PageHeader>

      {step === "password" && !moodle && (
        <Card className="mb-4 p-5 sm:p-6">
          <details open={ubys || undefined}>
            <summary className="cursor-pointer font-semibold text-ink">
              {ubys ? "Mac’te e-Devlet ile bağlan" : "Bilgisayarda tarayıcıyla giriş"}
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              {projectDirectory
                ? "Mac’te Terminal’i aç. Komutu kopyala, yapıştır ve Enter’a bas."
                : "Bilgisayarında UniTakip proje klasörünü terminalde aç ve bu komutu çalıştır."}
            </p>
            <RefreshSessionCommand site={site} projectDirectory={projectDirectory} />
            {ubys ? (
              <ol className="mt-4 list-decimal space-y-2 ps-5 text-sm leading-relaxed text-ink-2">
                <li>
                  Açılan ÜBYS sayfasında <strong>e-Devlet ile Giriş</strong>’i seç. T.C. kimlik numaranı ve e-Devlet şifreni resmi <strong>giris.turkiye.gov.tr</strong> ekranına gir.
                </li>
                <li>ÜBYS’ye döndüğünde giriş otomatik algılanmazsa Terminal’de <strong>Enter</strong>’a bas.</li>
                <li>Cloudflare’a aktarma sorusu gelince <strong>e</strong> yazıp Enter’a bas.</li>
                <li>UniTakip’te <strong>Siteler → ÜBYS → Bağlantıyı test et</strong> ile kontrol et.</li>
              </ol>
            ) : (
              <p className="mt-3 text-sm leading-relaxed text-ink-2">
                Açılan tarayıcıda siteye giriş yap. Komut, oturumu Cloudflare’a aktarmadan önce onayını alır.
              </p>
            )}
          </details>
        </Card>
      )}
      <Card className="p-5 sm:p-6">
        <AnimatePresence mode="wait" initial={false}>
          {step === "done" ? (
            <motion.div key="done" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              <p className="flex items-center gap-2 text-base font-semibold text-cool">
                <CircleCheck className="size-5" aria-hidden /> Bağlantı sağlandı
              </p>
              <p className="text-sm leading-relaxed text-ink-2">
                Yeni oturum kaydedildi. Takip açıksa UniTakip şimdi siteyi yeniden kontrol eder.
              </p>
              <Button variant="outline" icon={ArrowLeft} onClick={onBack}>
                Sitelere dön
              </Button>
            </motion.div>
          ) : (
            <motion.form key={step} onSubmit={submit} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              {step === "password" ? (
                <>
                  {ubys && /^https:\/\//.test(site.url || "") && (
                    <div className="rounded-2xl bg-wash px-3.5 py-3 text-sm leading-relaxed text-ink-2">
                      <h2 className="font-semibold text-ink">ÜBYS şifresiyle bağlan</h2>
                      <p className="mt-1">Okul şifreni oluşturmak veya yenilemek için ÜBYS’de “Giriş yapamıyor musunuz?” bağlantısını kullan.</p>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 font-medium text-ink underline underline-offset-4"
                      >
                        <ExternalLink className="size-4" aria-hidden /> ÜBYS giriş sayfasını aç
                      </a>
                    </div>
                  )}
                  <div>
                    <label htmlFor="reconnect-user" className="mb-1.5 block text-sm font-medium">
                      {ubys ? "ÜBYS kullanıcı adı" : "Kullanıcı adı"}
                    </label>
                    <input
                      id="reconnect-user"
                      className={inputClass}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      maxLength={200}
                      disabled={busy}
                    />
                  </div>
                  <div>
                    <label htmlFor="reconnect-password" className="mb-1.5 block text-sm font-medium">
                      {ubys ? "ÜBYS şifresi" : "Site şifresi"}
                    </label>
                    <input
                      id="reconnect-password"
                      type="password"
                      className={inputClass}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                      maxLength={200}
                      disabled={busy}
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label htmlFor="reconnect-code" className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                    <MessageSquareText className="size-4 text-ink-3" aria-hidden /> Telefonuna gelen doğrulama kodu
                  </label>
                  <input
                    id="reconnect-code"
                    className={`${inputClass} font-mono tracking-[0.3em]`}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\s/g, "").slice(0, 10))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    disabled={busy}
                  />
                  <p className="mt-2 text-xs leading-relaxed text-ink-3">Kod birkaç dakika geçerlidir. Gelmediyse geri dönüp yeniden giriş yap.</p>
                </div>
              )}
              {error && (
                <p role="alert" className="flex items-start gap-2 rounded-2xl bg-hot-soft/60 px-3.5 py-2.5 text-sm text-hot">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" size="lg" busy={busy} icon={step === "code" ? KeyRound : LockKeyhole}>
                  {step === "code" ? "Doğrula" : "Bağlan"}
                </Button>
                {step === "code" && (
                  <Button type="button" variant="ghost" onClick={() => { setStep("password"); setError(""); }} disabled={busy}>
                    Baştan başla
                  </Button>
                )}
              </div>
              <p className="text-xs leading-relaxed text-ink-3">
                {moodle
                  ? "Giriş, Moodle'ın resmi mobil uygulama yöntemiyle yapılır. "
                  : "Giriş bilgilerin yalnızca bu giriş için siteye iletilir. "}
                Açılan oturum şifreli olarak saklanır. Şifren ve doğrulama kodun saklanmaz.
              </p>
            </motion.form>
          )}
        </AnimatePresence>
      </Card>
    </div>
  );
}

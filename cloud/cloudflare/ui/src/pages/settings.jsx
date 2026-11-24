import { ArrowRight, CalendarClock, Cloud, Gauge, LogOut, Mail, MailCheck, Palette, RefreshCw, ShieldCheck } from "lucide-react";
import { ThemeSwitch } from "../components/theme-switch.jsx";
import { PlatformList } from "../components/agenda.jsx";
import { Button, Card, Segmented, Switch } from "../components/ui/primitives.jsx";
import { intervalLabel, relative, time } from "../lib/format.js";
import { PageHeader } from "./page-header.jsx";

const count = (value) => Number(value).toLocaleString("tr-TR");
const megabytes = (bytes) => `${(bytes / 1024 ** 2).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} MB`;

function Row({ title, children, control, stack = false }) {
  return (
    <div className={stack ? "flex flex-col gap-3 py-5" : "flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8"}>
      <div className="min-w-0">
        <p className="text-[0.9375rem] font-semibold">{title}</p>
        {children && <p className="mt-1 text-sm leading-relaxed text-ink-3">{children}</p>}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  );
}

function Block({ icon: Icon, title, children }) {
  return (
    <Card className="px-5 pt-5 pb-1 sm:px-7 sm:pt-6">
      <h2 className="flex items-center gap-3 font-display text-lg font-semibold">
        <Icon className="size-5 text-ink-3" strokeWidth={1.7} aria-hidden />
        {title}
      </h2>
      <div className="mt-1 divide-y divide-rule/70">{children}</div>
    </Card>
  );
}

const STEPS = [
  ["Düzenli kontrol", "Siteler seçtiğin aralıkla kendi Cloudflare hesabında kontrol edilir; bilgisayarının açık olması gerekmez."],
  ["Yalnızca değişiklikler", "İlk taramadaki mevcut içerikler için toplu e-posta gelmez; sonraki her değişiklik bildirilir."],
  ["Oturum yenileme", "Bir sitede yeniden giriş gerekirse e-postayla haber verilir; diğerleri çalışmaya devam eder."],
];

export function SettingsPage({ data, active, working, busy, onAction, onTestMail, onLogout, navigate }) {
  return (
    <>
      <PageHeader eyebrow="Tercihler" title="Ayarlar">
        Takibin ritmi, bağlantıların ve bildirimlerin.
      </PageHeader>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <div className="space-y-6">
          <Block icon={CalendarClock} title="Takip">
            <Row
              title="Otomatik takip"
              control={
                <Switch
                  checked={active}
                  label="Otomatik takip"
                  disabled={busy || working || !data.liveEnabled}
                  onChange={(on) => onAction(on ? "resume" : "pause")}
                />
              }
            >
              {active ? `Açık · son kontrol ${relative(data.lastFullAt)}` : "Kapalı · yeni değişikliklerden haberin olmaz"}
            </Row>
            <Row
              title="Kontrol sıklığı"
              control={
                <Segmented
                  label="Kontrol sıklığı"
                  layoutId="interval"
                  value={data.intervalMinutes}
                  onChange={(v) => !busy && !working && v !== data.intervalMinutes && onAction("settings", { intervalMinutes: v })}
                  options={[
                    [30, "30 dk"],
                    [60, "1 sa"],
                    [120, "2 sa"],
                  ]}
                />
              }
            >
              Şu an {intervalLabel(data.intervalMinutes)}
              {data.nextFullAt && active ? ` · sonraki ${time(data.nextFullAt)}` : ""}
            </Row>
            <Row
              title="Şimdi kontrol et"
              control={
                <Button variant="outline" size="sm" icon={RefreshCw} busy={working || busy} disabled={!active} onClick={() => onAction("check")}>
                  Başlat
                </Button>
              }
            >
              Beklemeden takip edilen tüm siteleri bir kez kontrol eder.
            </Row>
          </Block>
          {data.usage && (
            <Block icon={Gauge} title="Cloudflare kullanımı">
              <Row
                title="Tek kontrolde en yüksek"
                control={
                  <span className="font-display text-lg font-semibold tabular">
                    {data.usage.peak}
                    <span className="text-base text-ink-3"> / {data.usage.limit}</span>
                  </span>
                }
              >
                Bugünkü toplam: {data.usage.runs} kontrol · {data.usage.requests} site isteği · {data.usage.mails} e-posta. Sağdaki sayı,
                bugün tek kontrolde görülen en yüksek değerdir. Her kontrolün sınırı ayrı ayrı {data.usage.limit} istektir; bu günlük kota değildir.
              </Row>
              {data.usage.rowsWritten != null && (
                <Row
                  title="Depolama yazımı"
                  control={
                    <span className="font-display text-lg font-semibold tabular">
                      {count(data.usage.rowsWritten)}
                      <span className="text-base text-ink-3"> / {count(data.usage.rowsLimit)}</span>
                    </span>
                  }
                >
                  Bugünkü satır yazımı (günlük sınır).
                  {data.usage.yesterdayRows != null && ` Dün ${count(data.usage.yesterdayRows)}.`}
                  {data.usage.databaseSize != null &&
                    ` Veritabanı ${megabytes(data.usage.databaseSize)} / ${Math.round(data.usage.storageLimit / 1024 ** 3)} GB.`}
                </Row>
              )}
              <Row title="Sınır koruması">
                {data.usage.resuming
                  ? "Şu an bir tarama payı doldurduğu için bölündü; kalan siteler bir sonraki kontrolde okunacak."
                  : data.usage.deferred
                    ? `Bugün ${data.usage.deferred} kez tarama bölündü ve sonraki kontrolde tamamlandı. İçerik kaybı olmaz; yalnızca bildirim birkaç dakika gecikebilir.`
                    : `Bir kontrol ${data.usage.budget} isteğe ulaşırsa kalan siteler hata üretmeden sonraki kontrole bırakılır.`}{" "}
                Sayaç Cloudflare gününe göre 03.00’te sıfırlanır.
              </Row>
            </Block>
          )}
          <Block icon={Palette} title="Görünüm">
            <Row stack title="Tema" control={<ThemeSwitch withLabels layoutId="theme-settings" />}>
              “Sistem” seçiliyken cihazının aydınlık/karanlık ayarını izler. Seçimin bu tarayıcıda hatırlanır.
            </Row>
          </Block>
          <Block icon={MailCheck} title="Bildirimler">
            <Row title="Bildirim adresi">{data.profile.email}</Row>
            <Row title="Durum e-postaları">İstanbul saatiyle {(data.daytimeReportHours ?? [9, 15]).map(hour => String(hour).padStart(2, "0") + ".00").join(" ve ")} sonrasındaki ilk kontrolde her sitenin durumunu ve son başarılı kontrol saatini alırsın. {data.statusReportHour ?? 21}.00 sonrasında günlük özet gelir. Yeni içerikler ve erişim sorunları ayrıca bildirilir.</Row>
            <Row
              title="Deneme e-postası"
              control={
                <Button variant="outline" size="sm" icon={Mail} onClick={onTestMail}>
                  Gönder
                </Button>
              }
            >
              Bildirimlerin gelen kutuna ulaştığını kontrol et.
            </Row>
          </Block>
        </div>
        <div className="space-y-6">
          <Block icon={Cloud} title="Siteler">
            <div className="py-2">
              <PlatformList platforms={data.platforms} active={active} />
              {!data.platforms.length && <p className="py-3 text-sm text-ink-3">Henüz site eklenmedi.</p>}
            </div>
            <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm leading-relaxed text-ink-3">
                Site ekle, bağlantıyı test et veya “Giriş gerekli” görünen bir sitenin oturumunu yenile. Okul şifren bu panelde saklanmaz.
              </p>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => navigate("siteler")}>
                Siteleri yönet <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </Block>
          <Block icon={ShieldCheck} title="Hesap">
            <Row
              title="Oturum"
              control={
                <Button variant="danger" size="sm" icon={LogOut} onClick={onLogout}>
                  Çıkış yap
                </Button>
              }
            >
              Bu cihazda 30 gün açık kalır; paneli kullandıkça süre uzar.
            </Row>
          </Block>
          <Card className="p-5 sm:p-7">
            <h2 className="font-display text-lg font-semibold">Nasıl çalışır?</h2>
            <ol className="mt-4 space-y-4">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="flex gap-4">
                  <span className="font-display text-lg leading-none text-ink-3 tabular">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-ink-3">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}

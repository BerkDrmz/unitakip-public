# Faz 5 — 7/24 çalıştırma ve VPS seçimi

## Gereksinimler

- 1 vCPU, **1–2 GB RAM** (Chromium yalnızca ÜBYS kontrolü sırasında birkaç saniye çalışır), 10–20 GB disk
- Docker + Compose eklentisi
- **Üniversite sitelerine erişim:** bazı Türk üniversite sistemleri yurt dışı IP'leri engelleyebiliyor.
  Bu durum henüz test edilmedi. VPS'i aldıktan sonra **ilk iş** `scripts/check-reachability.sh` çalıştır.

## Seçenekler

Fiyatlar ikincil kaynaklardan derlendi ve 2026'da birkaç kez değişti. **Satın almadan önce sağlayıcının sitesinde kontrol et.**

| Seçenek | Aylık | Artı | Eksi |
|---|---|---|---|
| **Hetzner CX23 / CAX11** (Almanya/Finlandiya) | yaklaşık €4–6 + IPv4 €0,50 | Ucuz, güvenilir, 4 GB RAM | Yurt dışı IP (ÜBYS erişimi test edilmeli). 2026 zamlarından sonra fiyatlar tutarsız, bazı planlar zaman zaman sipariş edilemiyor |
| **Oracle Cloud Always Free (Ampere A1)** | 0 | Ücretsiz, ARM | 2026'da kota yarıya indi (2 OCPU / 12 GB olarak bildiriliyor). Bölge kapasitesi sorunları var, kredi kartı doğrulaması isteniyor, yurt dışı IP |
| **Türkiye lokasyonlu VPS** (yerel sağlayıcılar) | genellikle Hetzner'den biraz pahalı | Türkiye IP'si: coğrafi engel riski en düşük | Sağlayıcı kalitesi değişken |
| **Evde sürekli açık cihaz** (Raspberry Pi 4/5, eski PC) | elektrik | Ev IP'si = Mac ile aynı ağ, oturum taşıma ve IP bağı sorunu yok | Ev internetine ve elektriğe bağlı, ilk kurulum emeği |

**Öneri:** Önce ucuz bir yurt dışı VPS'te (Hetzner) `check-reachability.sh` çalıştır. Üç site de
`200` dönerse orada kal. ÜBYS engelleniyorsa Türkiye lokasyonlu bir VPS'e ya da ev cihazına geç.
Docker imajı `amd64` ve `arm64` için çalışır.

## Kurulum (sunucu)

```bash
# 1) Sunucuda Docker (Ubuntu 24.04)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # sonra yeniden bağlan

# 2) Mac'ten: önce şifreleme anahtarı (.env) ve şifreli oturumlar — ilk kez --with-env ile
scripts/push-session.sh kullanici@sunucu unitakip --with-env

# 3) Mac'ten: kod + yapılandırma, konteyneri derle ve başlat (.env yoksa betik durur ve uyarır)
scripts/deploy-vps.sh kullanici@sunucu

# 4) Sunucuda kontrol
ssh kullanici@sunucu 'cd unitakip && docker compose logs --tail 50 unitakip && docker compose exec unitakip unitakip status'
```

## Kesintisiz çalışma davranışı

| Durum | Davranış |
|---|---|
| Sunucu yeniden başlatıldı | `restart: unless-stopped` konteyneri kaldırır. `next_run_at` SQLite'ta tutulduğu için vakti geçen platformlar hemen, diğerleri zamanında çalışır |
| Çalışma ortasında kesinti | DB yazımları transaction içinde. Yarım indirmeler (`data/files/.tmp`) açılışta silinir. Gönderilemeyen bildirimler `changes.notified_at IS NULL` olarak bekler ve tekrar gönderilir |
| Geçici ağ hatası | İstek düzeyinde 3 deneme (üstel geri çekilme, `Retry-After` desteği). Platform düzeyinde 10 → 20 → 40 → 60 dk. 6 ardışık hatadan sonra tek bir "erişilemiyor" e-postası |
| Oturum düştü | O platform "expired" olarak işaretlenir. Diğer platformlar etkilenmez. 24 saatte en fazla bir "yeniden giriş gerekli" e-postası |
| Gmail gönderemiyor | Değişiklikler **hiçbir zaman** düşürülmez. 10 → 20 → 40 → 60 dk aralıklarla, kanal düzelene kadar yeniden denenir. Bozuk tek bir kayıt diğerlerini engellemez |
| Beklenmeyen hata | Zamanlayıcının her adımı korumalı: hata loglanır, döngü durmaz (Docker çökme döngüsü yok) |
| Çift örnek | `data/unitakip.lock` dosya kilidi ikinci örneği engeller |
| Sağlık | Docker `HEALTHCHECK`: `unitakip health` (heartbeat 20 dk'dan eskiyse sağlıksız) |
| Takılan kontrol | 25 dk'yı aşarsa bekçi süreci sonlandırır, `restart: unless-stopped` yeniden kaldırır |
| Sessiz arıza | Haftalık durum e-postası (Pazartesi 09:00). Gelmezse sistem çalışmıyordur. 24 saat başarılı kontrol yoksa ayrıca uyarı gelir |
| Disk dolu | < 500 MB boş alanda indirme durur, bildirimler sürer, günde bir uyarı |
| Veritabanı | Her gün `data/backups/` altına yedek (7 gün tutulur) |

## Site yükü

- Platform başına **saatte bir** kontrol (±4 dk rastgele kaydırma). Aynı sunucuya iki istek arasında en az 1,5 sn bekleniyor.
- Sanal Öğrenme'de ders başına yaklaşık 3 WS çağrısı yapılıyor: 8 ders için saatte ~30 küçük JSON isteği.
- ÜBYS'de görseller, fontlar ve medya engelleniyor, yalnızca yapılandırılan sayfalar açılıyor.
- Aynı dosya sürümü yeniden indirilmiyor (`source_key` + SHA-256).

## Yedekleme

`data/` klasörü (SQLite, arşiv, şifreli oturumlar) ve `.env` (anahtar) yeterli:
```bash
tar czf unitakip-yedek-$(date +%F).tgz data .env config/config.yaml
```
`.env` kaybolursa şifreli oturumlar çözülemez. Bu durumda yalnızca yeniden giriş gerekir, veri kaybı olmaz.

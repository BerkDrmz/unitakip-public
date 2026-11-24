#!/usr/bin/env bash
# Sunucunun (VPS) üniversite sitelerine erişebildiğini kontrol eder (yurt dışı IP engeli testi).
# VPS satın aldıktan hemen sonra, kurulumdan ÖNCE çalıştır.
set -u
for url in \
  "https://sanalogrenme.bartin.edu.tr/login/index.php" \
  "https://ogreniyorum.net/mooc/index.php?do=derskayitol" \
  "https://ubys.bartin.edu.tr/"; do
  code=$(curl -sS -o /dev/null -m 20 -w "%{http_code}" -A "Mozilla/5.0 UniTakip-check" "$url" 2>&1) || code="HATA: $code"
  printf "%-60s %s\n" "$url" "$code"
done
echo "Beklenen: üçü de 200. Zaman aşımı/403 → bu sunucunun IP'si engelleniyor olabilir (TR lokasyonlu sunucu dene)."

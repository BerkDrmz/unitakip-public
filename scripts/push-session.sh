#!/usr/bin/env bash
# Mac'teki ŞİFRELİ oturum/token dosyalarını sunucuya aktarır (yeniden girişten sonra).
# Kullanım: scripts/push-session.sh kullanici@sunucu [uzak_dizin] [--with-env]
#   --with-env : .env dosyasını da gönderir (yalnızca ilk kurulumda; anahtar iki tarafta AYNI olmalı)
set -euo pipefail
WITH_ENV=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--with-env" ]]; then WITH_ENV=1; else ARGS+=("$a"); fi
done
TARGET="${ARGS[0]:?Kullanım: $0 kullanici@sunucu [uzak_dizin] [--with-env]}"
REMOTE_DIR="${ARGS[1]:-unitakip}"
cd "$(dirname "$0")/.."
[ -d data/secrets ] || { echo "data/secrets yok: önce 'unitakip login <platform>' çalıştır."; exit 1; }
ssh "$TARGET" "mkdir -p '$REMOTE_DIR/data/secrets' && chmod 700 '$REMOTE_DIR/data/secrets'"
rsync -av --chmod=D700,F600 data/secrets/ "$TARGET:$REMOTE_DIR/data/secrets/"
if [[ $WITH_ENV == 1 ]]; then
  rsync -av --chmod=F600 .env "$TARGET:$REMOTE_DIR/.env"
fi
echo "Aktarıldı. Daemon bir sonraki kontrolde yeni oturumu otomatik okur (yeniden başlatma gerekmez)."

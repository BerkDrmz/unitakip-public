#!/usr/bin/env bash
# Kodu ve yapılandırmayı sunucuya kopyalayıp konteyneri (yeniden) başlatır.
# Ön koşul: sunucuda Docker + Compose eklentisi kurulu (docs/06-dagitim-vps.md).
# Kullanım: scripts/deploy-vps.sh kullanici@sunucu [uzak_dizin]
set -euo pipefail
TARGET="${1:?Kullanım: $0 kullanici@sunucu [uzak_dizin]}"
REMOTE_DIR="${2:-unitakip}"
cd "$(dirname "$0")/.."
# .env sunucuda yoksa docker compose "env file not found" ile durur: önce anahtarı ve oturumları gönder
if ! ssh "$TARGET" "test -f '$REMOTE_DIR/.env'"; then
  echo "Sunucuda $REMOTE_DIR/.env yok. Önce şunu çalıştır:"
  echo "  scripts/push-session.sh $TARGET $REMOTE_DIR --with-env"
  exit 1
fi
rsync -av --delete \
  --exclude .venv --exclude .git --exclude /data --exclude .env --exclude '__pycache__' --exclude .pytest_cache \
  ./ "$TARGET:$REMOTE_DIR/"
ssh "$TARGET" "cd '$REMOTE_DIR' && mkdir -p data && \
  export UNITAKIP_UID=\$(id -u) UNITAKIP_GID=\$(id -g) && \
  docker compose up -d --build && docker compose ps"

# Playwright resmi imajı: Chromium + tüm sistem bağımlılıkları hazır (Ubuntu 24.04 "noble", Python 3.12).
# Etiket, kurulan playwright paketiyle AYNI sürüm olmalı (tarayıcı derlemesi eşleşsin).
FROM mcr.microsoft.com/playwright/python:v1.64.0-noble

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TZ=Europe/Istanbul \
    UNITAKIP_CONFIG=/app/config/config.yaml \
    UNITAKIP_DATA_DIR=/app/data \
    HOME=/app/data/home

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN python3 -m pip install "playwright==1.64.0" && python3 -m pip install ".[anthropic]" \
    && mkdir -p /app/data /app/config \
    && chmod -R a+rX /app

# docker-compose.yml içinde `user:` ile ana makinedeki kullanıcının UID/GID'si kullanılır
# (./data bind-mount izinleri için). Doğrudan `docker run` ile çalıştırılırsa pwuser kullanılır.
USER pwuser

HEALTHCHECK --interval=5m --timeout=30s --start-period=15m --retries=3 \
  CMD ["unitakip", "health", "--max-age-minutes", "20"]

ENTRYPOINT ["unitakip"]
CMD ["daemon"]

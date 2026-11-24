#!/usr/bin/env bash
# Mac'te bir kez: sanal ortam, bağımlılıklar, Chromium (Playwright) ve init.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null || { echo "uv gerekli: https://docs.astral.sh/uv/getting-started/installation/"; exit 1; }
[ -d .venv ] || uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/playwright install chromium          # yaklaşık 150 MB, yalnızca ilk kurulumda
.venv/bin/unitakip init                        # config/config.yaml + .env (şifreleme anahtarı)
echo
echo "Kurulum tamam. Sıradaki adımlar (docs/08-kurulum.md):"
echo "  .venv/bin/unitakip login sanal"
echo "  .venv/bin/unitakip discover sanal"

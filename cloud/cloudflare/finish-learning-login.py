"""Eski komut (geriye uyumluluk): Öğreniyorum.net oturumunu yeniler.

Yerine genel komutu kullan: python3 cloud/cloudflare/refresh-session.py ogreniyorum
"""
from __future__ import annotations

import os
from pathlib import Path
import sys

if __name__ == "__main__":
    script = Path(__file__).with_name("refresh-session.py")
    os.execv(sys.executable, [sys.executable, str(script), "ogreniyorum", *sys.argv[1:]])

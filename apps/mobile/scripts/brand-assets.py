#!/usr/bin/env python3
"""Generates every PrintFlow logo asset from one square piece of artwork.

Run it whenever the mark changes, so the web icons, the installable-app icons and
the mobile icon, adaptive icon and splash all come from the same file and can
never drift apart:

    pip install pillow
    python3 scripts/brand-assets.py path/to/printflow-mark.png

The artwork should be square and at least 1024x1024, and it carries its own dark
field — INK below is that field's colour, so the insets Android and iOS need are
seamless rather than a square sitting on a different background.
"""

import os
import sys

from PIL import Image

INK = (0, 9, 6)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# (path relative to the repo root, pixel size, how much of the frame the mark fills)
TARGETS = [
    # Web: the mark used inline in the interface and on the loader screen.
    ("apps/web/public/brand/mark-1024.png", 1024, 1.0),
    ("apps/web/public/brand/mark-512.png", 512, 1.0),
    ("apps/web/public/brand/mark-256.png", 256, 1.0),
    ("apps/web/public/brand/mark-128.png", 128, 1.0),
    ("apps/web/public/brand/mark-64.png", 64, 1.0),
    # Web: installable-app and browser icons.
    ("apps/web/public/icons/icon-192.png", 192, 1.0),
    ("apps/web/public/icons/icon-512.png", 512, 1.0),
    ("apps/web/public/icons/apple-touch-icon.png", 180, 1.0),
    ("apps/web/public/icons/favicon-32.png", 32, 1.0),
    # Android crops a maskable icon to a circle, so keep the mark inside the inner 80%.
    ("apps/web/public/icons/maskable-512.png", 512, 0.72),
    # Mobile: app icon, Android adaptive foreground, splash and the Expo web favicon.
    ("apps/mobile/assets/icon.png", 1024, 1.0),
    ("apps/mobile/assets/adaptive-icon.png", 1024, 0.70),
    ("apps/mobile/assets/splash-icon.png", 1024, 1.0),
    ("apps/mobile/assets/favicon.png", 48, 1.0),
]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = Image.open(sys.argv[1]).convert("RGB")
    if src.width != src.height:
        print(f"the artwork must be square; this one is {src.width}x{src.height}")
        return 1
    if src.width < 1024:
        print(f"warning: {src.width}px artwork will be upscaled for the 1024px targets")

    for rel, size, fill in TARGETS:
        canvas = Image.new("RGB", (size, size), INK)
        inner = max(1, round(size * fill))
        canvas.paste(src.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2,) * 2)
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        canvas.save(path, "PNG", optimize=True)
        print(f"{rel}  {size}x{size}")

    print("\nBump VERSION in apps/web/public/sw.js so installed web apps re-cache the icons.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
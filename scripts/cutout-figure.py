"""
Cuts the studio background out of a generated figure and writes a real PNG
with an alpha channel.

WHY PYTHON. Leonardo returns JPEG whatever extension you save it under, and
node in this repo has no JPEG decoder — no sharp, no jimp, no canvas. Pillow is
already on this machine and reads JPEG natively, so this is ~60 lines instead
of a hand-rolled decoder plus a dependency nobody asked for.

WHY NOT mix-blend-mode. Multiply over a light surface hides a white background
for free and needs no processing — but it tints the figure with whatever is
behind it, so it only works on near-white surfaces. A real alpha channel works
anywhere, including a dark or violet panel.

HOW THE KEY WORKS. The figure is a white matte shell on an even white studio
background, so a plain luminance threshold would eat the figure itself. This
floods inward from the border instead: only background actually CONNECTED to
the edge is removed, so a white shell enclosed by its own darker outline
survives. Pixels between KEEP and CUT get partial alpha, which is what stops
the cutout having a hard, aliased halo.

Usage:
    python scripts/cutout-figure.py ../aspect-react-client/public/otto/otto.png
    python scripts/cutout-figure.py in.png --out out.png --threshold 234
"""

import sys
import os
from collections import deque
from PIL import Image

args = sys.argv[1:]
if not args:
    sys.exit('Usage: python scripts/cutout-figure.py <image> [--out <file>] [--threshold 234]')

SRC = args[0]


def flag(name, default):
    return args[args.index(name) + 1] if name in args else default


OUT = flag('--out', os.path.splitext(SRC)[0] + '-cut.png')
# 215, not 234: the render has a soft studio vignette around the figure that
# is dimmer than 234, so a higher threshold stops the flood short and leaves a
# visible white halo. 215 clears it. Going below ~205 starts eating the
# figure's own bright shell where it meets the background without a dark
# outline — the left forearm is the first thing to go.
CUT = int(flag('--threshold', '215'))
KEEP = CUT - 22                          # below this it is definitely the figure

if not os.path.exists(SRC):
    sys.exit(f'not found: {SRC}')

img = Image.open(SRC).convert('RGBA')
w, h = img.size
px = img.load()

lum = bytearray(w * h)
for y in range(h):
    for x in range(w):
        r, g, b, _ = px[x, y]
        lum[y * w + x] = (r * 299 + g * 587 + b * 114) // 1000

# Flood from every border pixel. Only light regions connected to the edge are
# background; an enclosed white shell is not reachable and stays.
seen = bytearray(w * h)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        i = y * w + x
        if lum[i] >= CUT and not seen[i]:
            seen[i] = 1
            q.append(i)
for y in range(h):
    for x in (0, w - 1):
        i = y * w + x
        if lum[i] >= CUT and not seen[i]:
            seen[i] = 1
            q.append(i)

while q:
    i = q.popleft()
    x, y = i % w, i // w
    for j in ((i - 1) if x else -1, (i + 1) if x < w - 1 else -1,
              (i - w) if y else -1, (i + w) if y < h - 1 else -1):
        if j >= 0 and not seen[j] and lum[j] >= CUT:
            seen[j] = 1
            q.append(j)

# A second, softer pass: background-adjacent pixels in the KEEP..CUT band are
# the figure's own soft shadow edge. Ramping their alpha is what removes the
# halo a hard cut leaves behind.
cleared = soft = 0
for i in range(w * h):
    if not seen[i]:
        continue
    x, y = i % w, i // w
    l = lum[i]
    if l >= CUT:
        alpha = 0
        cleared += 1
    else:
        alpha = int(255 * (1 - (l - KEEP) / (CUT - KEEP)))
        alpha = max(0, min(255, alpha))
        soft += 1
    r, g, b, _ = px[x, y]
    px[x, y] = (r, g, b, alpha)

# Crop to the figure's own bounding box. The generator centres a ~320px figure
# in a 1024x1024 canvas, so two thirds of the file is transparent air — and any
# size set in CSS then sizes the air, not the figure. Otto rendered at a third
# of his specified width for exactly this reason.
bbox = img.getbbox()
if bbox:
    pad = 8
    l, t, r, b = bbox
    img = img.crop((max(0, l - pad), max(0, t - pad),
                    min(img.width, r + pad), min(img.height, b + pad)))

img.save(OUT, 'PNG')

total = w * h
pct = cleared / total * 100
print(f'{os.path.basename(SRC)} -> {os.path.basename(OUT)}')
print(f'  {w}x{h} -> {img.width}x{img.height} · cleared {pct:.1f}% · soft edge {soft} px')
if pct < 20:
    print('  WARNING: very little removed — raise --threshold')
if pct > 90:
    print('  WARNING: almost everything removed — lower --threshold')

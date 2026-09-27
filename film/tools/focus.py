# /// script
# dependencies = ["numpy", "pillow"]
# ///
"""Where the live tile is in a prepped take: finds the player's red LIVE dot mid-stream and returns the tile centre
as a fraction of the 1920x1080 deck frame (the clip is fit to the width and centred vertically).
usage: .venv/bin/python focus.py <name>"""
import json, subprocess, sys, tempfile, os
import numpy as np
from PIL import Image
n = sys.argv[1]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
m = json.load(open(f"{root}/deck/media/{n}-3.json"))
k = m["marks"]
out = []
for f in (0.3, 0.5, 0.7):
    t = k["play"] + 2 + f * (k["done"] - k["play"] - 2)
    p = tempfile.mktemp(suffix=".png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", f"{root}/deck/media/{n}-3.mp4", "-frames:v", "1", p], check=True)
    im = np.asarray(Image.open(p).convert("RGB")).astype(int); os.remove(p)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    ys, xs = np.where((r > 220) & (g < 90) & (b < 80))
    if len(ys) < 4: continue
    H, W = im.shape[:2]
    # dot sits ~(16, 14) px (at 1920 wide) inside the tile's top-left; the tile is ~404 x 236 px at this width
    x0, y0 = np.median(xs) - 16 * W / 1920, np.median(ys) - 14 * W / 1920
    cx, cy = x0 + 202 * W / 1920, y0 + 118 * W / 1920
    top = (1080 - H * 1920 / W) / 2
    out.append((cx / W, (top + cy * 1920 / W) / 1080))
if not out: sys.exit("no LIVE dot found")
fx, fy = np.median([o[0] for o in out]), np.median([o[1] for o in out])
print(json.dumps([round(fx, 3), round(fy, 3)]))

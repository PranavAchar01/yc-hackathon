# /// script
# dependencies = ["numpy", "pillow"]
# ///
"""Click Slack's green primary button: the lowest one in the window, or the one inside the modal.
usage: uv run clickgreen.py <CG window id> [lowest|modal]
Screenshots the window (screencapture -l), finds pixel runs of Slack's button green, clicks the chosen blob's centre
with tools/click (window at screen points x0,y0 from tools/wins)."""
import subprocess, sys, tempfile, os
import numpy as np
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
wid, mode = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "lowest")
f = tempfile.mktemp(suffix=".png")
subprocess.run(["screencapture", "-x", "-o", "-l", wid, f], check=True)
im = np.asarray(Image.open(f).convert("RGB")).astype(int); os.remove(f)
H, W, _ = im.shape
r, g, b = im[..., 0], im[..., 1], im[..., 2]
mask = (g > 105) & (g < 150) & (r < 70) & (b > 70) & (b < 120) & (g - r > 60)
rows = np.where(mask.sum(1) > 40)[0]
if len(rows) == 0: sys.exit("no green button")
# group rows into blobs
blobs, start = [], rows[0]
for a, c in zip(rows, rows[1:]):
    if c - a > 3: blobs.append((start, a)); start = c
blobs.append((start, rows[-1]))
blobs = [(a, c) for a, c in blobs if c - a > 20]
if not blobs: sys.exit("no green button")
a, c = blobs[-1]
cols = np.where(mask[a:c + 1].sum(0) > 5)[0]
cx, cy = (cols.min() + cols.max()) / 2, (a + c) / 2
line = next(l for l in subprocess.run([f"{here}/wins"], capture_output=True, text=True).stdout.splitlines() if l.startswith(wid + "\t"))
x0, y0, w, h = map(float, line.split("\t")[1].split(","))
sx, sy = x0 + cx * w / W, y0 + cy * (w / W)
print(f"click {sx:.0f},{sy:.0f}")
subprocess.run([f"{here}/click", f"{sx:.0f}", f"{sy:.0f}"], check=True)

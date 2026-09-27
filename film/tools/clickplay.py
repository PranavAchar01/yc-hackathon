# /// script
# dependencies = ["numpy", "pillow"]
# ///
"""Click the play button ("▶ Video") of the lowest video tile in the Slack window.
usage: uv run clickplay.py <CG window id> [--dry]
Matches play-template.png (Slack's pill, 2x) on the white glyph pixels only, so the thumbnail behind it doesn't
matter; picks the lowest strong match and clicks it through tools/click (window position from tools/wins)."""
import os, subprocess, sys, tempfile
import numpy as np
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
wid, dry = sys.argv[1], "--dry" in sys.argv
f = tempfile.mktemp(suffix=".png")
subprocess.run(["screencapture", "-x", "-o", "-l", wid, f], check=True)
im = np.asarray(Image.open(f).convert("L")).astype(np.float32); os.remove(f)
tp = np.asarray(Image.open(os.path.join(here, "play-template.png")).convert("L")).astype(np.float32)
S = 2  # search at half resolution
# The tile is left-aligned with message text, so its play button is always in the same column: search only there.
X0, X1 = 950, 1450
img = (im[::S, X0:X1:S] > 215).astype(np.float32)
tpl = (tp[::S, ::S] > 215).astype(np.float32)
th, tw = tpl.shape
H, W = img.shape
n = tpl.sum()
# score = fraction of template white pixels that are white in the image, minus stray white inside the box
from numpy.lib.stride_tricks import sliding_window_view
win = sliding_window_view(img, (th, tw))
hit = np.tensordot(win, tpl, axes=((2, 3), (0, 1))) / n
extra = (win.sum(axis=(2, 3)) - hit * n) / (th * tw)
score = hit - extra
ys, xs = np.where(score > 0.65)
if len(ys) == 0:
    b = np.unravel_index(np.argmax(score), score.shape); sys.exit(f"no play button (best {score.max():.2f} at {b[1]*S},{b[0]*S})")
i = np.argmax(ys)  # lowest on screen
y, x = ys[i], xs[i]
cx, cy = X0 + (x + tw / 2) * S, (y + th / 2) * S
line = next(l for l in subprocess.run([f"{here}/wins"], capture_output=True, text=True).stdout.splitlines() if l.startswith(wid + "\t"))
x0, y0, w, h = map(float, line.split("\t")[1].split(","))
k = w / im.shape[1]
sx, sy = x0 + cx * k, y0 + cy * k
print(f"play at {sx:.0f},{sy:.0f} score {score[y, x]:.2f}")
if dry:
    m = score.copy()
    for yy, xx in zip(ys, xs): m[max(0, yy - th):yy + th, max(0, xx - tw):xx + tw] = -1
    print(f"best elsewhere {m.max():.2f}")
if not dry:
    subprocess.run([f"{here}/click", f"{sx:.0f}", f"{sy:.0f}"], check=True)

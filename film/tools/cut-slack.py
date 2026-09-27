"""Drop stretches where the maximized Slack window covered the agent's browser in a prepped agent clip.
Classifies each frame by the left sidebar strip: Slack's aubergine sidebar vs anything else (GitHub).
Writes deck/media/<name>-agent.mp4 (cut) and adds "timemap" (source time per output frame) to <name>.json."""
import json, subprocess, sys
import numpy as np

name = sys.argv[1]
src = f"deck/media/{name}-agent.mp4"
w, h = 160, 90
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                     capture_output=True, check=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).astype(int)
strip = frames[:, 15:80, 1:8, :].mean(axis=(1, 2))           # left edge, below the tab bar
r, g, b = strip[:, 0], strip[:, 1], strip[:, 2]
slack = (r > 40) & (b > 40) & (g < 0.7 * np.minimum(r, b))    # purple: red and blue high, green low
keep = ~slack
# smooth: drop 1-3 frame flickers either way
for i in range(1, len(keep) - 1):
    if keep[i - 1] == keep[i + 1] != keep[i]:
        keep[i] = keep[i - 1]
idx = np.nonzero(keep)[0]
print(f"{name}: {len(keep)} frames, keeping {len(idx)} ({100*len(idx)/len(keep):.0f}%)")
fps = 30
expr = "+".join(f"between(n,{a},{b})" for a, b in _runs(idx)) if False else None
# build contiguous runs
runs, start = [], idx[0]
for a, b in zip(idx[:-1], idx[1:]):
    if b != a + 1:
        runs.append((start, a)); start = b
runs.append((start, idx[-1]))
sel = "+".join(f"between(n\\,{a}\\,{b})" for a, b in runs)
tmp = src.replace(".mp4", ".cut.mp4")
subprocess.run(["nice", "-n", "19", "ffmpeg", "-v", "error", "-y", "-i", src, "-vf", f"select='{sel}',setpts=N/{fps}/TB",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-g", "1", "-an", "-movflags", "+faststart", tmp], check=True)
subprocess.run(["mv", tmp, src], check=True)
meta = json.load(open(f"deck/media/{name}.json"))
meta["timemap"] = [round(float(i) / fps, 3) for i in idx]      # output frame k shows source time timemap[k]
meta["duration"] = len(idx) / fps
json.dump(meta, open(f"deck/media/{name}.json", "w"))
print(f"{name}: {len(runs)} cuts, new duration {meta['duration']:.1f}s")

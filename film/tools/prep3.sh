#!/bin/zsh
# Prep a Slack-only take for the deck: raw/<name>.mov -> deck/media/<name>-3.mp4 (all-intra, 30 fps, 1920 wide)
# + deck/media/<name>-3.json {dur, marks}. Only the browser's own bars are cut (tab strip, address bar and the
# "BrowserSkill started debugging" infobar, 14.6% of the window height); Slack itself is scaled, never cropped.
# raw/<name>.marks: lines "<label> <epoch-ms>" written during the take (sent, done, verify, ...).
# BOTCROP: fraction cut off the bottom (Slack's notification-permission strip under the composer).
# usage: film/tools/prep3.sh <name>
set -eu
N=$1
cd ${0:A:h}/..
OUT=deck/media; mkdir -p $OUT
nice -n 19 ffmpeg -v error -y -i raw/$N.mov \
  -vf "crop=iw:ih-trunc(ih*${TOPCROP:-0.087}/2)*2-trunc(ih*${BOTCROP:-0}/2)*2:0:trunc(ih*${TOPCROP:-0.087}/2)*2,fps=30,scale=${WIDTH:-1920}:-2:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset medium -crf 18 -g 1 -an -movflags +faststart -video_track_timescale 15360 $OUT/$N-3.mp4
python3 - "$N" <<'PY'
import json, subprocess, sys
n = sys.argv[1]
dur = float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f"deck/media/{n}-3.mp4"],capture_output=True,text=True).stdout)
t0 = int(open(f"raw/{n}.t0").read())
marks = {}
try:
    for line in open(f"raw/{n}.marks"):
        k, v = line.split(); marks[k] = round((int(v) - t0) / 1000, 2)
except FileNotFoundError:
    pass
m = {"name": n, "dur": dur, "marks": marks}
json.dump(m, open(f"deck/media/{n}-3.json", "w")); print(m)
PY

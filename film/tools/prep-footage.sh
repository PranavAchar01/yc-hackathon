#!/bin/zsh
# Prep one full-screen take (from take.sh) for the deck, frame-exact and sped up.
# usage: film/tools/prep-footage.sh <name> [speed=1] [start_s=0] [end_s=end]
#   in:  raw/<name>.mp4 (screen), raw/<name>.t0 (capture start, epoch ms), raw/<name>-slack/<epoch-ms>.png
#   out: deck/media/<name>-agent.mp4 (all-intra), deck/media/<name>-slack/NNNN.jpg + <name>.json
# Heavy encodes run at nice 19 (a long research render shares this machine).
set -eu
NAME=$1; SPEED=${2:-1}; SS=${3:-0}; TO=${4:-}
cd ${0:A:h}/..
OUT=deck/media; mkdir -p $OUT/$NAME-slack
TRIM=(-ss $SS); [ -n "$TO" ] && TRIM+=(-to $TO)
# Full screen is 3420 x 2224 px (2x). Keep y 136-1036 pt: below the tab/address/debug bars, above the Dock.
nice -n 19 ffmpeg -v error -y $TRIM -i raw/$NAME.mp4 \
  -vf "crop=3420:1800:0:272,setpts=PTS/$SPEED,fps=30,scale=1600:-2:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset medium -crf 18 -g 1 -an -movflags +faststart $OUT/$NAME-agent.mp4
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUT/$NAME-agent.mp4)
# Slack frames: keep the message column, as JPEGs, with times relative to the trimmed clip start.
python3 - "$NAME" "$SS" <<'PY'
import json, os, subprocess, sys
name, ss = sys.argv[1], float(sys.argv[2])
t0 = int(open(f"raw/{name}.t0").read().strip())
src = f"raw/{name}-slack"
frames = sorted(f for f in os.listdir(src) if f.endswith(".png"))
out = []
for i, f in enumerate(frames):
    t = (int(f[:-4]) - t0) / 1000 - ss
    if t < -5: continue
    dst = f"deck/media/{name}-slack/{i:04d}.jpg"
    subprocess.run(["nice", "-n", "19", "sips", "-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", "1400", f"{src}/{f}", "--out", dst], capture_output=True)
    out.append({"t": round(t, 2), "src": f"media/{name}-slack/{i:04d}.jpg"})
json.dump(out, open(f"deck/media/{name}-slack.json", "w"))
print(len(out), "slack frames")
PY
printf '{"name":"%s","speed":%s,"duration":%s,"start":%s}\n' $NAME $SPEED $DUR $SS > $OUT/$NAME.json
echo "prepped $NAME: ${DUR}s at ${SPEED}x"

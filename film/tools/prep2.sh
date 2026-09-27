#!/bin/zsh
# Prep a two-view take for the deck: both videos frame-exact (all-intra, 30 fps, 1920 wide) + timing json.
# usage: film/tools/prep2.sh <cmd>
set -eu
CMD=$1
cd ${0:A:h}/..
OUT=deck/media; mkdir -p $OUT
# AGENT_TOP_CROP=<px>: cut that many source pixels off the top of the agent view, e.g. the browser toolbar and
# Chrome's "BrowserSkill started debugging this browser" infobar (it sits above the page; we cannot hide it).
# Default 0 keeps the whole window.
AGENT_TOP_CROP=${AGENT_TOP_CROP:-0}
for v in slack agent; do
  CROP=""
  [ "$v" = agent ] && [ "$AGENT_TOP_CROP" -gt 0 ] && CROP="crop=iw:ih-$AGENT_TOP_CROP:0:$AGENT_TOP_CROP,"
  nice -n 19 ffmpeg -v error -y -i raw/$CMD-$v.mov -vf "${CROP}fps=30,scale=1920:-2:flags=lanczos,format=yuv420p" \
    -c:v libx264 -preset medium -crf 18 -g 1 -an -movflags +faststart -video_track_timescale 15360 $OUT/$CMD-$v.mp4
done
python3 - "$CMD" <<'PY'
import json, subprocess, sys
c = sys.argv[1]
dur = lambda f: float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout)
t0 = int(open(f"raw/{c}.t0").read()); at0 = int(open(f"raw/{c}.agent.t0").read())
m = {"name": c, "slackDur": dur(f"deck/media/{c}-slack.mp4"), "agentDur": dur(f"deck/media/{c}-agent.mp4"), "agentOffset": (at0 - t0) / 1000}
json.dump(m, open(f"deck/media/{c}-2v.json", "w")); print(m)
PY

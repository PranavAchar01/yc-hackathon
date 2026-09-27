#!/bin/zsh
# Split one screen recording (from record-run.sh) into the two panes the film uses, sped up and frame-exact.
# usage: film/tools/prep-footage.sh <in.mov> <name> [speed=1] [start_s=0] [end_s=end]
#   -> film/deck/media/<name>-slack.mp4 (left half), <name>-agent.mp4 (right half), <name>.json (duration, speed)
# All-intra H.264 (-g 1) so the renderer's per-frame seek lands exactly, with no decode drift.
set -eu
IN=$1; NAME=$2; SPEED=${3:-1}; SS=${4:-0}; TO=${5:-}
OUTDIR=${0:A:h}/../deck/media
mkdir -p $OUTDIR
# Recording is 2x Retina: 3420 x 2224 px. Keep y 136-1036 pt (below the tab, address and debug bars, above the Dock).
TRIM=(-ss $SS); [ -n "$TO" ] && TRIM+=(-to $TO)
for pane in slack agent; do
  X=$([ $pane = slack ] && echo 0 || echo 1710)
  ffmpeg -v error -y $TRIM -i $IN \
    -vf "crop=1710:1800:$X:272,setpts=PTS/$SPEED,fps=30,scale=1140:-2:flags=lanczos,format=yuv420p" \
    -c:v libx264 -preset medium -crf 18 -g 1 -an -movflags +faststart $OUTDIR/$NAME-$pane.mp4
done
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $OUTDIR/$NAME-agent.mp4)
printf '{"name":"%s","speed":%s,"duration":%s}\n' $NAME $SPEED $DUR > $OUTDIR/$NAME.json
echo "prepped $NAME: ${DUR}s at ${SPEED}x"

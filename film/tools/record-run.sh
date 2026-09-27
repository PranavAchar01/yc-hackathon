#!/bin/zsh
# Record one real run full screen: the agent's browser window fills the screen and is captured at up to 60 fps.
# Slack is captured separately and in the background from its own page (bsk screenshots, ~1 per second, each
# named by capture time) so the card can be laid over the footage in time.
# usage: film/tools/record-run.sh <out.mp4> <max-seconds> <slack-bsk-session>
#   Stop early: touch <out.mp4>.stop
# Workspace rule: never pkill/killall by name. This script only signals the PIDs it started.
set -u
OUT=$1; MAX=${2:-420}; SLACK=${3:-}
W=1710; H=1040; TOP=25
SLACKDIR="${OUT%.*}-slack"; mkdir -p "$SLACKDIR"

caffeinate -dimsu -t $((MAX + 30)) &
CAF=$!
osascript -e 'tell application "Google Chrome" to activate' >/dev/null
sleep 0.5
before=$(osascript -e 'tell application "Google Chrome" to get id of every window' | tr -d ' ')

# New Agent Windows fill the screen (above the Dock) and stay in front.
(
  while [ ! -e "$OUT.stop" ]; do
    for id in $(osascript -e 'tell application "Google Chrome" to get id of every window' | tr -d ' ' | tr ',' ' '); do
      case ",$before," in *",$id,"*) ;; *)
        osascript -e "tell application \"Google Chrome\" to set bounds of (first window whose id is $id) to {0, $TOP, $W, $H}" \
                  -e "tell application \"Google Chrome\" to set index of (first window whose id is $id) to 1" >/dev/null 2>&1 ;;
      esac
    done
    sleep 0.5
  done
) &
ARR=$!

# Slack card, captured from the page itself.
(
  [ -z "$SLACK" ] && exit 0
  while [ ! -e "$OUT.stop" ]; do
    bsk screenshot --session "$SLACK" --out "$SLACKDIR/$(python3 -c 'import time;print(int(time.time()*1000))').png" >/dev/null 2>&1
    sleep 0.3
  done
) &
SNAP=$!

ffmpeg -v error -y -f avfoundation -capture_cursor 1 -framerate 60 -i "4:none" \
  -c:v h264_videotoolbox -b:v 30M -pix_fmt yuv420p "$OUT" </dev/null >/dev/null 2>&1 &
REC=$!
python3 -c 'import time;print(int(time.time()*1000))' > "${OUT%.*}.t0"
END=$((SECONDS + MAX))
while kill -0 $REC 2>/dev/null && [ ! -e "$OUT.stop" ] && [ $SECONDS -lt $END ]; do sleep 0.5; done
for k in 1 2 3 4 5 6; do kill -0 $REC 2>/dev/null || break; kill -INT $REC 2>/dev/null; sleep 3; done
wait $REC 2>/dev/null
touch "$OUT.stop"; wait $ARR $SNAP 2>/dev/null; rm -f "$OUT.stop"; kill $CAF 2>/dev/null
echo "recorded $OUT ($(ls "$SLACKDIR" | wc -l | tr -d ' ') Slack frames)"

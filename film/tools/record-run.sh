#!/bin/zsh
# Record one real run at up to 60 fps: the agent's browser window on the LEFT half (where BrowserSkill opens
# Agent Windows), Slack on the RIGHT half.
# usage: film/tools/record-run.sh <out.mp4> <max-seconds>
#   Stop early: touch <out.mp4>.stop   (ffmpeg gets SIGINT by pid and finalizes the file)
set -u
OUT=$1; MAX=${2:-420}
W=1710; H=1040; TOP=25; MID=$((W / 2))

caffeinate -dimsu -t $((MAX + 30)) &
CAF=$!
osascript -e 'tell application "Google Chrome" to activate' >/dev/null
sleep 0.5
before=$(osascript -e 'tell application "Google Chrome" to get id of every window' | tr -d ' ')
osascript -e "tell application \"Google Chrome\"
  repeat with w in windows
    if URL of active tab of w contains \"app.slack.com\" then
      set bounds of w to {$MID, $TOP, $W, $H}
      set index of w to 1
    end if
  end repeat
end tell" >/dev/null

# New Agent Windows: best effort to pin them to the left half.
(
  while [ ! -e "$OUT.stop" ]; do
    for id in $(osascript -e 'tell application "Google Chrome" to get id of every window' | tr -d ' ' | tr ',' ' '); do
      case ",$before," in *",$id,"*) ;; *)
        osascript -e "tell application \"Google Chrome\" to set bounds of (first window whose id is $id) to {0, $TOP, $MID, $H}" >/dev/null 2>&1 ;;
      esac
    done
    sleep 0.5
  done
) &
ARR=$!

ffmpeg -v error -y -f avfoundation -capture_cursor 1 -framerate 60 -i "4:none" \
  -c:v h264_videotoolbox -b:v 30M -pix_fmt yuv420p "$OUT" </dev/null >/dev/null 2>&1 &
REC=$!
END=$((SECONDS + MAX))
while kill -0 $REC 2>/dev/null && [ ! -e "$OUT.stop" ] && [ $SECONDS -lt $END ]; do sleep 0.5; done
kill -INT $REC 2>/dev/null; wait $REC 2>/dev/null
touch "$OUT.stop"; wait $ARR 2>/dev/null; rm -f "$OUT.stop"; kill $CAF 2>/dev/null
echo "recorded $OUT"
# Workspace rule: never pkill/killall by name. This script only signals the PIDs it started ($REC, $ARR, $CAF).

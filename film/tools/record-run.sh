#!/bin/zsh
# Record one real run: Slack on the left half of the screen, the agent's browser window on the right half.
# usage: film/tools/record-run.sh <out.mov> <max-seconds>
#   Windows that exist when this starts are "ours"; any Chrome window that appears later is an Agent Window
#   (BrowserSkill opens one per session) and is pinned to the right half until recording stops.
# Stop early: touch <out.mov>.stop
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
      set bounds of w to {0, $TOP, $MID, $H}
      set index of w to 1
    end if
  end repeat
end tell" >/dev/null

(
  while [ ! -e "$OUT.stop" ]; do
    for id in $(osascript -e 'tell application "Google Chrome" to get id of every window' | tr -d ' ' | tr ',' ' '); do
      case ",$before," in *",$id,"*) ;; *)
        osascript -e "tell application \"Google Chrome\" to set bounds of (first window whose id is $id) to {$MID, $TOP, $W, $H}" -e "tell application \"Google Chrome\" to set index of (first window whose id is $id) to 1" >/dev/null 2>&1 ;;
      esac
    done
    sleep 0.5
  done
) &
ARR=$!

screencapture -v -x -V "$MAX" "$OUT" &
REC=$!
while kill -0 $REC 2>/dev/null && [ ! -e "$OUT.stop" ]; do sleep 0.5; done
pkill -INT -x screencapture 2>/dev/null; wait $REC 2>/dev/null; kill $CAF 2>/dev/null
touch "$OUT.stop"; wait $ARR 2>/dev/null; rm -f "$OUT.stop"
echo "recorded $OUT"

#!/bin/zsh
# Slack-only recording (ScreenCaptureKit, the Slack Chrome window at 30 fps), started and stopped separately
# so a take can include clicks between runs.
#   rec.sh start <name> [channel-id]   raises the Slack window on that channel, starts raw/<name>.mov
#   rec.sh stop  <name>
# Only signals PIDs it started (workspace rule).
set -u
cd ${0:A:h}/..
OP=$1; NAME=$2; CH=${3:-}
STOP=raw/$NAME.stop
if [ $OP = start ]; then
  rm -f $STOP raw/$NAME.mov
  osascript -e "tell application \"Google Chrome\"
    activate
    repeat with w in windows
      if title of active tab of w contains \" - YC\" and URL of active tab of w contains \"app.slack.com/client\" then
        if \"$CH\" is not \"\" then set URL of active tab of w to \"https://app.slack.com/client/T0C4YS898AU/$CH\"
        set bounds of w to {0, 25, 1710, 1112}
        set index of w to 1
      end if
    end repeat
  end tell" >/dev/null
  sleep 5
  SW=$(./tools/wins | grep -E " - YC( - |$)" | grep -i slack | head -1 | cut -f1)
  [ -z "$SW" ] && { echo "no Slack window"; exit 1; }
  ( while [ ! -e $STOP ]; do ./tools/nudge; sleep 20; done ) &
  echo $! > raw/$NAME.nudge.pid
  ./tools/winrec $SW raw/$NAME.mov $STOP 30 > raw/$NAME.log 2>&1 &
  echo $! > raw/$NAME.pid
  python3 -c 'import time;print(int(time.time()*1000))' > raw/$NAME.t0
  echo "recording window $SW -> raw/$NAME.mov"
else
  touch $STOP
  P=$(cat raw/$NAME.pid); N=$(cat raw/$NAME.nudge.pid)
  for i in {1..20}; do kill -0 $P 2>/dev/null || break; sleep 0.5; done
  kill -0 $P 2>/dev/null && kill -INT $P
  kill $N 2>/dev/null; rm -f $STOP raw/$NAME.pid raw/$NAME.nudge.pid
  ls -la raw/$NAME.mov
fi

#!/bin/zsh
# One filmed take, two real views recorded at the same time with ScreenCaptureKit (occlusion doesn't matter):
#   raw/<cmd>-slack.mov  the Slack window (#ops), where the command is typed and the live card runs
#   raw/<cmd>-agent.mov  the agent's own Chrome window, doing the work
# usage: film/tools/take2.sh <command-without-slash> [max-seconds=600]
# Only signals PIDs it started (workspace rule).
set -u
CMD=$1; MAX=${2:-600}
cd ${0:A:h}/..
LOG=../bot/.stage/bot.log
STOP=raw/$CMD.stop; rm -f $STOP raw/$CMD-slack.mov raw/$CMD-agent.mov
SLACK_URL="https://app.slack.com/client/T0C4YS898AU/C0C3YJ5CB7V"
./tools/nudge
( while [ ! -e $STOP ]; do ./tools/nudge; sleep 20; done ) & NUDGE=$!

SW=$(./tools/wins | grep -i "slack" | head -1 | cut -f1)
if [ -z "$SW" ]; then
  osascript -e "tell application \"Google Chrome\" to set w to make new window" -e "tell application \"Google Chrome\" to set URL of active tab of w to \"$SLACK_URL\"" >/dev/null
  sleep 8; SW=$(./tools/wins | grep -i "slack" | head -1 | cut -f1)
fi
osascript -e "tell application \"Google Chrome\"
  repeat with w in windows
    if URL of active tab of w contains \"app.slack.com\" then
      set URL of active tab of w to \"$SLACK_URL\"
      set bounds of w to {0, 25, 1710, 1112}
      set index of w to 1
    end if
  end repeat
  activate
end tell" >/dev/null
sleep 6
before=$(./tools/wins | cut -f1 | tr '\n' ',')
n0=$(grep -c "run $CMD" $LOG)
./tools/winrec $SW raw/$CMD-slack.mov $STOP 30 > raw/$CMD-slack.log 2>&1 & SREC=$!
python3 -c 'import time;print(int(time.time()*1000))' > raw/$CMD.t0
sleep 2
./tools/typer "/$CMD" 120
sleep 1.0
osascript -e 'tell application "System Events" to key code 36'   # pick the highlighted command
sleep 0.8
osascript -e 'tell application "System Events" to key code 36'   # send
echo "sent /$CMD at $(date +%T)"

AREC=""
END=$((SECONDS + MAX))
while [ $(grep -c "run $CMD" $LOG) -le $n0 ] && [ $SECONDS -lt $END ]; do
  if [ -z "$AREC" ]; then
    for id in $(./tools/wins | cut -f1); do
      case ",$before," in *",$id,"*) ;; *)
        ./tools/winrec $id raw/$CMD-agent.mov $STOP 30 > raw/$CMD-agent.log 2>&1 & AREC=$!
        python3 -c 'import time;print(int(time.time()*1000))' > raw/$CMD.agent.t0
        echo "agent window $id"; break ;;
      esac
    done
  fi
  sleep 0.3
done
sleep 5                          # hold on the finished Slack card
touch $STOP
wait $SREC 2>/dev/null; [ -n "$AREC" ] && wait $AREC 2>/dev/null; wait $NUDGE 2>/dev/null
rm -f $STOP
grep -E "run $CMD" $LOG | tail -1

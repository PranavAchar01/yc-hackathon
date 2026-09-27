#!/bin/zsh
# One filmed take of a real slash command.
# usage: film/tools/take.sh <command-without-slash> [max-seconds=600]
#   -> film/raw/<cmd>.mp4 (full-screen agent browser, up to 60 fps) + film/raw/<cmd>-slack/ (Slack card frames)
# Only signals PIDs it started. Stops the recorder 8 s after the bot logs the run's end.
set -u
CMD=$1; MAX=${2:-600}
cd ${0:A:h}/..
LOG=../bot/.stage/bot.log
S=$(bsk session start --json --no-focus 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["session_id"])')
[ -z "$S" ] && { echo "no bsk session"; exit 1; }
bsk navigate https://app.slack.com/client/T0C4YS898AU/C0C3YHQ4Q1Z --session $S >/dev/null 2>&1
bsk wait-for-navigation --session $S --timeout 15s >/dev/null 2>&1
n0=$(grep -c "run $CMD" $LOG)
./tools/nudge
( while [ ! -e raw/$CMD.done ]; do ./tools/nudge; sleep 20; done ) &
NUDGE=$!
./tools/record-run.sh raw/$CMD.mp4 $MAX $S &
RECPID=$!
sleep 3
send_cmd() {
  R=$(bsk observe --session $S 2>&1 | grep -oE '@e[0-9]+ textbox "Message to' | head -1 | cut -d' ' -f1)
  bsk click $R --session $S >/dev/null 2>&1
  for k in $(seq 1 12); do bsk press Backspace --session $S >/dev/null 2>&1; done
  bsk press "/" --session $S >/dev/null 2>&1
  for ((i=0;i<${#CMD};i++)); do
    bsk press "${CMD:$i:1}" --session $S >/dev/null 2>&1
    O=$(bsk observe --session $S 2>&1 | grep -oE "@e[0-9]+ button \"/$CMD · " | head -1 | cut -d' ' -f1)
    if [ -n "$O" ]; then bsk click $O --session $S >/dev/null 2>&1; bsk press Enter --session $S >/dev/null 2>&1; return 0; fi
  done
  return 1
}
for attempt in 1 2 3; do
  send_cmd && sleep 2 && bsk observe --session $S 2>&1 | grep -qE 'textbox "Message to[^"]*" \[empty\]' && break
  sleep 2
done
echo "sent /$CMD at $(date +%T)"
while [ $(grep -c "run $CMD" $LOG) -le $n0 ] && kill -0 $RECPID 2>/dev/null; do sleep 2; done
sleep 8
touch raw/$CMD.mp4.stop
wait $RECPID
touch raw/$CMD.done; wait $NUDGE 2>/dev/null; rm -f raw/$CMD.done
bsk session stop $S >/dev/null 2>&1
grep -E "run $CMD" $LOG | tail -1

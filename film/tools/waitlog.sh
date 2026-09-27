#!/bin/zsh
# Wait until a new bot log line matches a pattern (only lines written after this starts). usage: waitlog.sh <regex> [max-s=600]
set -u
LOG=${0:A:h}/../../bot/.stage/bot.log
n0=$(wc -l < $LOG); END=$((SECONDS + ${2:-600}))
while [ $SECONDS -lt $END ]; do
  M=$(tail -n +$((n0 + 1)) $LOG | grep -E "$1" | head -1)
  [ -n "$M" ] && { echo "$M" | cut -c1-200; exit 0; }
  sleep 0.5
done
echo "timeout waiting for $1"; exit 1

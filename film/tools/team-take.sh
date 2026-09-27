#!/bin/zsh
# The Speedrun take: /team in Slack, filmed from a BrowserSkill window (signed-in profile) with ScreenCaptureKit.
# Typing uses CGEvent keystrokes (the window must be in front at the start); every later click (Play, Send) goes
# through BrowserSkill, which works while agent windows cover Slack.
# usage: team-take.sh <slack-bsk-session> <CG window id> <channel id> "<request>"
set -u
cd ${0:A:h}/..
S=$1; SW=$2; CH=$3; REQ=$4
T=./tools; NAME=team
LOG=../bot/.stage/bot.log
rm -f raw/$NAME.marks
caffeinate -dimsu -t 1500 & CAF=$!
b() { bsk "$@" --session $S 2>/dev/null; }
# the last button with this exact label on the page (the newest card)
ref() { b observe | grep -E "@e[0-9]+ button \"$1\"" | tail -1 | grep -oE '@e[0-9]+' | head -1; }
play() { for i in {1..30}; do r=$(ref "Play"); [ -n "$r" ] && { b click $r >/dev/null; echo "play $r"; return 0; }; sleep 1; done; echo "no Play"; }
b navigate "https://app.slack.com/client/T0C4YS898AU/$CH" >/dev/null; sleep 8
rm -f raw/$NAME.stop raw/$NAME.mov
( while [ ! -e raw/$NAME.stop ]; do ./tools/nudge; sleep 20; done ) & NUD=$!
./tools/winrec $SW raw/$NAME.mov raw/$NAME.stop 30 > raw/$NAME.log 2>&1 & REC=$!
python3 -c 'import time;print(int(time.time()*1000))' > raw/$NAME.t0
sleep 2.5
$T/click 1064 880; sleep 0.6
$T/mark.sh $NAME sent; $T/typer "/team $REQ" 55; sleep 1.2
osascript -e 'tell application "System Events" to key code 36'; sleep 0.8
osascript -e 'tell application "System Events" to key code 36'
$T/waitlog.sh "team: " 60; $T/mark.sh $NAME planned
# GitHub agent
sleep 6; play; $T/mark.sh $NAME play1
$T/waitlog.sh "run create-release(:| failed)" 900; $T/mark.sh $NAME done1
$T/waitlog.sh "video: /create-release" 120; $T/mark.sh $NAME replay1
# Gmail agent (starts after the handoff)
sleep 8; play; $T/mark.sh $NAME play2
$T/waitlog.sh "run announce(:| failed)" 900; $T/mark.sh $NAME done2
$T/waitlog.sh "video: /announce" 120; sleep 14; $T/mark.sh $NAME review
# Send, then Gmail sending live in the card
r=$(ref "Send 3"); [ -n "$r" ] && b click $r >/dev/null; $T/mark.sh $NAME send
sleep 6; play; $T/mark.sh $NAME play3
$T/waitlog.sh "run announce: sent" 300; $T/mark.sh $NAME delivered
$T/waitlog.sh "video: /announce" 120; sleep 3; $T/mark.sh $NAME sentcard
# the one proof: the sent mail in Gmail, in a new tab of this window
b tab create --url "https://mail.google.com/mail/u/0/#search/in%3Asent+%7Bto%3Aachar.pranav%2Bdana%40gmail.com+to%3Aachar.pranav%2Bravi%40gmail.com+to%3Aachar.pranav%2Bmei%40gmail.com%7D" >/dev/null
$T/mark.sh $NAME verify; sleep 12
touch raw/$NAME.stop; for i in {1..20}; do kill -0 $REC 2>/dev/null || break; sleep 0.5; done; kill -0 $REC 2>/dev/null && kill -INT $REC
kill $NUD $CAF 2>/dev/null; rm -f raw/$NAME.stop
ls -la raw/$NAME.mov; cat raw/$NAME.marks

#!/bin/zsh
# Film v3 takes, Slack only, in #shipping. usage: film/tools/film3.sh <learn|create-release|triage|standup>
# Needs: the bot running (bot/.stage), tools/hold.sh done (keeps Chrome's debugging bar steady). Records only the
# Slack Chrome window (SW=<CG window id>, default 27322). Every click raises Slack first (agent windows open on top).
set -u
cd ${0:A:h}/..
T=./tools
CH=${CH:-C0C4B2S08E9}        # #shipping (CH=... to film elsewhere)
REPO=https://github.com/PranavAchar01/over-the-shoulder
export SW=${SW:-28284}
TAKE=$1
rm -f raw/$TAKE.marks raw/$TAKE.focus
caffeinate -dimsu -t 1200 & CAF=$!
newtab() { osascript -e "tell application \"Google Chrome\" to tell window id ${WID:-1078947361} to make new tab with properties {URL:\"$1\"}" >/dev/null; }
# The video tile shows up with the agent's first frame (a few seconds in): retry until it is there.
play() { for i in {1..20}; do $T/raise.sh; sleep 0.4; .venv/bin/python $T/clickplay.py $SW >> raw/$TAKE.focus 2>/dev/null && return 0; sleep 1.5; done; echo "play not found"; }
run_take() {  # $1 = what to type, $2 = log name of the run, $3 = verify URL
  $T/rec.sh start $TAKE $CH || exit 1; sleep 2.5
  $T/mark.sh $TAKE sent; $T/send.sh "$1" 110
  sleep 9; play; $T/mark.sh $TAKE play
  $T/waitlog.sh "run $2(:| failed)" 900; $T/mark.sh $TAKE done
  $T/waitlog.sh "video: /$2" 120; $T/mark.sh $TAKE replay
  sleep 14; $T/mark.sh $TAKE flipped          # replay plays once, then the card flips to Done
  sleep 2.5; newtab "$3"; $T/mark.sh $TAKE verify; sleep 7
}
case $TAKE in
  learn)
    $T/rec.sh start $TAKE $CH || exit 1; sleep 2.5
    $T/mark.sh $TAKE sent
    $T/send.sh "/learn https://www.youtube.com/watch?v=laEvoIFtFeg on $REPO" 30
    $T/waitlog.sh "learn: " 180; $T/mark.sh $TAKE learned
    sleep 2.5; $T/raise.sh; sleep 0.4; .venv/bin/python $T/clickgreen.py $SW; $T/mark.sh $TAKE sheet
    sleep 3.5; .venv/bin/python $T/clickgreen.py $SW; $T/mark.sh $TAKE publish
    $T/waitlog.sh "publish /" 60; sleep 3.5 ;;
  create-release) run_take "/do create-release v1.2.0" create-release "$REPO/releases" ;;
  triage) run_take "/triage" triage "$REPO/issues" ;;
  standup) run_take "/standup" standup "$REPO/commits/main" ;;
  announce)
    # Drafts in the card, then Send: real Gmail sends to the test inbox's plus-addresses, checked in Gmail.
    GQ="https://mail.google.com/mail/u/0/#search/in%3Asent+%7Bto%3Aachar.pranav%2Bdana%40gmail.com+to%3Aachar.pranav%2Bravi%40gmail.com+to%3Aachar.pranav%2Bmei%40gmail.com%7D"
    $T/rec.sh start $TAKE $CH || exit 1; sleep 2.5
    $T/mark.sh $TAKE sent; $T/send.sh "/do announce" 110
    sleep 9; play; $T/mark.sh $TAKE play
    $T/waitlog.sh "run announce(:| failed)" 900; $T/mark.sh $TAKE done
    $T/waitlog.sh "video: /announce" 120; $T/mark.sh $TAKE replay
    sleep 14; $T/mark.sh $TAKE flipped            # the review card: drafts ready, Send
    sleep 2; $T/raise.sh; sleep 0.4; .venv/bin/python $T/clickgreen.py $SW; $T/mark.sh $TAKE send
    $T/waitlog.sh "run announce: sent" 300; $T/mark.sh $TAKE delivered
    sleep 3; newtab "$GQ"; $T/mark.sh $TAKE verify; sleep 15 ;;   # Gmail search takes a while to fill in
  *) echo "unknown take"; kill $CAF; exit 2 ;;
esac
$T/rec.sh stop $TAKE
# Close the check tab in the Slack window (its first tab is Slack, the check is the active one).
grep -q verify raw/$TAKE.marks 2>/dev/null && osascript -e "tell application \"Google Chrome\" to tell window id ${WID:-1078947361} to if (count of tabs) > 1 then close active tab" >/dev/null 2>&1
kill $CAF 2>/dev/null
cat raw/$TAKE.marks raw/$TAKE.focus 2>/dev/null

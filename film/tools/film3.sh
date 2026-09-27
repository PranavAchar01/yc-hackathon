#!/bin/zsh
# Film v3 takes, Slack only, in #platform. usage: film/tools/film3.sh <learn|create-release|triage|standup>
# Needs the bot running (bot/.stage). Records the Slack Chrome window only (SW=<CG window id>, default 27322).
set -u
cd ${0:A:h}/..
T=./tools
CH=C0C3ZTQMWUF        # #platform
REPO=https://github.com/PranavAchar01/over-the-shoulder
export SW=${SW:-27322}
TAKE=$1
rm -f raw/$TAKE.marks
caffeinate -dimsu -t 900 & CAF=$!
newtab() { osascript -e "tell application \"Google Chrome\" to tell (first window whose title contains \"(Channel) - YC\") to make new tab with properties {URL:\"$1\"}" >/dev/null; }
closetab() { osascript -e 'tell application "Google Chrome" to tell (first window whose title contains "YC") to close active tab' >/dev/null 2>&1; }
case $TAKE in
  learn)
    $T/rec.sh start $TAKE $CH || exit 1; sleep 2.5
    $T/mark.sh $TAKE sent
    $T/send.sh "/learn https://www.youtube.com/watch?v=laEvoIFtFeg on $REPO" 35
    $T/waitlog.sh "learn: " 180; $T/mark.sh $TAKE learned
    sleep 2.5; $T/click 1098 496; $T/mark.sh $TAKE sheet   # Publish on the card
    sleep 3.5; $T/click 1050 854; $T/mark.sh $TAKE publish # Publish in the sheet
    $T/waitlog.sh "publish|registered|manifest" 60; sleep 4 ;;
  create-release|triage|standup)
    $T/rec.sh start $TAKE $CH || exit 1; sleep 2.5
    $T/mark.sh $TAKE sent
    if [ $TAKE = create-release ]; then $T/send.sh "/do create-release" 120; else $T/send.sh "/$TAKE" 120; fi
    $T/waitlog.sh "run $TAKE(:| failed)" 900; $T/mark.sh $TAKE done
    sleep 4
    case $TAKE in
      create-release) newtab "$REPO/releases"; $T/mark.sh $TAKE verify; sleep 7 ;;
      triage) newtab "$REPO/issues"; $T/mark.sh $TAKE verify; sleep 7 ;;
      standup) newtab "$REPO/commits/main"; $T/mark.sh $TAKE verify; sleep 5 ;;
    esac ;;
  *) echo "unknown take"; kill $CAF; exit 2 ;;
esac
$T/rec.sh stop $TAKE
[ -f raw/$TAKE.marks ] && grep -q verify raw/$TAKE.marks && closetab
kill $CAF 2>/dev/null
cat raw/$TAKE.marks

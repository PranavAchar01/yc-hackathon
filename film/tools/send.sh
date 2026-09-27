#!/bin/zsh
# Type a message or slash command into the Slack window that is in front, safely:
# refuses unless Chrome is frontmost with a Slack client tab, clicks the composer first, then Enter (twice for
# a slash command: pick the autocomplete entry, then send).
# usage: send.sh "<text>" [ms-per-key=90]
set -u
cd ${0:A:h}/..
TXT=$1; MS=${2:-90}
FRONT=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')
TAB=$(osascript -e 'tell application "Google Chrome" to get URL of active tab of window 1')
[ "$FRONT" = "Google Chrome" ] && [[ $TAB == *app.slack.com/client* ]] || { echo "refusing: front=$FRONT tab=$TAB"; exit 1; }
./tools/click 855 882; sleep 0.6
./tools/typer "$TXT" $MS
sleep 1.0
osascript -e 'tell application "System Events" to key code 36'
if [[ $TXT == /* ]]; then sleep 0.8; osascript -e 'tell application "System Events" to key code 36'; fi
echo "sent: $TXT at $(date +%T)"

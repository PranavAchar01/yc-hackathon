#!/bin/zsh
# Keep one idle, attached BrowserSkill session open so Chrome's "started debugging this browser" bar stays on
# screen for the whole shoot (it appears and disappears with agent sessions and shifts Slack's layout).
# The daemon stops sessions idle for ~5 min, so a keep-alive touches it every 45 s.
#   hold.sh start | stop
cd ${0:A:h}/..
if [ "${1:-start}" = stop ]; then
  [ -f raw/hold.pid ] && kill $(cat raw/hold.pid) 2>/dev/null
  [ -f raw/hold.session ] && bsk session stop $(cat raw/hold.session) >/dev/null 2>&1
  rm -f raw/hold.pid raw/hold.session; echo "hold stopped"; exit 0
fi
H=$(bsk session start --name "Hold (film)" 2>&1 | tail -1)
bsk navigate "https://over-the-shoulder-brown.vercel.app/" --session $H >/dev/null 2>&1
echo $H > raw/hold.session
# Out of the way: agent windows open on top of Slack, and AppleScript can't raise Slack above them. Minimized,
# the session stays attached, so the bar stays.
sleep 1.5
osascript -e 'tell application "System Events" to tell process "Google Chrome" to set value of attribute "AXMinimized" of (first window whose name starts with "Over the Shoulder") to true' >/dev/null 2>&1
( while bsk evaluate "1" --session $H >/dev/null 2>&1; do sleep 45; done ) &
echo $! > raw/hold.pid
echo "hold session $H (keep-alive pid $!)"

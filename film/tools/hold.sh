#!/bin/zsh
# Keep one idle, attached BrowserSkill session open so Chrome's "started debugging this browser" bar stays on
# screen for the whole take (it appears and disappears with agent sessions and shifts Slack's layout).
H=$(bsk session start --name "Hold (film)" 2>&1 | tail -1)
bsk navigate "https://over-the-shoulder-brown.vercel.app/" --session $H >/dev/null 2>&1
echo $H > ${0:A:h}/../raw/hold.session
echo "hold session $H"

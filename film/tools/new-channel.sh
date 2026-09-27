#!/bin/zsh
# Create a public Slack channel in the YC workspace through the Slack web UI (BrowserSkill), print its id.
# usage: new-channel.sh <name>
set -u
S=$(bsk session start 2>&1 | tail -1)
o() { bsk observe --session $S 2>&1 | grep -E "$1" | head -1 | grep -oE '@e[0-9]+'; }
bsk navigate "https://app.slack.com/client/T0C4YS898AU" --session $S >/dev/null 2>&1; sleep 8
# "Create new" > Channel: always in view (the sidebar's "Add channels" scrolls away once there are many channels)
bsk click $(o '@e[0-9]+ button "Create new') --session $S >/dev/null 2>&1; sleep 1.5
bsk click $(o '@e[0-9]+ menuitem "Channel"') --session $S >/dev/null 2>&1; sleep 2
bsk fill $(o '@e[0-9]+ combobox "Channels are where') --value "$1" --session $S >/dev/null 2>&1; sleep 1.5
bsk click $(o '@e[0-9]+ button "Create a channel - Next"') --session $S >/dev/null 2>&1; sleep 2
bsk click $(o '@e[0-9]+ radio "Public') --session $S >/dev/null 2>&1; sleep 0.5
bsk click $(o '@e[0-9]+ button "Create a channel - Create"') --session $S >/dev/null 2>&1; sleep 4
bsk evaluate "location.href" --session $S 2>&1 | tail -1 | grep -oE 'C[0-9A-Z]{8,}$'
SK=$(o '@e[0-9]+ button "Skip for now"'); [ -n "$SK" ] && bsk click $SK --session $S >/dev/null 2>&1
bsk session stop $S >/dev/null 2>&1

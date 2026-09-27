# Pre-stage checklist

1. Charger in. Battery settings: no Low Power Mode.
2. Do Not Disturb on (Control Center > Focus), so no banners over the demo.
3. Quit everything the demo does not need. Keep Slack, the terminal, Docker Desktop, Wispr Flow and JobPilot.
4. Docker Desktop is running (do not quit it at the end either).
5. `cd ~/helloworld/over-the-shoulder/bot && pnpm stage`
6. Wait for every line to be green (under a minute once the sandbox image is pulled). Grey lines are optional.
7. In Slack, open the demo channel and run `/gtm` once. Watch all steps tick and the card land on "Send 12".
8. If anything looked wrong: `OTS_FORCE_SCRIPTED=1 pnpm stage` gives the same card on the scripted path.
9. Clear the test run from the channel (delete the message by hand) and reset the zoom level in Slack.
10. After the demo: `pnpm stage:down`.

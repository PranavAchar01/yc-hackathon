# Pre-stage checklist

1. Charger in. Battery settings: no Low Power Mode.
2. Do Not Disturb on (Control Center > Focus), so no banners over the demo.
3. Quit everything the demo does not need. Keep Slack, Chrome, the terminal, Docker Desktop, Wispr Flow and JobPilot.
4. Chrome is open with the BrowserSkill extension connected, and you are signed in to the demo sites. Docker Desktop is running. Keychain has SLACK_BOT_TOKEN, SLACK_APP_TOKEN and OPENAI_API_KEY (or ANTHROPIC_API_KEY).
5. `cd ~/helloworld/over-the-shoulder/bot && pnpm run stage` (with `run`: plain `pnpm stage` is a pnpm built-in).
6. Wait for every line to be green (a few seconds). Grey lines are optional.
7. In Slack, open the demo channel and run `/gtm` once. Approve the BrowserSkill consent prompt, watch the steps tick and the card land on "Send 12".
8. If anything looked wrong: `OTS_FORCE_SCRIPTED=1 pnpm run stage` gives the same card on the scripted path.
9. Clear the test run from the channel (delete the message by hand) and reset the zoom level in Slack.
10. After the demo: `pnpm run stage:down`.

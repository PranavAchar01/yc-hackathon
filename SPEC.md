# Over the Shoulder (YC Own Your Intelligence hackathon, Sun 2026-09-27)

One line: you do a task once while it watches; it becomes procedural memory (Memorable) that your QM agent replays from a Slack slash command.

## Stack
- QM (yc-software/qm): Slack-native agent harness. Memorable is a built-in QM memory provider (`type: "memorable"`: `memorable record` on capture, `memorable inject` on recall). So QM + Memorable is config, not glue.
- Memorable (memorable.sh, `npx memorable-cli@latest`): procedural memory for computer-use agents. It records step traces and replays them (`memorable recall` / `show`). It does not do the clicking.
- BrowserSkill (`bsk`): does the clicking, in Pranav's real logged-in Chrome through an Agent Window (consent prompt before it takes control). A Claude tool-use loop (`claude-opus-5-5`) calls bsk snapshot/click/fill/navigate, with the procedure's steps and the Memorable recall as guidance. Every run is recorded back to Memorable. (Replaced Cua on 09-24: no Docker desktop, no image pull.)
- Slack (and QM) are the front door: slash commands, run cards with live screenshots, the command library.
- Our layer: `/teach [name]` records a human demonstration (screen frames + a vision model to steps) and publishes it as a command (library row, QM skill, GBrain page, Memorable procedure, real slash command); `/gtm` (and generally `/<command>`) replays it through BrowserSkill with a clean Block Kit UI. Scripted executor stays as the stage-safe fallback (`OTS_EXECUTOR=bsk|qm|scripted`).

## Demo storyboard (single source of truth for site + bot copy)
Workspace "Northwind" (fictional), channel `#launch`.
1. Priya Shah: "Hey Mark, all the deliverables are in place. Just forwarded them to you. Can you send out the GTM emails?"
2. Mark Ellis earlier ran `/teach gtm` and did it once by hand: card "Watching over your shoulder" with a red recording dot and a Stop button; on stop: "Learned GTM launch emails. 7 steps from 1 demonstration. Saved to Memorable."
3. Mark types `/gtm`. Card appears and steps tick live:
   1. Open the deliverables Priya forwarded
   2. Pull the launch list (12 contacts)
   3. Match each contact to the right one-pager
   4. Draft 12 emails in Mark's voice
   5. Attach the one-pager and launch video link
   6. Check links and names
   7. Queue for review
   Footer: "Recalled from Mark's demonstration · 7 steps · 38 s". Comparison chip: "Without the demo: 41 tool calls, 3 min 12 s, 2 wrong attachments."
4. Preview of one drafted email + buttons: "Review all 12", "Send 12" (primary), "Edit procedure".
5. After Send: "12 emails sent. Priya, done." (Demo only: never sends real email.)

Fictional names only. No Slack logo or trademarked branding on the site (Slack-like, unbranded).

## Rules
- Demo runs only on real sites (GitHub, Vercel, Gmail). No mock or fake pages, ever: every browser command carries a real start URL.
- Nothing sends real email. Demo recipients are @example.com.
- Hackathon rules on pre-built code are unknown until the 1:00 kickoff.

## v2 scope (Pranav, 09-23 night): real integration, GBrain back in
He wires the API keys himself after we finish. Everything else we build.

### Making a command: "boom", three ways, all end at the same Publish sheet
1. `/teach` (no name needed): record, stop, and a modal opens: "Here's what I learned". Name (auto-suggested, e.g. `gtm`), one-line description, emoji, editable step list, who can use it (Just me / This channel / Everyone). One button: Publish.
2. `/new`: a one-sentence modal ("Describe what it should do"), Claude drafts name + steps, same Publish sheet. For tasks with no screen demo.
3. Message shortcut "Save as command" on any finished agent thread: turns a successful QM run (its Memorable trace) into a command.
Publish = row in the library + GBrain page + Memorable procedure + a REAL slash command, registered instantly via Slack's `apps.manifest.update` (app configuration token). If that token is absent, fallback to the router `/do <name>` so nothing breaks.

### Command library ("see what you're missing")
- Source of truth: Postgres table `commands` (name, title, description, emoji, steps jsonb, author, visibility, uses, last_used, created_at) + `runs` table (usage).
- Search: GBrain (keyword + semantic + graph; each command is a GBrain page, so "send launch emails" finds `/gtm`). Fallback: Postgres full-text + pg_trgm when GBrain isn't up.
- Surfaces: Slack App Home tab (search box, "Popular on your team", "Your teammates use these, you haven't tried them yet", "Yours"), `/commands <query>` ephemeral search, and a web library page on the site reading the same API.

## Demo task (proposed 09-23 late, awaiting Pranav's yes)
He: mock inbox/sheet is not impressive; emails are easy; wants something with real complexity like GitHub. He will create a throwaway Gmail (and GitHub) just for the hackathon and log in himself.
Proposal: `/ship` = one command across real apps, taught once:
1. GitHub (throwaway account + demo repo): open the PR, wait for CI green, read the diff, apply Mark's review rules (label, request changes or approve), merge, draft release notes, publish the release.
2. Gmail (throwaway): send the launch email with the release link to addresses he controls.
3. Slack: reply in thread with links.
Rules: he logs into both accounts in the sandbox browser beforehand (persistent profile); the agent never types passwords or 2FA codes; avoid sudo-mode actions (settings, deletes, tokens); recipients only his own addresses.
Pitch answer to "why not the GitHub API?": the procedure is learned from watching a non-engineer once, and the same recorder works on tools that have no API.

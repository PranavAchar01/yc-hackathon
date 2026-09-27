# Over the Shoulder: Slack bot

Do a task once while it watches. It becomes a command your whole team can run from Slack.
`SPEC.md` (one folder up) is the source of truth for the storyboard and copy.

```
Slack (Socket Mode) ── /teach /new /do /<command> /commands, App Home, "Save as command"
   │
   ├─ library     Postgres `commands` + `runs` (qm-config/docker-compose.yml, port 5544)
   ├─ search      GBrain page per command; falls back to Postgres full-text + pg_trgm
   ├─ memory      Memorable CLI: records each procedure and each browser run, recalls before the next run
   ├─ publish     library row + QM skill file + GBrain page + Memorable + a real slash command
   │              (apps.manifest.update), or the `/do <name>` router when no config token
   └─ executor    bsk (LLM tool loop driving your real Chrome via BrowserSkill) | qm | scripted (stage-safe)
```

## What Pranav does himself (the bot never creates accounts, installs apps or enters passwords)

1. **Slack workspace.** Create a free workspace for the demo (for example "Northwind") at slack.com.
2. **Create the app from the manifest.**
   1. Open https://api.slack.com/apps and click **Create New App**.
   2. Choose **From a manifest**, pick the demo workspace, click **Next**.
   3. Choose the **YAML** tab, delete the sample, paste all of `bot/manifest.yaml`, click **Next**, then **Create**.
3. **Install it.** In the app's **Install App** page click **Install to Workspace** and allow.
4. **Tokens.**
   - Bot token: **OAuth & Permissions** > copy **Bot User OAuth Token** (`xoxb-...`).
   - App token: **Basic Information** > **App-Level Tokens** > **Generate Token and Scopes**, name it `socket`,
     add scope `connections:write`, **Generate**, copy (`xapp-...`).
   - Optional, for real slash commands on Publish: **Basic Information** > copy **App ID**; then
     https://api.slack.com/apps (top of the list) > **Your App Configuration Tokens** > **Generate Token** for the
     workspace, copy both the access token and the refresh token.
5. **Put secrets in the login Keychain.** Copy each value, then save it from the clipboard. Do not use the
   interactive `-w` prompt: it silently truncates at 128 characters, and OpenAI keys are longer (164).
   `pbpaste` keeps the value out of files and shell history; `-U` updates an existing item.
   ```sh
   # required: Slack + ONE LLM key (OpenAI preferred when both exist)
   security add-generic-password -U -a "$USER" -s SLACK_BOT_TOKEN -w "$(pbpaste)"
   security add-generic-password -U -a "$USER" -s SLACK_APP_TOKEN -w "$(pbpaste)"
   security add-generic-password -U -a "$USER" -s OPENAI_API_KEY -w "$(pbpaste)"     # or ANTHROPIC_API_KEY
   # optional
   security add-generic-password -U -a "$USER" -s SLACK_APP_ID -w "$(pbpaste)"
   security add-generic-password -U -a "$USER" -s SLACK_CONFIG_TOKEN -w "$(pbpaste)"
   security add-generic-password -U -a "$USER" -s SLACK_CONFIG_REFRESH_TOKEN -w "$(pbpaste)"
   security add-generic-password -U -a "$USER" -s ANTHROPIC_API_KEY -w "$(pbpaste)"
   security add-generic-password -U -a "$USER" -s MEMORABLE_API_KEY -w "$(pbpaste)"
   security add-generic-password -U -a "$USER" -s OTS_QM_SIGNING_SECRET -w "$(pbpaste)" # only for OTS_EXECUTOR=qm
   ```
   Check a saved length without printing it: `security find-generic-password -s OPENAI_API_KEY -w | wc -c`.
6. **Memorable** (procedural memory): `npx memorable-cli@latest login` (opens a browser), then
   `npx memorable-cli@latest enable` (consent; nothing is stored until you run it).
7. **GBrain** (search): Bun is already at `~/.bun/bin/bun`. Install with
   `bun install -g github:garrytan/gbrain` (never `npm i gbrain`: that npm name is not GBrain), then
   `gbrain init --pglite --no-embedding`. `pnpm stage` does the init if it is missing.
8. **BrowserSkill**: the `bsk` CLI is at `~/.local/bin/bsk`; keep Chrome open with the BrowserSkill extension
   connected (`bsk status`). Sign in to the sites the demo uses in that Chrome yourself. Each run opens an
   Agent Window and the extension asks you for consent before it takes control. The agent never types
   passwords or 2FA codes (a guard refuses to fill fields that look like them); if it meets a sign-in it stops
   and the card says "Needs you: sign in".
9. **Screen Recording** permission for your terminal app (System Settings > Privacy & Security > Screen &
   System Audio Recording), so `/teach` can capture frames.

## Run

```sh
pnpm install
pnpm dev        # reads secrets from Keychain (security find-generic-password -s NAME -w), runs the bot
pnpm run stage       # Postgres, GBrain, bsk + Chrome, Memorable, bot; always prints a green/red table
pnpm run stage:down  # stops only what stage started (never Docker itself, never JobPilot)
```

`pnpm stage` without `run` hits pnpm 11's built-in `stage` command (package staging) and prints nothing,
so always use `pnpm run stage`.

Checks: `pnpm typecheck`, `pnpm lint` (Biome), `pnpm test` (Vitest; the Postgres tests run when
`ots-postgres` is up, otherwise they are skipped).

## Commands

| Command | What it does |
| --- | --- |
| `/teach [name]` | "Watching over your shoulder" card with Stop. Captures the Mac screen every 1.5 s (`screencapture -x`). On Stop, the LLM (vision + structured output, zod-validated) writes the steps and the Publish sheet opens: name, one line, icon, steps, who can use it. |
| `/learn <video link>` | Learns a command from a screen recording someone already made (YouTube, Loom or a direct .mp4; public http(s) only, 500 MB max). yt-dlp downloads the video stream (720p max) while the captions download in parallel, ffmpeg samples 16 frames, and the fast model (`OTS_LEARN_MODEL`, default `gpt-5.4-mini`) writes title, name, 4 to 10 steps and the real start URL. The card is `◐ Watching the recording` with a filmstrip, then `✓ Learned /release · 7 steps` and one Publish button (the `/teach` sheet). A 2 min YouTube tutorial takes about 12 s end to end. Test it without Slack: `source scripts/secrets.sh && tsx scripts/learn-offline.ts <url> [model]`. Needs `yt-dlp` (2026.x) and `ffmpeg`; YouTube needs Node as yt-dlp's JS runtime and the `mweb`/`tv_simply` clients, which the bot passes. |
| `/new [sentence]` | One-sentence modal; the LLM drafts name and steps into the same Publish sheet. |
| Message shortcut **Save as command** | Turns a finished run message into a command via the same sheet. |
| `/gtm`, `/ship`, any published command | Posts the run card: `◐ Triaging issues`, a large live view, `Step 3 of 6 · 0:42`. Done: `✓ Done · 1:26`, at most 2 result lines and an "Open in GitHub" link button (the rest of a long result goes in the thread). Failed: `Stopped · <reason>`. The run's replay (a ~15 s mp4) is posted in the thread as "Replay". |
| `/standup` | Reads the last 24 h of GitHub activity and posts a 4 to 6 line standup. Read only. |
| `/triage` | Labels each unlabeled open issue on over-the-shoulder (bug/feature/perf, P1/P2, needs-repro). Never closes or assigns. |
| `/ship` | Merges the newest green PR (merge commit) and publishes the next GitHub release. |
| `/deploys` | Reads the latest Vercel production deployment. Read only. |
| `/do <name>` (also `/ots <name>`) | Router for commands that are not registered as real slash commands. |
| `/commands [query]` | Ephemeral search of the library. |
| App Home | Search, Popular on your team, Your teammates use these (you have not tried them), Yours. |

Send on the GTM card never sends email: it moves the card to done and replies "12 emails sent. Priya, done."

## LLM provider

All three model call sites (`/teach` frames to steps, `/new` and Save-as drafts, the bsk agent loop) go through
`src/llm.ts`, with two implementations:

- **OpenAI** (official `openai` SDK, Chat Completions): image input as data URLs, strict `json_schema` structured
  output re-validated with zod, function calling for the agent loop. Model `OTS_OPENAI_MODEL`, default `gpt-5.5`
  (in the SDK's `ChatModel` list and used in its README for vision and tool examples). Optional
  `OTS_OPENAI_FAST_MODEL` (for example `gpt-5.4-mini`) is used only for the per-step bsk loop, if latency matters.
  At startup the bot calls `models.list` once and warns if a configured model is not available to the key.
- **Anthropic**: `OTS_ANTHROPIC_MODEL`, default `claude-opus-5-5`.

`OTS_LLM=openai|anthropic` forces one; otherwise the bot uses whichever key exists, preferring OpenAI. With no key,
`/teach` and `/new` explain that a key is missing and every run uses the scripted executor.

## Executors

`OTS_EXECUTOR=bsk|qm|scripted` (default `scripted`; `pnpm run stage` uses `bsk`). Whatever is chosen goes through
a guard: if its health check is red (no bsk daemon or no connected Chrome, no LLM key), or
`OTS_FORCE_SCRIPTED=1`, or it fails mid-run (for example consent declined), the run finishes on the scripted
executor with the same card and nothing on screen says so (only the log does).

- **bsk** (`src/executor/bsk.ts`): a tool-use loop on the configured LLM whose tools wrap the `bsk` CLI
  (0.3.1): `snapshot`, `click`, `fill`, `press`, `navigate`, `select`, `wait-for-navigation`, `screenshot`,
  `scroll-to`, plus `step_done`, `needs_human`, `finish`. After every navigate, wait and click the executor injects a
  visible agent cursor (`src/executor/cursor.ts`, via `bsk evaluate`; installs once per page, pointer-events none,
  changes no page text). bsk clicks with CDP `Input.dispatchMouseEvent` (a `mouseMoved` then press and release), so
  the cursor follows real mouse events; before each click the executor also `bsk hover`s the target and waits 250 ms
  so the cursor lands first, and on `fill` (CDP `insertText`, no mouse events) it glides to the focused field. Lifecycle is `bsk session start --json` /
  `bsk session stop <id>` (always stopped, success or failure). The procedure's steps and `memorable recall`
  go in as guidance; the finished run's actions are recorded back to Memorable. Live view, two ways:
  *video* (when `OTS_LIVE_SECRET` is set): screenshots every 200 ms go as JPEG to the site relay
  (`site/api/live/[run].js`, Postgres, latest frame only, forgotten after 30 min, bearer secret) and the card
  carries a Block Kit video block whose `video_url` is the player `https://over-the-shoulder-brown.vercel.app/live?run=<id>`
  (needs `links.embed:write` and that unfurl domain on the app); *image* (fallback, or when Slack rejects the video
  block): a private `files.uploadV2` (no `channel_id`, so the file is never shared; the bot owns it, which is what an
  image block's `slack_file` needs) every 1.2 s. Card updates are coalesced and spaced 1.2 s apart (chat.update is
  Tier 3), pause for `Retry-After` on a 429, and resend without the media on `invalid_blocks`. Start URL comes from the command
  (`commands.start_url`) and is required: demo runs only on real sites. A command with no start URL is refused
  with a clear card (no silent scripted fallback for that case), and there are no local mock pages.
- **qm**: `POST /v1/turns` on a local QM (`qm/src/api/routes/turns.ts`), body
  `{ surface, actor: { externalId }, conversation: { kind: "dm", threadRef }, text }`, signed like
  `qm/src/auth/source-auth-sign.ts` (`x-timestamp`, `x-signature: v0=HMAC_SHA256(secret, "v0:<ts>:<METHOD>\n<path>\n<body>")`).
  Health is `GET /healthz`. QM config lives in `../qm-config/`. QM is off the stage path (`OTS_WITH_QM=1` to start it).
- **scripted**: deterministic SPEC timings (7 steps, 38 s), fictional drafts to `@example.com`.

## Memorable (checked against memorable-cli 0.5.19)

`memorable status` tells us login and consent. On the local backend procedures are stored with
`memorable ingest -` (trace JSON `{prompt, tool_calls:[{name,input,result}]}`). `memorable record --scope <id> -`
only works on the gbrain/qm backends (the 0.5.19 CLI refuses it on the local backend and says to use `ingest`),
so the bot uses `record` only with `MEMORABLE_BACKEND=qm`. Recall is `memorable recall "<title>"`. The CLI also
reads `MEMORABLE_API_KEY` from the environment; `scripts/secrets.sh` exports it from Keychain when present. If the CLI is missing, logged out or consent is off, the bot logs one line and the
card says "Saved as a QM skill." instead of "Saved to Memorable."

## Environment

Secrets come from Keychain (see above). Everything else has a default:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTS_EXECUTOR` | `scripted` | `bsk`, `qm` or `scripted` |
| `OTS_FORCE_SCRIPTED` | `0` | `1` = always scripted (stage panic switch) |
| `OTS_DATABASE_URL` | `postgres://ots:ots@127.0.0.1:5544/ots` | library database (local dev credentials) |
| `OTS_LIBRARY` | `postgres` | `memory` to run without Postgres |
| `OTS_SEED` | `1` | seed 52 commands (`seed/commands.json`) into an empty library; the real-site ones (`standup`, `triage`, `ship`, `deploys`) are upserted by name on every start |
| `OTS_API_PORT` / `OTS_API_HOST` | `3977` / `127.0.0.1` | `/api/commands?q=`, `/api/health` |
| `OTS_LLM` | picks by key, OpenAI first | `openai` or `anthropic` |
| `OTS_OPENAI_MODEL` / `OTS_OPENAI_FAST_MODEL` | `gpt-5.5` / unset | OpenAI models (fast one only for the bsk loop) |
| `OTS_ANTHROPIC_MODEL` | `claude-opus-5-5` | Anthropic model |
| `BSK_BIN`, `BSK_TIMEOUT_MS`, `BSK_EFFORT` | `~/.local/bin/bsk`, `300000`, `medium` | BrowserSkill run settings |
| `OTS_WITH_QM` | `0` | `pnpm run stage` also starts QM |
| `OTS_QM_URL` | `http://localhost:8080` | QM dev instance |
| `GBRAIN_BIN` / `OTS_GBRAIN` | `~/.bun/bin/gbrain` / `1` | GBrain CLI |
| `YTDLP_BIN` / `FFMPEG_BIN` / `FFPROBE_BIN` | `yt-dlp` / `ffmpeg` / `ffprobe` | `/learn` tools (on PATH) |
| `OTS_REQUESTER` | `Priya` | name in "12 emails sent. Priya, done." |
| `OTS_LIVE_SECRET` | unset | Keychain; enables the live video relay (same value as the site's env var) |
| `OTS_LIVE_BASE` | `https://over-the-shoulder-brown.vercel.app` | site with `/live` and `/api/live/<run>`; also App Home covers |
| `OTS_LIVE_FRAME_MS` | `200` | screenshot cadence with the relay (1200 ms without it) |
| `OTS_LEARN_MODEL` | fast model | `/learn` extraction model |

## Website API

`GET http://127.0.0.1:3977/api/commands?q=send%20launch%20emails&limit=20` returns
`{ query, commands: [{ name, invoke, title, description, emoji, steps, author, uses, lastUsed, createdAt }] }`,
"everyone" commands only, CORS open, GET only.

## The "BrowserSkill started debugging this browser" bar

Chrome shows this infobar whenever an extension uses `chrome.debugger`, which is how bsk drives the page. No flag or
API lets an extension hide it, so we don't try. It is outside the page: `bsk screenshot` (CDP page capture) never
contains it, so the live view, the thread Replay and the library videos are clean. Only window or screen
recordings see it; `film/tools/prep-footage.sh` already crops below it, and `film/tools/prep2.sh` takes
`AGENT_TOP_CROP=<px>` to cut it (and the toolbar) off the agent view.

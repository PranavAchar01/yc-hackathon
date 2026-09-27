# Over the Shoulder: Slack bot

Do a task once while it watches. It becomes a command your whole team can run from Slack.
`SPEC.md` (one folder up) is the source of truth for the storyboard and copy.

```
Slack (Socket Mode) ── /teach /new /do /<command> /commands, App Home, "Save as command"
   │
   ├─ library     Postgres `commands` + `runs` (qm-config/docker-compose.yml, port 5544)
   ├─ search      GBrain page per command; falls back to Postgres full-text + pg_trgm
   ├─ memory      Memorable CLI: records each procedure and each Cua run, recalls before the next run
   ├─ publish     library row + QM skill file + GBrain page + Memorable + a real slash command
   │              (apps.manifest.update), or the `/do <name>` router when no config token
   └─ executor    cua (Claude computer use in a local Docker desktop) | qm | scripted (stage-safe)
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
5. **Put secrets in the login Keychain** (each command prompts for the value; nothing lands in files or history):
   ```sh
   security add-generic-password -a "$USER" -s SLACK_BOT_TOKEN -w
   security add-generic-password -a "$USER" -s SLACK_APP_TOKEN -w
   security add-generic-password -a "$USER" -s ANTHROPIC_API_KEY -w
   # optional
   security add-generic-password -a "$USER" -s SLACK_APP_ID -w
   security add-generic-password -a "$USER" -s SLACK_CONFIG_TOKEN -w
   security add-generic-password -a "$USER" -s SLACK_CONFIG_REFRESH_TOKEN -w
   security add-generic-password -a "$USER" -s OPENAI_API_KEY -w          # GBrain semantic search
   security add-generic-password -a "$USER" -s OTS_QM_SIGNING_SECRET -w   # only for OTS_EXECUTOR=qm
   ```
6. **Memorable** (procedural memory): `npx memorable-cli@latest login` (opens a browser), then
   `npx memorable-cli@latest enable` (consent; nothing is stored until you run it).
7. **GBrain** (search): Bun is already at `~/.bun/bin/bun`. Install with
   `bun install -g github:garrytan/gbrain` (never `npm i gbrain`: that npm name is not GBrain), then
   `gbrain init --pglite --no-embedding`. `pnpm stage` does the init if it is missing.
8. **Cua sandbox**: needs Docker Desktop running and about 6 GB for `trycua/cua-ubuntu` (the Mac keeps a
   20 GB free floor, so `pnpm stage` refuses to pull below 26 GB free). To sign in to a real site once:
   `pnpm sandbox:login https://github.com/login`, then sign in by hand in the desktop view it opens. The
   Firefox profile lives in `bot/.sandbox/storage`, so sign-ins survive restarts. The agent never types
   passwords or 2FA codes; if it meets a sign-in it stops and the card says "Needs you: sign in".
9. **Screen Recording** permission for your terminal app (System Settings > Privacy & Security > Screen &
   System Audio Recording), so `/teach` can capture frames.

## Run

```sh
pnpm install
pnpm dev        # reads secrets from Keychain (security find-generic-password -s NAME -w), runs the bot
pnpm stage      # everything for the demo: Postgres, GBrain, bot, Cua sandbox warm, Memorable, health lines
pnpm stage:down # stops only what stage started (never Docker itself, never JobPilot)
```

Checks: `pnpm typecheck`, `pnpm lint` (Biome), `pnpm test` (Vitest; the Postgres tests run when
`ots-postgres` is up, otherwise they are skipped).

## Commands

| Command | What it does |
| --- | --- |
| `/teach [name]` | "Watching over your shoulder" card with Stop. Captures the Mac screen every 1.5 s (`screencapture -x`). On Stop, Claude (`claude-opus-5-5`, structured output, zod-validated) writes the steps and the Publish sheet opens: name, one line, icon, steps, who can use it. |
| `/new [sentence]` | One-sentence modal; Claude drafts name and steps into the same Publish sheet. |
| Message shortcut **Save as command** | Turns a finished run message into a command via the same sheet. |
| `/gtm`, `/ship`, any published command | Posts the run card and ticks steps live. |
| `/do <name>` (also `/ots <name>`) | Router for commands that are not registered as real slash commands. |
| `/commands [query]` | Ephemeral search of the library. |
| App Home | Search, Popular on your team, Your teammates use these (you have not tried them), Yours. |

Send on the GTM card never sends email: it moves the card to done and replies "12 emails sent. Priya, done."

## Executors

`OTS_EXECUTOR=cua|qm|scripted` (default `scripted`; `pnpm stage` uses `cua`). Whatever is chosen goes through a
guard: if its health check is red, or `OTS_FORCE_SCRIPTED=1`, or it fails mid-run, the run finishes on the
scripted executor with the same card and nothing on screen says so (only the log does).

- **cua**: `cua/runner.py` (uv inline script: `cua-agent[anthropic]==0.8.4`, `cua-computer[docker]==0.5.19`)
  drives the `trycua/cua-ubuntu` container (2 GB RAM, 2 CPUs, reused between runs) with a Claude computer-use
  model (`CUA_MODEL`, default `anthropic/claude-opus-4-6`: cua-agent 0.8.4 maps it to `computer_20251124`;
  Opus 5.5 needs the newer `computer_toolset_20260801`, which cua-agent does not ship yet). The procedure's
  steps are the guidance, the start URL comes from the command (`commands.start_url`; null means the local
  smoke-test page at `/mock/`). Memorable `recall` runs before, `ingest` records the run's actions after.
  Screenshots stream into the card as an image block (uploaded with `files.uploadV2`, at most every 4 s).
  A Linux container, not a Lume macOS VM: the 16 GB MacBook Air swaps under a VM; the container is the
  sandbox Cua's docker provider supports directly and it starts in seconds once pulled.
- **qm**: `POST /v1/turns` on a local QM (`qm/src/api/routes/turns.ts`), body
  `{ surface, actor: { externalId }, conversation: { kind: "dm", threadRef }, text }`, signed like
  `qm/src/auth/source-auth-sign.ts` (`x-timestamp`, `x-signature: v0=HMAC_SHA256(secret, "v0:<ts>:<METHOD>\n<path>\n<body>")`).
  Health is `GET /healthz`. QM config lives in `../qm-config/`. QM is off the stage path (`OTS_WITH_QM=1` to start it).
- **scripted**: deterministic SPEC timings (7 steps, 38 s), fictional drafts to `@example.com`.

## Memorable (checked against memorable-cli 0.5.19)

`memorable status` tells us login and consent. On the local backend procedures are stored with
`memorable ingest -` (trace JSON `{prompt, tool_calls:[{name,input,result}]}`). `memorable record --scope <id> -`
only works on the gbrain/qm backends (it is what QM itself calls), so the bot uses it only with
`MEMORABLE_BACKEND=qm`. If the CLI is missing, logged out or consent is off, the bot logs one line and the
card says "Saved as a QM skill." instead of "Saved to Memorable."

## Environment

Secrets come from Keychain (see above). Everything else has a default:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTS_EXECUTOR` | `scripted` | `cua`, `qm` or `scripted` |
| `OTS_FORCE_SCRIPTED` | `0` | `1` = always scripted (stage panic switch) |
| `OTS_DATABASE_URL` | `postgres://ots:ots@127.0.0.1:5544/ots` | library database (local dev credentials) |
| `OTS_LIBRARY` | `postgres` | `memory` to run without Postgres |
| `OTS_SEED` | `1` | seed 50 fictional commands (`seed/commands.json`) into an empty library |
| `OTS_API_PORT` / `OTS_API_HOST` | `3977` / `127.0.0.1` | `/api/commands?q=`, `/api/health`, `/mock/` |
| `OTS_MOCK_URL` | `http://host.docker.internal:3977/mock/` | smoke-test page as the sandbox sees it |
| `CUA_CONTAINER`, `CUA_MODEL`, `CUA_TIMEOUT_MS`, `CUA_LIVE_URL` | `ots-cua`, see above, `240000`, unset | Cua settings; `CUA_LIVE_URL` adds an "Open live view" link |
| `OTS_WITH_QM` | `0` | `pnpm stage` also starts QM |
| `OTS_QM_URL` | `http://localhost:8080` | QM dev instance |
| `GBRAIN_BIN` / `OTS_GBRAIN` | `~/.bun/bin/gbrain` / `1` | GBrain CLI |
| `OTS_REQUESTER` | `Priya` | name in "12 emails sent. Priya, done." |

## Website API

`GET http://127.0.0.1:3977/api/commands?q=send%20launch%20emails&limit=20` returns
`{ query, commands: [{ name, invoke, title, description, emoji, steps, author, uses, lastUsed, createdAt }] }`,
"everyone" commands only, CORS open, GET only.

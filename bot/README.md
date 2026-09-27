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
   └─ executor    bsk (Claude tool loop driving your real Chrome via BrowserSkill) | qm | scripted (stage-safe)
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
| `/teach [name]` | "Watching over your shoulder" card with Stop. Captures the Mac screen every 1.5 s (`screencapture -x`). On Stop, Claude (`claude-opus-5-5`, structured output, zod-validated) writes the steps and the Publish sheet opens: name, one line, icon, steps, who can use it. |
| `/new [sentence]` | One-sentence modal; Claude drafts name and steps into the same Publish sheet. |
| Message shortcut **Save as command** | Turns a finished run message into a command via the same sheet. |
| `/gtm`, `/ship`, any published command | Posts the run card and ticks steps live. |
| `/do <name>` (also `/ots <name>`) | Router for commands that are not registered as real slash commands. |
| `/commands [query]` | Ephemeral search of the library. |
| App Home | Search, Popular on your team, Your teammates use these (you have not tried them), Yours. |

Send on the GTM card never sends email: it moves the card to done and replies "12 emails sent. Priya, done."

## Executors

`OTS_EXECUTOR=bsk|qm|scripted` (default `scripted`; `pnpm run stage` uses `bsk`). Whatever is chosen goes through
a guard: if its health check is red (no bsk daemon or no connected Chrome, no Claude key), or
`OTS_FORCE_SCRIPTED=1`, or it fails mid-run (for example consent declined), the run finishes on the scripted
executor with the same card and nothing on screen says so (only the log does).

- **bsk** (`src/executor/bsk.ts`): a tool-use loop on `claude-opus-5-5` whose tools wrap the `bsk` CLI
  (0.3.1): `snapshot`, `click`, `fill`, `press`, `navigate`, `select`, `wait-for-navigation`, `screenshot`,
  `scroll-to`, plus `step_done`, `needs_human`, `finish`. Lifecycle is `bsk session start --json` /
  `bsk session stop <id>` (always stopped, success or failure). The procedure's steps and `memorable recall`
  go in as guidance; the finished run's actions are recorded back to Memorable. A `bsk screenshot` lands on
  the run card every 4 s (`files.uploadV2` + image block). Start URL comes from the command
  (`commands.start_url`); null means the local smoke-test page `http://127.0.0.1:3977/mock/`.
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
| `OTS_SEED` | `1` | seed 50 fictional commands (`seed/commands.json`) into an empty library |
| `OTS_API_PORT` / `OTS_API_HOST` | `3977` / `127.0.0.1` | `/api/commands?q=`, `/api/health`, `/mock/` |
| `OTS_MOCK_URL` | `http://127.0.0.1:3977/mock/` | local smoke-test page |
| `BSK_BIN`, `BSK_TIMEOUT_MS`, `BSK_EFFORT` | `~/.local/bin/bsk`, `300000`, `medium` | BrowserSkill run settings |
| `OTS_WITH_QM` | `0` | `pnpm run stage` also starts QM |
| `OTS_QM_URL` | `http://localhost:8080` | QM dev instance |
| `GBRAIN_BIN` / `OTS_GBRAIN` | `~/.bun/bin/gbrain` / `1` | GBrain CLI |
| `OTS_REQUESTER` | `Priya` | name in "12 emails sent. Priya, done." |

## Website API

`GET http://127.0.0.1:3977/api/commands?q=send%20launch%20emails&limit=20` returns
`{ query, commands: [{ name, invoke, title, description, emoji, steps, author, uses, lastUsed, createdAt }] }`,
"everyone" commands only, CORS open, GET only.

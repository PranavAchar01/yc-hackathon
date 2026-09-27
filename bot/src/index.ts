import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApiServer, type HealthLine } from "./api.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ClaudeDrafter } from "./draft.ts";
import { BskExecutor } from "./executor/bsk.ts";
import { QmExecutor } from "./executor/qm.ts";
import { ScriptedExecutor } from "./executor/scripted.ts";
import { type CheckedExecutor, ResilientExecutor } from "./executor/select.ts";
import { ClaudeStepExtractor } from "./extract.ts";
import { MemoryLibrary } from "./library/memory.ts";
import { PgLibrary } from "./library/pg.ts";
import { seedIfEmpty } from "./library/seed.ts";
import type { CommandLibrary } from "./library/types.ts";
import { log } from "./log.ts";
import { defaultRunner, MemorableClient } from "./memorable.ts";
import { Outbox } from "./mock-site.ts";
import { Publisher } from "./publish.ts";
import { CommandRegistrar, SlackManifestApi } from "./registrar.ts";
import { CommandSearch, GBrainIndex } from "./search.ts";

const config = loadConfig();
const runner = defaultRunner();

// ---------------------------------------------------------------- library (Postgres, else in-memory)
async function openLibrary(): Promise<CommandLibrary> {
  if (config.OTS_LIBRARY === "postgres") {
    const pg = new PgLibrary(config.OTS_DATABASE_URL);
    try {
      await pg.migrate();
      return pg;
    } catch (err) {
      log.warn(
        `Postgres unavailable (${err instanceof Error ? err.message : err}); using an in-memory library`,
      );
      await pg.close().catch(() => undefined);
    }
  }
  return new MemoryLibrary();
}
const library = await openLibrary();
if (config.OTS_SEED && (await seedIfEmpty(library))) log.info(`seeded the ${library.kind} library`);

// ---------------------------------------------------------------- search (GBrain, else Postgres FTS + trigram)
function gbrainBin(): string[] | null {
  if (!config.OTS_GBRAIN) return null;
  if (config.GBRAIN_BIN) return config.GBRAIN_BIN.split(/\s+/);
  const bunGlobal = join(homedir(), ".bun", "bin", "gbrain");
  return existsSync(bunGlobal) ? [bunGlobal] : ["gbrain"];
}
const gbBin = gbrainBin();
const gbrain = gbBin
  ? new GBrainIndex(gbBin, join(config.botRoot, ".gbrain-pages"), runner, !!config.OPENAI_API_KEY)
  : null;
const search = new CommandSearch(library, gbrain);
if (gbrain)
  void library
    .publicList("", 500)
    .then((all) => gbrain.syncAll(all))
    .then((ok) => log.info(ok ? "GBrain pages synced" : "GBrain not available; search uses the library"));

// ---------------------------------------------------------------- memory, registration, publishing
const memorable = new MemorableClient(await MemorableClient.detectBin(runner), runner);

async function keychainSet(service: string, secret: string): Promise<void> {
  // Rotated Slack config tokens are single-use; keep the fresh pair in the login Keychain, never on disk.
  await new Promise<void>((resolve) => {
    const p = spawn(
      "security",
      ["add-generic-password", "-U", "-a", process.env.USER ?? "ots", "-s", service, "-w", secret],
      {
        stdio: "ignore",
      },
    );
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
}
const manifestApi = config.SLACK_CONFIG_TOKEN
  ? new SlackManifestApi(
      config.SLACK_CONFIG_TOKEN,
      config.SLACK_CONFIG_REFRESH_TOKEN,
      async (token, refresh) => {
        await keychainSet("SLACK_CONFIG_TOKEN", token);
        await keychainSet("SLACK_CONFIG_REFRESH_TOKEN", refresh);
        log.info("rotated the Slack config token (saved to Keychain)");
      },
    )
  : null;
const registrar = new CommandRegistrar(manifestApi, config.SLACK_APP_ID);
const publisher = new Publisher({
  library,
  skillsDir: config.skillsDir,
  gbrain,
  memorable,
  registrar,
  memorableScope: config.OTS_MEMORABLE_SCOPE,
});

// ---------------------------------------------------------------- executors
const outbox = new Outbox();
const scripted = new ScriptedExecutor(undefined, config.OTS_SCRIPTED_SPEED);
function primaryExecutor(): CheckedExecutor | null {
  if (config.OTS_EXECUTOR === "bsk")
    return new BskExecutor({
      bin: config.BSK_BIN,
      runner,
      apiKey: config.ANTHROPIC_API_KEY,
      defaultStartUrl: config.OTS_MOCK_URL,
      outbox,
      memorable,
      memorableScope: config.OTS_MEMORABLE_SCOPE,
      timeoutMs: config.BSK_TIMEOUT_MS,
      effort: config.BSK_EFFORT,
    });
  if (config.OTS_EXECUTOR === "qm") return new QmExecutor(config.OTS_QM_URL, config.OTS_QM_SIGNING_SECRET);
  return null;
}
const primary = primaryExecutor();
// Read per run, so `OTS_FORCE_SCRIPTED=1` can be flipped in the environment of a restarted bot instantly.
const executor = new ResilientExecutor(primary, scripted, () => config.OTS_FORCE_SCRIPTED);

const extractor = config.ANTHROPIC_API_KEY ? new ClaudeStepExtractor(config.ANTHROPIC_API_KEY) : null;
const drafter = config.ANTHROPIC_API_KEY ? new ClaudeDrafter(config.ANTHROPIC_API_KEY) : null;
if (!extractor) log.warn("ANTHROPIC_API_KEY not set: /teach, /new and Save as command cannot draft steps");

// ---------------------------------------------------------------- Slack + local HTTP
const { app, state } = createApp({
  config,
  executor,
  extractor,
  drafter,
  library,
  search,
  publisher,
});

async function health(): Promise<HealthLine[]> {
  const mem = await memorable.status().catch(() => null);
  const gbrainUp = gbrain ? await gbrain.available() : false;
  const primaryUp = primary ? await primary.healthy().catch(() => false) : true;
  return [
    { name: "Slack socket", ok: state.started, detail: state.started ? "connected" : "not connected" },
    {
      name: "Claude key",
      ok: !!config.ANTHROPIC_API_KEY,
      detail: config.ANTHROPIC_API_KEY ? "present" : "missing",
    },
    {
      name: "Library",
      ok: library.kind === "postgres",
      detail: `${library.kind}, ${await library.count().catch(() => 0)} commands`,
    },
    {
      name: "GBrain search",
      ok: gbrainUp,
      optional: true,
      detail: gbrainUp ? "up" : "down, using Postgres full-text + trigram",
    },
    {
      name: `Executor (${config.OTS_EXECUTOR})`,
      ok: primaryUp && !config.OTS_FORCE_SCRIPTED,
      optional: config.OTS_EXECUTOR === "scripted",
      detail: config.OTS_FORCE_SCRIPTED
        ? "forced scripted (OTS_FORCE_SCRIPTED=1)"
        : primaryUp
          ? "ready"
          : "not ready, /commands fall back to scripted",
    },
    {
      name: "Memorable",
      ok: !!mem?.available && mem.loggedIn && mem.consent,
      optional: true,
      detail: mem?.available
        ? `backend ${mem.backend}, login ${mem.loggedIn ? "ok" : "missing"}, consent ${mem.consent ? "on" : "off"}`
        : "CLI missing",
    },
    {
      name: "Slash registration",
      ok: registrar.enabled,
      optional: true,
      detail: registrar.enabled ? "apps.manifest.update" : "router only (/do <name>)",
    },
  ];
}

const server = createApiServer({ library, search, outbox, health });
server.listen(config.OTS_API_PORT, config.OTS_API_HOST, () =>
  log.info(
    `local API on http://${config.OTS_API_HOST}:${config.OTS_API_PORT} (/api/commands, /api/health, /mock/)`,
  ),
);

await app.start();
state.started = true;
log.info(
  `Over the Shoulder is up (executor: ${config.OTS_EXECUTOR}${config.OTS_FORCE_SCRIPTED ? ", forced scripted" : ""})`,
);

const shutdown = async () => {
  server.close();
  await app.stop().catch(() => undefined);
  await library.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

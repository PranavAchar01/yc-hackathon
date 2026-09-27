import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApiServer, type HealthLine } from "./api.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { LAUNCH_VIDEO_URL } from "./demo-data.ts";
import { LlmDrafter } from "./draft.ts";
import { BskExecutor } from "./executor/bsk.ts";
import { QmExecutor } from "./executor/qm.ts";
import { ScriptedExecutor } from "./executor/scripted.ts";
import { type CheckedExecutor, ResilientExecutor } from "./executor/select.ts";
import { LlmStepExtractor } from "./extract.ts";
import { GmailSender, parseTestInbox } from "./gmail-send.ts";
import { VideoLearner } from "./learn.ts";
import { MemoryLibrary } from "./library/memory.ts";
import { PgLibrary } from "./library/pg.ts";
import { seedIfEmpty, syncRealSiteCommands } from "./library/seed.ts";
import type { CommandLibrary } from "./library/types.ts";
import { AnthropicProvider, chooseProvider, type LlmProvider, OpenAIProvider } from "./llm.ts";
import { log } from "./log.ts";
import { defaultRunner, MemorableClient } from "./memorable.ts";
import { Publisher } from "./publish.ts";
import { CommandRegistrar, SlackManifestApi } from "./registrar.ts";
import { CommandSearch, GBrainIndex } from "./search.ts";
import { buildVideo, uploadVideo } from "./video.ts";

const config = loadConfig();
const runner = defaultRunner();

// ---------------------------------------------------------------- LLM (OpenAI preferred when both keys exist)
const choice = chooseProvider(config);
let llm: LlmProvider | null = null;
let agentLlm: LlmProvider | null = null;
if (choice.provider === "openai") {
  const openai = new OpenAIProvider(config.OPENAI_API_KEY, config.OTS_OPENAI_MODEL);
  llm = openai;
  void openai.checkModel();
  if (config.OTS_OPENAI_FAST_MODEL) {
    const fast = new OpenAIProvider(config.OPENAI_API_KEY, config.OTS_OPENAI_FAST_MODEL);
    agentLlm = fast;
    void fast.checkModel();
  }
} else if (choice.provider === "anthropic")
  llm = new AnthropicProvider(config.ANTHROPIC_API_KEY, config.OTS_ANTHROPIC_MODEL);
log.info(
  llm
    ? `LLM: ${llm.name} ${llm.model} (${choice.reason})`
    : `LLM: none (${choice.reason}); /teach and /new cannot draft, runs use scripted`,
);

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
if (config.OTS_SEED) {
  if (await seedIfEmpty(library)) log.info(`seeded the ${library.kind} library`);
  const synced = await syncRealSiteCommands(library);
  log.info(`real-site commands synced: ${synced.join(", ")}`);
}

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
const scripted = new ScriptedExecutor(undefined, config.OTS_SCRIPTED_SPEED);
function primaryExecutor(): CheckedExecutor | null {
  if (config.OTS_EXECUTOR === "bsk")
    return new BskExecutor({
      bin: config.BSK_BIN,
      runner,
      llm: agentLlm ?? llm,
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

const extractor = llm ? new LlmStepExtractor(llm) : null;
const drafter = llm ? new LlmDrafter(llm) : null;
// Downloads can take a while; give yt-dlp and ffmpeg 15 minutes.
const learner = llm
  ? new VideoLearner(llm, defaultRunner(process.env, 15 * 60_000), {
      ytdlp: config.YTDLP_BIN,
      ffmpeg: config.FFMPEG_BIN,
      ffprobe: config.FFPROBE_BIN,
    })
  : null;

// ---------------------------------------------------------------- Slack + local HTTP
const sender = config.OTS_TEST_INBOX
  ? new GmailSender({
      bin: config.BSK_BIN,
      runner,
      inbox: parseTestInbox(config.OTS_TEST_INBOX),
      videoUrl: LAUNCH_VIDEO_URL,
    })
  : undefined;
log.info(
  sender
    ? `Send: real Gmail, test plus-addresses of ${config.OTS_TEST_INBOX} only`
    : "Send: demo only (no OTS_TEST_INBOX)",
);

const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
async function publishVideo(command: string, framesDir: string): Promise<void> {
  if (!blobToken) return;
  try {
    const built = await buildVideo(framesDir, runner);
    if (!built) return;
    const up = await uploadVideo(built, command, blobToken);
    await library.setVideo(command, up.videoUrl, up.posterUrl);
    log.info(`video: /${command} ${built.frames} frames -> ${up.videoUrl}`);
  } catch (err) {
    log.warn(`video: /${command} failed: ${err instanceof Error ? err.message : err}`);
  }
}

const { app, state } = createApp({
  config,
  sender,
  publishVideo,
  executor,
  extractor,
  drafter,
  learner,
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
    { name: "LLM key", ok: !!llm, detail: llm ? `${llm.name} ${llm.model}` : choice.reason },
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

const server = createApiServer({ library, search, health });
server.listen(config.OTS_API_PORT, config.OTS_API_HOST, () =>
  log.info(`local API on http://${config.OTS_API_HOST}:${config.OTS_API_PORT} (/api/commands, /api/health)`),
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

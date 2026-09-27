/**
 * pnpm stage       start and pre-warm everything for the live demo, then print one green/red line per service.
 * pnpm stage:down  stop what `pnpm stage` started (never Docker itself, never the JobPilot containers).
 *
 * Order: Postgres -> GBrain -> bot -> Cua sandbox warm (browser open) -> Memorable pre-record -> health.
 * QM is off the visible path, so it only starts with OTS_WITH_QM=1.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeed } from "../src/library/seed.ts";
import { defaultRunner, MemorableClient } from "../src/memorable.ts";

const BOT = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(BOT, "..");
const STATE = join(BOT, ".stage");
const COMPOSE = join(ROOT, "qm-config", "docker-compose.yml");
const API = `http://127.0.0.1:${process.env.OTS_API_PORT ?? "3977"}`;
const EXECUTOR = process.env.OTS_EXECUTOR ?? "cua";
const CONTAINER = process.env.CUA_CONTAINER ?? "ots-cua";
const IMAGE = process.env.CUA_IMAGE ?? "trycua/cua-ubuntu:latest";
const WITH_QM = process.env.OTS_WITH_QM === "1";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const say = (s: string) => process.stdout.write(`${dim("·")} ${s}\n`);
const t0 = Date.now();

interface Line {
  name: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
}
const lines: Line[] = [];

function sh(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs ?? 60_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function readPid(name: string): number | null {
  const f = join(STATE, `${name}.pid`);
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 && pidAlive(pid) ? pid : null;
}
function stopPid(name: string) {
  const pid = readPid(name);
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM"); // the whole process group we started
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
  rmSync(join(STATE, `${name}.pid`), { force: true });
}
/** Start a detached background process with Keychain secrets in its env; logs go to .stage/<name>.log. */
function startDetached(name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  mkdirSync(STATE, { recursive: true });
  const log = openSync(join(STATE, `${name}.log`), "w");
  const child = spawn("bash", ["-c", `source "${join(BOT, "scripts", "secrets.sh")}" && exec ${command}`], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
  writeFileSync(join(STATE, `${name}.pid`), String(child.pid));
}

async function down() {
  stopPid("bot");
  stopPid("qm");
  if (sh("docker", ["inspect", CONTAINER]).code === 0)
    sh("docker", ["stop", CONTAINER], { timeoutMs: 30_000 });
  sh("docker", ["compose", "-f", COMPOSE, "stop"], { timeoutMs: 60_000 });
  say("stopped bot, QM, the Cua sandbox and ots-postgres");
}

async function up() {
  // 1. Postgres (our own container on 5544; JobPilot's is never touched)
  say("Postgres");
  sh("docker", ["compose", "-f", COMPOSE, "up", "-d", "postgres"], { timeoutMs: 120_000 });
  let pgOk = false;
  for (let i = 0; i < 40 && !pgOk; i++) {
    pgOk = sh("docker", ["exec", "ots-postgres", "pg_isready", "-U", "ots", "-d", "ots"]).code === 0;
    if (!pgOk) await sleep(500);
  }
  lines.push({
    name: "Postgres :5544",
    ok: pgOk,
    detail: pgOk ? "ready" : "not ready (is Docker Desktop running?)",
  });

  // 2. GBrain (keyword-only PGLite brain unless OPENAI_API_KEY is set)
  say("GBrain");
  const gb =
    process.env.GBRAIN_BIN ??
    (existsSync(join(homedir(), ".bun", "bin", "gbrain"))
      ? join(homedir(), ".bun", "bin", "gbrain")
      : "gbrain");
  let gbOk = sh(gb, ["search", "ping", "--json"], { timeoutMs: 20_000 }).code === 0;
  if (!gbOk && sh("sh", ["-c", `command -v "${gb}"`]).code === 0) {
    sh(gb, ["init", "--pglite", "--no-embedding"], { timeoutMs: 60_000 });
    gbOk = sh(gb, ["search", "ping", "--json"], { timeoutMs: 20_000 }).code === 0;
  }
  lines.push({
    name: "GBrain",
    ok: gbOk,
    optional: true,
    detail: gbOk ? "up" : "not installed; search uses Postgres",
  });

  // 3. QM (optional; not on the visible demo path)
  if (WITH_QM) {
    say("QM dev instance");
    stopPid("qm");
    startDetached("qm", "npm run dev", join(ROOT, "qm"), { ...process.env });
  }

  // 4. Bot
  say("bot");
  stopPid("bot");
  startDetached("bot", "node --import tsx src/index.ts", BOT, { ...process.env, OTS_EXECUTOR: EXECUTOR });

  // 5. Cua sandbox: pull once, boot, open the browser (persistent profile) so the first /command is fast
  if (EXECUTOR === "cua") {
    say("Cua sandbox");
    if (sh("docker", ["image", "inspect", IMAGE]).code !== 0) {
      // The Mac keeps a 20 GB free-space floor; the image is a few GB, so only pull with room to spare.
      const freeGb =
        Number(sh("df", ["-k", "/"]).out.split("\n")[1]?.trim().split(/\s+/)[3] ?? 0) / 1024 / 1024;
      if (freeGb < 26)
        say(red(`not pulling ${IMAGE}: only ${freeGb.toFixed(0)} GB free (keep 20 GB + image)`));
      else {
        say(`pulling ${IMAGE} (one time, a few GB)`);
        sh("docker", ["pull", IMAGE], { timeoutMs: 20 * 60_000 });
      }
    }
    // The local smoke-test page by default; OTS_WARM_URL points it at the real demo site once that is decided.
    const firstUrl = process.env.OTS_WARM_URL ?? "http://host.docker.internal:3977/mock/";
    const warm = sh(
      "bash",
      [
        "-c",
        `mkdir -p .sandbox/storage && source scripts/secrets.sh && CUA_STORAGE="$PWD/.sandbox/storage" uv run --quiet --python 3.12 cua/runner.py warm "${firstUrl}"`,
      ],
      { cwd: BOT, timeoutMs: 180_000 },
    );
    const ok = warm.code === 0 && warm.out.includes('"type": "done"');
    lines.push({
      name: "Cua sandbox",
      ok,
      detail: ok ? `browser open on ${firstUrl}` : (warm.out.split("\n").slice(-1)[0] ?? "failed"),
    });
  }

  // 6. Memorable: record the demo procedures once so the first recall already has something
  say("Memorable");
  const runner = defaultRunner();
  const mem = new MemorableClient(await MemorableClient.detectBin(runner), runner);
  const seed = loadSeed();
  const gtm = seed.commands.find((c) => c.name === "gtm");
  let memOk = false;
  let memDetail = "no gtm in seed";
  if (gtm) {
    const out = await mem.save(
      {
        name: gtm.name,
        title: gtm.title,
        description: gtm.description,
        steps: gtm.steps,
        teacher: "Mark Ellis",
        demonstrations: 1,
      },
      join(BOT, "skills", "gtm", "SKILL.md"),
      process.env.OTS_MEMORABLE_SCOPE ?? "personal",
    );
    memOk = out.saved;
    memDetail = out.saved ? "gtm procedure recorded" : out.detail;
  }
  lines.push({ name: "Memorable", ok: memOk, optional: true, detail: memDetail });

  // 7. Health from the bot itself (Slack socket, library, executor, ...)
  say("health");
  let botLines: Line[] = [];
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { services: Line[] };
      botLines = body.services;
      if (botLines.find((l) => l.name === "Slack socket")?.ok) break;
    } catch {
      // bot still booting
    }
    if (readPid("bot") === null) break;
    await sleep(500);
  }
  if (botLines.length === 0) {
    const tail = existsSync(join(STATE, "bot.log"))
      ? readFileSync(join(STATE, "bot.log"), "utf8").trim().split("\n").slice(-3).join(" | ")
      : "";
    lines.push({ name: "Bot", ok: false, detail: tail || "did not start" });
  }
  if (WITH_QM) {
    const qm = await fetch("http://127.0.0.1:8080/healthz", { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok)
      .catch(() => false);
    lines.push({
      name: "QM :8080",
      ok: qm,
      optional: true,
      detail: qm ? "up" : "not up (see .stage/qm.log)",
    });
  } else lines.push({ name: "QM", ok: true, optional: true, detail: "skipped (OTS_WITH_QM=0)" });

  const all = [...lines, ...botLines.filter((l) => !lines.some((x) => x.name === l.name))];
  process.stdout.write("\n");
  for (const l of all) {
    const mark = l.ok ? green("●") : l.optional ? dim("○") : red("●");
    process.stdout.write(
      `${mark} ${l.name.padEnd(24)} ${l.ok ? l.detail : l.optional ? dim(l.detail) : red(l.detail)}\n`,
    );
  }
  const hard = all.filter((l) => !l.ok && !l.optional);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  process.stdout.write(
    `\n${hard.length === 0 ? green(`All green in ${secs} s. Try /gtm once.`) : red(`${hard.length} red in ${secs} s. Commands still work: they fall back to scripted.`)}\n`,
  );
  process.stdout.write(dim(`logs: ${STATE}/bot.log   stop: pnpm stage:down\n`));
}

await (process.argv[2] === "down" ? down() : up());

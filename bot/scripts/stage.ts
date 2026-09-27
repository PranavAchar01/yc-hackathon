/**
 * Note: pnpm 11 has a built-in `pnpm stage` (package staging), so these run as `pnpm run stage[:down]`.
 * pnpm run stage       start and pre-warm everything for the live demo, then ALWAYS print one line per service.
 * pnpm run stage:down  stop what `pnpm stage` started (never Docker itself, never the JobPilot containers).
 *
 * Order: Postgres -> GBrain -> BrowserSkill (daemon + connected Chrome) -> Memorable -> QM (optional) -> bot -> health.
 * No Docker images are pulled. bsk sessions are not started here: the consent prompt belongs to the first run.
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
const EXECUTOR = process.env.OTS_EXECUTOR ?? "bsk";
const WITH_QM = process.env.OTS_WITH_QM === "1";
const BSK = process.env.BSK_BIN ?? join(homedir(), ".local", "bin", "bsk");
const ESC = String.fromCharCode(27);

const color = (code: string) => (s: string) => (process.stdout.isTTY ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const green = color("32");
const red = color("31");
const dim = color("2");
const say = (s: string) => process.stdout.write(`${dim("·")} ${s}\n`);
const t0 = Date.now();

export interface Line {
  name: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
}
const lines: Line[] = [];
const add = (l: Line) => lines.push(l);

function sh(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    input: opts.input,
  });
  if (r.error) return { code: 127, out: r.error.message };
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keychainHas = (name: string) => sh("security", ["find-generic-password", "-s", name]).code === 0;
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
      process.kill(-pid, "SIGTERM"); // the process group we started
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
  rmSync(join(STATE, `${name}.pid`), { force: true });
}
/** Detached background process; secrets come from Keychain inside the child shell, logs go to .stage/<name>.log. */
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
const tail = (name: string) => {
  const f = join(STATE, `${name}.log`);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").slice(-2).join(" | ").slice(0, 160) : "";
};

async function step(name: string, fn: () => Promise<void> | void) {
  say(name);
  try {
    await fn();
  } catch (err) {
    add({ name, ok: false, detail: err instanceof Error ? err.message.slice(0, 160) : String(err) });
  }
}

export function renderTable(all: Line[], secs: number): string {
  const out: string[] = [""];
  for (const l of all) {
    const mark = l.ok ? green("●") : l.optional ? dim("○") : red("●");
    const detail = l.ok ? l.detail : l.optional ? dim(l.detail) : red(l.detail);
    out.push(`${mark} ${l.name.padEnd(26)} ${detail}`);
  }
  const hard = all.filter((l) => !l.ok && !l.optional);
  out.push(
    "",
    hard.length === 0
      ? green(`All green in ${secs} s. Try /gtm once in Slack.`)
      : red(`${hard.length} red in ${secs} s. Commands still run: they fall back to scripted.`),
    dim(`logs: ${STATE}/*.log   stop: pnpm run stage:down`),
    "",
  );
  return out.join("\n");
}

async function up() {
  await step("Postgres :5544", async () => {
    const upRes = sh("docker", ["compose", "-f", COMPOSE, "up", "-d", "postgres"], { timeoutMs: 120_000 });
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
      ok = sh("docker", ["exec", "ots-postgres", "pg_isready", "-U", "ots", "-d", "ots"]).code === 0;
      if (!ok) await sleep(500);
    }
    add({
      name: "Postgres :5544",
      ok,
      detail: ok
        ? "ready"
        : upRes.code === 127
          ? "docker not found"
          : "not ready (is Docker Desktop running?)",
    });
  });

  await step("GBrain", () => {
    const bunGb = join(homedir(), ".bun", "bin", "gbrain");
    const gb = process.env.GBRAIN_BIN ?? (existsSync(bunGb) ? bunGb : "gbrain");
    let ok = sh(gb, ["search", "ping", "--json"], { timeoutMs: 20_000 }).code === 0;
    if (!ok && sh(gb, ["--version"]).code !== 127) {
      sh(gb, ["init", "--pglite", "--no-embedding"], { timeoutMs: 60_000 });
      ok = sh(gb, ["search", "ping", "--json"], { timeoutMs: 20_000 }).code === 0;
    }
    add({
      name: "GBrain",
      ok,
      optional: true,
      detail: ok ? "up" : "not installed (bun install -g github:garrytan/gbrain); search uses Postgres",
    });
  });

  await step("BrowserSkill", () => {
    const r = sh(BSK, ["status", "--json"], { timeoutMs: 15_000 });
    let browsers = 0;
    let version = "";
    try {
      const j = JSON.parse(r.out) as { browsers?: unknown[]; daemon_version?: string };
      browsers = j.browsers?.length ?? 0;
      version = j.daemon_version ?? "";
    } catch {
      // not JSON: daemon down or CLI missing
    }
    add({
      name: "bsk daemon",
      ok: r.code === 0 && version !== "",
      optional: EXECUTOR !== "bsk",
      detail:
        r.code === 127 ? `bsk not found at ${BSK}` : version ? `v${version}` : "not running (bsk doctor)",
    });
    add({
      name: "bsk Chrome connected",
      ok: browsers > 0,
      optional: EXECUTOR !== "bsk",
      detail:
        browsers > 0
          ? `${browsers} browser${browsers === 1 ? "" : "s"}`
          : "open Chrome with the BrowserSkill extension",
    });
  });

  await step("Memorable", async () => {
    const bin =
      sh("sh", ["-c", "command -v memorable"]).code === 0
        ? ["memorable"]
        : ["npx", "-y", "memorable-cli@latest"];
    const [cmd = "npx", ...pre] = bin;
    const st = sh(cmd, [...pre, "status"], { timeoutMs: 60_000 });
    const plain = st.out.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
    const loggedIn = st.code !== 127 && !/extraction api\s+not configured|run `memorable login`/i.test(plain);
    const consent = !/write consent\s+unset|fails closed until/i.test(plain);
    add({
      name: "Memorable",
      ok: loggedIn && consent,
      optional: true,
      detail:
        st.code === 127
          ? "CLI missing"
          : !loggedIn
            ? "not logged in (memorable login)"
            : !consent
              ? "consent off (memorable enable)"
              : "logged in, consent on",
    });
    if (loggedIn && consent) {
      // Pre-record the GTM procedure once so the first run already has something to recall.
      const runner = defaultRunner();
      const mem = new MemorableClient(bin, runner);
      const gtm = loadSeed().commands.find((c) => c.name === "gtm");
      if (gtm) {
        const out = await mem.save(
          { ...gtm, teacher: "Mark Ellis", demonstrations: 1 },
          join(BOT, "skills", "gtm", "SKILL.md"),
          process.env.OTS_MEMORABLE_SCOPE ?? "personal",
        );
        add({
          name: "Memorable pre-record",
          ok: out.saved,
          optional: true,
          detail: out.saved ? "gtm recorded" : out.detail,
        });
      }
    }
  });

  if (WITH_QM)
    await step("QM", async () => {
      stopPid("qm");
      startDetached("qm", "npm run dev", join(ROOT, "qm"), { ...process.env });
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        ok = await fetch("http://127.0.0.1:8080/healthz", { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false);
        if (!ok) await sleep(500);
      }
      add({ name: "QM :8080", ok, optional: true, detail: ok ? "up" : `not up: ${tail("qm")}` });
    });
  else add({ name: "QM", ok: true, optional: true, detail: "skipped (OTS_WITH_QM=0, not on the demo path)" });

  await step("bot", async () => {
    const missing = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "ANTHROPIC_API_KEY"].filter(
      (n) => !keychainHas(n),
    );
    add({
      name: "Keychain secrets",
      ok: missing.length === 0,
      detail: missing.length === 0 ? "Slack + Claude keys present" : `missing: ${missing.join(", ")}`,
    });
    if (missing.some((n) => n.startsWith("SLACK_"))) {
      add({ name: "Bot", ok: false, detail: "not started: Slack tokens missing" });
      return;
    }
    stopPid("bot");
    startDetached("bot", "node --import tsx src/index.ts", BOT, { ...process.env, OTS_EXECUTOR: EXECUTOR });
    let services: Line[] = [];
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) });
        services = ((await res.json()) as { services: Line[] }).services;
        if (services.find((l) => l.name === "Slack socket")?.ok) break;
      } catch {
        // still booting
      }
      if (readPid("bot") === null) break;
      await sleep(500);
    }
    if (services.length === 0) add({ name: "Bot", ok: false, detail: tail("bot") || "did not start" });
    else for (const s of services) if (!lines.some((l) => l.name === s.name)) add(s);
  });
}

function down() {
  stopPid("bot");
  stopPid("qm");
  sh("docker", ["compose", "-f", COMPOSE, "stop"], { timeoutMs: 60_000 });
  say("stopped the bot, QM and ots-postgres (Docker itself and JobPilot untouched)");
}

if (process.argv[2] === "down") down();
else {
  try {
    await up();
  } catch (err) {
    add({ name: "stage", ok: false, detail: err instanceof Error ? err.message : String(err) });
  } finally {
    process.stdout.write(renderTable(lines, Math.round((Date.now() - t0) / 1000)));
    if (lines.some((l) => !l.ok && !l.optional)) process.exitCode = 1;
  }
}

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { demoDrafts } from "../demo-data.ts";
import { log } from "../log.ts";
import type { CliRunner, MemorableClient, TraceCall } from "../memorable.ts";
import type { Outbox } from "../mock-site.ts";
import type { EventSink, Executor, RunResult, RunTask } from "./types.ts";

/**
 * Real computer use: Cua (github.com/trycua/cua) drives a local Docker Linux desktop (trycua/cua-ubuntu)
 * with a Claude computer-use model, through cua/runner.py (cua-agent 0.8.4, cua-computer 0.5.19).
 * The procedure's steps go in as guidance; Memorable recalls earlier runs before, and records this run after.
 * Progress: the agent writes "STEP n DONE"; screenshots stream to the Slack card as they land.
 */

export const RunnerLine = z.discriminatedUnion("type", [
  z.object({ type: z.literal("action"), name: z.string() }),
  z.object({ type: z.literal("message"), text: z.string() }),
  z.object({ type: z.literal("screenshot"), path: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("done"),
    summary: z.string(),
    actions: z.array(z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) })),
  }),
]);
export type RunnerLine = z.infer<typeof RunnerLine>;

export function parseRunnerLine(line: string): RunnerLine | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = RunnerLine.safeParse(JSON.parse(t));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const NEEDS_YOU = /NEEDS YOU/i;

/** Every "STEP n DONE" in a message, as zero-based indexes. */
export function stepsDone(text: string): number[] {
  return [...text.matchAll(/STEP\s+(\d+)\s+DONE/gi)].map((m) => Number(m[1]) - 1).filter((n) => n >= 0);
}

export interface CuaOptions {
  runnerPath: string;
  /** Fallback start URL when the command has none: the local smoke-test page as the sandbox sees it. */
  startUrl: string;
  container: string;
  /** Host dir mounted into the sandbox; holds the persistent Firefox profile (sign-ins survive restarts). */
  storageDir: string;
  env: NodeJS.ProcessEnv;
  outbox: Outbox;
  memorable: MemorableClient | null;
  memorableScope: string;
  runner: CliRunner;
  timeoutMs?: number;
  uvBin?: string;
}

export class CuaExecutor implements Executor {
  readonly name = "cua" as const;

  constructor(private readonly o: CuaOptions) {}

  /** Green when the sandbox container is running and a Claude key is present. */
  async healthy(): Promise<boolean> {
    if (!this.o.env.ANTHROPIC_API_KEY) return false;
    const res = await this.o.runner(["docker", "inspect", "-f", "{{.State.Running}}", this.o.container]);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  async run(task: RunTask, onEvent: EventSink, signal?: AbortSignal): Promise<RunResult> {
    const started = Date.now();
    const p = task.procedure;
    const recalled = this.o.memorable ? await this.o.memorable.recall(p.title).catch(() => "") : "";
    const dir = await mkdtemp(join(tmpdir(), "ots-cua-"));
    const shotsDir = join(dir, "shots");
    await mkdir(shotsDir, { recursive: true });
    const taskFile = join(dir, "task.json");
    await writeFile(
      taskFile,
      JSON.stringify({
        title: p.title,
        steps: p.steps,
        startUrl: task.startUrl || this.o.startUrl,
        extra: task.extra,
        recalled,
        shotsDir,
      }),
    );

    await onEvent({ kind: "step", index: 0, state: "running" });
    let current = 0;
    const done = new Set<number>();
    let final: Extract<RunnerLine, { type: "done" }> | null = null;
    let failure: string | null = null;
    let needsYou: string | null = null;

    const child = spawn(
      this.o.uvBin ?? "uv",
      ["run", "--quiet", "--python", "3.12", this.o.runnerPath, "run", taskFile],
      {
        env: { ...this.o.env, CUA_CONTAINER: this.o.container, CUA_STORAGE: this.o.storageDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const kill = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, this.o.timeoutMs ?? 240_000);
    child.stderr.on("data", () => {}); // cua logs; keep the pipe drained

    for await (const line of createInterface({ input: child.stdout })) {
      const ev = parseRunnerLine(line);
      if (!ev) continue;
      if (ev.type === "screenshot") await onEvent({ kind: "screenshot", path: ev.path });
      else if (ev.type === "error") failure = ev.message;
      else if (ev.type === "done") final = ev;
      else if (ev.type === "message") {
        if (NEEDS_YOU.test(ev.text) && !needsYou) {
          // Sign-in, 2FA or sudo prompt: never automated. Stop and hand it to a human.
          needsYou = "Needs you: sign in";
          await onEvent({ kind: "needs_you", message: needsYou });
          kill();
          continue;
        }
        for (const i of stepsDone(ev.text)) {
          if (i >= p.steps.length || done.has(i)) continue;
          done.add(i);
          await onEvent({ kind: "step", index: i, state: "done" });
          current = Math.max(current, i + 1);
          if (current < p.steps.length && !done.has(current))
            await onEvent({ kind: "step", index: current, state: "running" });
        }
      }
    }
    const code: number = await new Promise((r) => {
      if (child.exitCode !== null) r(child.exitCode);
      else child.on("close", (c) => r(c ?? 1));
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    if (needsYou) {
      return { elapsedMs: Date.now() - started, drafts: [], executedBy: "cua", needsYou };
    }
    if (!final) throw new Error(failure ?? `cua runner exited ${code} without finishing`);

    for (let i = 0; i < p.steps.length; i++)
      if (!done.has(i)) await onEvent({ kind: "step", index: i, state: "done" });

    if (this.o.memorable) {
      const calls: TraceCall[] = final.actions.map((a) => ({
        name: a.name,
        input: a.input,
        result: { ok: true },
      }));
      void this.o.memorable
        .recordTrace(`${p.title}: ${p.description}`, calls, this.o.memorableScope, `${p.name}-cua`)
        .then((m) => log.info(`cua run recorded: ${m.detail}`));
    }
    const queued = this.o.outbox.since(started);
    return {
      elapsedMs: Date.now() - started,
      drafts: queued.length > 0 ? queued : p.name === "gtm" ? demoDrafts(p.teacher) : [],
      summary: final.summary,
      executedBy: "cua",
    };
  }
}

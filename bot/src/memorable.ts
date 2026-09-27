import { spawn } from "node:child_process";
import type { Procedure } from "./procedure.ts";

/**
 * Memorable CLI bridge (memorable-cli 0.5.19, checked against its --help, README and dist/cli.js).
 *
 * Real command surface we rely on:
 *   memorable status                   human-readable; says "extraction api  not configured" until `memorable login`
 *                                      and "write consent  unset" until `memorable enable`
 *   memorable ingest <trace.json | ->  local backend: trace JSON {prompt, tool_calls:[{name,input,result?}]}
 *   memorable record --scope <id> -    gbrain/qm backends only (session capture). This is what QM itself calls
 *                                      (qm/src/memory/memorable/relay.ts); on the local backend it refuses with
 *                                      "`record` uses gbrain's session capture ... use `memorable ingest`".
 *
 * So: with MEMORABLE_BACKEND=qm (QM's Postgres) we use `record`, exactly as QM does; otherwise `ingest -`.
 * Every failure degrades to a log line and a `saved: false` result; the QM skill file is still written.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CliRunner = (argv: string[], stdin?: string) => Promise<CliResult>;

export interface TraceCall {
  name: string;
  input: Record<string, unknown>;
  result?: { ok: boolean };
}

export interface MemorableOutcome {
  saved: boolean;
  /** One line for the log and, when not saved, for the card context. */
  detail: string;
}

export function defaultRunner(env: NodeJS.ProcessEnv = process.env, timeoutMs = 120_000): CliRunner {
  return (argv, stdin) =>
    new Promise((resolve) => {
      const [cmd, ...args] = argv;
      if (!cmd) return resolve({ code: 127, stdout: "", stderr: "empty command" });
      const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin ?? "");
    });
}

export interface MemorableStatus {
  available: boolean;
  loggedIn: boolean;
  consent: boolean;
  backend: string;
}

/** Parse `memorable status` text. Exported for tests. */
export function parseStatus(text: string): Omit<MemorableStatus, "available"> {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes is the point
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const backend = /backend\s+(\w+)/.exec(plain)?.[1] ?? "unknown";
  const loggedIn = !/extraction api\s+not configured/i.test(plain) && !/run `memorable login`/i.test(plain);
  const consent = !/write consent\s+unset/i.test(plain) && !/fails closed until/i.test(plain);
  return { backend, loggedIn, consent };
}

export class MemorableClient {
  constructor(
    private readonly bin: string[],
    private readonly runner: CliRunner,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Prefer `memorable` on PATH, else `npx -y memorable-cli@latest`. MEMORABLE_BIN overrides. */
  static async detectBin(runner: CliRunner, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    if (env.MEMORABLE_BIN?.trim()) return env.MEMORABLE_BIN.trim().split(/\s+/);
    const which = await runner(["/bin/sh", "-c", "command -v memorable"]);
    return which.code === 0 && which.stdout.trim() ? ["memorable"] : ["npx", "-y", "memorable-cli@latest"];
  }

  async status(): Promise<MemorableStatus> {
    const res = await this.runner([...this.bin, "status"]);
    if (res.code === 127) return { available: false, loggedIn: false, consent: false, backend: "none" };
    return { available: true, ...parseStatus(`${res.stdout}\n${res.stderr}`) };
  }

  async save(p: Procedure, skillFile: string, scope: string): Promise<MemorableOutcome> {
    const toolCalls: TraceCall[] = [
      ...p.steps.map((step, i) => ({ name: "ui_step", input: { index: i + 1, step }, result: { ok: true } })),
      { name: "write", input: { path: skillFile }, result: { ok: true } },
    ];
    return this.recordTrace(`${p.title}: ${p.description}`, toolCalls, scope, p.name);
  }

  /** Record one executed run (e.g. every browser run's actions) so the next run can recall it. */
  async recordTrace(
    prompt: string,
    toolCalls: TraceCall[],
    scope: string,
    id: string,
  ): Promise<MemorableOutcome> {
    const st = await this.status();
    if (!st.available) return { saved: false, detail: "memorable CLI not found (npm i -g memorable-cli)" };
    if (!st.loggedIn)
      return { saved: false, detail: "memorable is not logged in; run `npx memorable-cli login`" };
    if (!st.consent) return { saved: false, detail: "memorable consent is off; run `memorable enable`" };
    const useRecord = (this.env.MEMORABLE_BACKEND ?? "").trim() === "qm" || st.backend === "gbrain";
    const argv = useRecord ? [...this.bin, "record", "--scope", scope, "-"] : [...this.bin, "ingest", "-"];
    const workflowId = `ots-${id}-${Date.now()}`;
    const payload = useRecord
      ? {
          session_id: workflowId,
          scope_id: scope,
          workflows: [{ workflow_id: workflowId, prompt, tool_calls: toolCalls }],
        }
      : { prompt, tool_calls: toolCalls };
    const res = await this.runner(argv, JSON.stringify(payload));
    const out = `${res.stdout}\n${res.stderr}`.replace(/\s+/g, " ").trim();
    const verb = argv[this.bin.length];
    if (res.code !== 0) return { saved: false, detail: `memorable ${verb} failed: ${out.slice(0, 240)}` };
    return { saved: true, detail: `memorable ${verb} ok: ${out.slice(0, 160)}` };
  }

  /** `memorable recall "<query>"`: the stored procedure text for a similar task, or "" when none or offline. */
  async recall(query: string): Promise<string> {
    const res = await this.runner([...this.bin, "recall", query]);
    return res.code === 0 ? res.stdout.trim().slice(0, 6000) : "";
  }
}

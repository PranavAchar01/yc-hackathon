import { createHmac } from "node:crypto";
import { z } from "zod";
import { demoDrafts, type EmailDraft } from "../demo-data.ts";
import { log } from "../log.ts";
import type { EventSink, Executor, RunResult, RunTask } from "./types.ts";

/**
 * Hands the procedure to a local QM dev instance over its HTTP API.
 *
 * Endpoint (qm/src/api/routes/turns.ts): POST /v1/turns, auth "source".
 *   body: TurnRequest { surface, actor: { externalId }, conversation: { kind: "dm", threadRef }, text }
 *   200 -> TurnResult { status: "ok" | "refused" | "failed" | ..., reply?, runId?, reason? }
 * Health: GET /healthz -> { ok: true }.
 * Source auth (qm/src/auth/source-auth-sign.ts): when QM has CORE_SIGNING_SECRET, send
 *   x-timestamp: <unix seconds>
 *   x-signature: v0=HMAC_SHA256(secret, "v0:<ts>:<METHOD>\n<path?query>\n<body>")
 * With ALLOW_UNAUTHENTICATED_CORE=1 and no secret, QM accepts unsigned requests (local only).
 *
 * The turn is synchronous and QM does not stream per-step progress on this route, so step 1 shows
 * as running while QM works and the rest resolve from QM's structured step report at the end.
 */

export function signHeaders(
  secret: string,
  method: string,
  pathWithQuery: string,
  body: string,
  nowSec: number,
) {
  const canonical = `${method}\n${pathWithQuery}\n${body}`;
  const sig = createHmac("sha256", secret).update(`v0:${nowSec}:${canonical}`).digest("hex");
  return { "x-timestamp": String(nowSec), "x-signature": `v0=${sig}` };
}

const TurnResultSchema = z.object({
  status: z.string(),
  reply: z.string().optional(),
  reason: z.string().optional(),
  runId: z.string().optional(),
});

const StepReportSchema = z.object({
  steps: z.array(
    z.object({ index: z.number().int(), status: z.enum(["done", "failed"]), note: z.string().optional() }),
  ),
  drafts: z
    .array(
      z.object({
        to: z.string(),
        toName: z.string(),
        company: z.string(),
        subject: z.string(),
        body: z.string(),
        attachment: z.string(),
      }),
    )
    .default([]),
});
export type StepReport = z.infer<typeof StepReportSchema>;

/** Pull the last fenced or bare JSON object out of QM's reply. Exported for tests. */
export function parseStepReport(reply: string): StepReport | null {
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const candidates = fenced.length
    ? fenced.reverse()
    : [reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    try {
      const parsed = StepReportSchema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON, try the next candidate
    }
  }
  return null;
}

export function buildQmPrompt(task: RunTask): string {
  const p = task.procedure;
  return [
    `Run the "${p.name}" procedure (${p.title}), learned from ${p.teacher}'s demonstration.`,
    task.extra ? `Extra instructions: ${task.extra}` : "",
    "Steps:",
    ...p.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Hard rules: draft only, never send any email or message. Only use recipients at @example.com.",
    'When finished, reply with one fenced JSON block: {"steps":[{"index":1,"status":"done","note":"..."}],',
    '"drafts":[{"to":"","toName":"","company":"","subject":"","body":"","attachment":""}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

export class QmExecutor implements Executor {
  readonly name = "qm" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string | undefined,
    private readonly timeoutMs = 5 * 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async healthy(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async run(task: RunTask, onEvent: EventSink, signal?: AbortSignal): Promise<RunResult> {
    const started = Date.now();
    await onEvent({ kind: "step", index: 0, state: "running" });
    const path = "/v1/turns";
    const body = JSON.stringify({
      surface: "over-the-shoulder",
      actor: { externalId: task.userId },
      conversation: { kind: "dm", threadRef: `ots:${task.threadRef}` },
      text: buildQmPrompt(task),
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.signingSecret)
      Object.assign(
        headers,
        signHeaders(this.signingSecret, "POST", path, body, Math.floor(Date.now() / 1000)),
      );

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const turn = TurnResultSchema.parse(await res.json());
    if (turn.status !== "ok")
      throw new Error(`QM turn ${turn.status}: ${turn.reason ?? `HTTP ${res.status}`}`);

    const reply = turn.reply ?? "";
    const report = parseStepReport(reply);
    const count = task.procedure.steps.length;
    for (let i = 0; i < count; i++) {
      const r = report?.steps.find((s) => s.index === i + 1);
      await onEvent({
        kind: "step",
        index: i,
        state: r?.status ?? "done",
        ...(r?.note ? { note: r.note } : {}),
      });
    }
    let drafts: EmailDraft[] = (report?.drafts ?? []).filter((d) =>
      d.to.toLowerCase().endsWith("@example.com"),
    );
    if (drafts.length === 0) {
      log.warn("QM returned no @example.com drafts; showing the fictional demo drafts instead");
      drafts = demoDrafts(task.procedure.teacher);
    }
    return { elapsedMs: Date.now() - started, drafts, summary: reply, executedBy: "qm" };
  }
}

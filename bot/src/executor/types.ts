import type { EmailDraft } from "../demo-data.ts";
import type { Procedure } from "../procedure.ts";

export type StepState = "pending" | "running" | "done" | "failed";

export interface RunTask {
  procedure: Procedure;
  /** Slack user id of whoever typed the command. */
  userId: string;
  /** Stable reference for this run (channel + message ts), used as QM's threadRef. */
  threadRef: string;
  /** Free text after the command, e.g. "/ots gtm for the EU list". */
  extra: string;
  /** Where a computer-use run starts; from the command's config. */
  startUrl?: string | null;
}

export type ExecEvent =
  | { kind: "step"; index: number; state: StepState; note?: string }
  | { kind: "screenshot"; path: string }
  | { kind: "needs_you"; message: string }
  | { kind: "log"; message: string };

export interface RunResult {
  elapsedMs: number;
  drafts: EmailDraft[];
  /** Free-text summary from the executor (QM's reply), shown in the thread when present. */
  summary?: string;
  /** Which executor actually ran the steps, shown in the footer. */
  executedBy: ExecutorName;
  /** Set when the run stopped for a human (sign-in, 2FA, sudo). Not a failure: no fallback. */
  needsYou?: string;
}

export type EventSink = (event: ExecEvent) => void | Promise<void>;

/** Runs a learned procedure and reports step progress. Implementations must never send email. */
export type ExecutorName = "scripted" | "qm" | "bsk";

export interface Executor {
  readonly name: ExecutorName;
  run(task: RunTask, onEvent: EventSink, signal?: AbortSignal): Promise<RunResult>;
}

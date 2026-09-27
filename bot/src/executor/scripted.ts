import { demoDrafts } from "../demo-data.ts";
import type { EventSink, Executor, RunResult, RunTask } from "./types.ts";

/**
 * Per-step durations for the 7-step GTM demo. They sum to 38 s, the number in the SPEC footer
 * ("Recalled from Mark's demonstration · 7 steps · 38 s").
 */
export const GTM_STEP_MS = [3_000, 4_000, 6_000, 10_000, 6_000, 5_000, 4_000] as const;
export const SPEC_TOTAL_MS = 38_000;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

/** Spread SPEC_TOTAL_MS across any step count, so a freshly taught procedure also lands on 38 s. */
export function stepDurations(stepCount: number): number[] {
  if (stepCount === GTM_STEP_MS.length) return [...GTM_STEP_MS];
  if (stepCount <= 0) return [];
  const base = Math.floor(SPEC_TOTAL_MS / stepCount);
  const out = Array.from({ length: stepCount }, () => base);
  out[out.length - 1] = SPEC_TOTAL_MS - base * (stepCount - 1);
  return out;
}

/**
 * Deterministic stage-safe executor: ticks the steps on the SPEC timings and returns the fictional
 * drafts. Touches nothing outside this process. `speed` > 1 compresses time (used by tests and by
 * OTS_SCRIPTED_SPEED for rehearsals); the reported elapsed time stays the nominal one.
 */
export class ScriptedExecutor implements Executor {
  readonly name = "scripted" as const;

  constructor(
    private readonly sleep: Sleep = realSleep,
    private readonly speed = 1,
  ) {}

  async run(task: RunTask, onEvent: EventSink, signal?: AbortSignal): Promise<RunResult> {
    const durations = stepDurations(task.procedure.steps.length);
    let nominal = 0;
    for (const [i, ms] of durations.entries()) {
      await onEvent({ kind: "step", index: i, state: "running" });
      await this.sleep(ms / this.speed, signal);
      nominal += ms;
      await onEvent({ kind: "step", index: i, state: "done" });
    }
    // Only the GTM demo produces email drafts; other procedures finish with a short summary.
    const isGtm = task.procedure.name === "gtm";
    return {
      elapsedMs: nominal,
      drafts: isGtm ? demoDrafts(task.procedure.teacher) : [],
      ...(isGtm ? {} : { summary: `${task.procedure.steps.length} steps done.` }),
      executedBy: "scripted",
    };
  }
}

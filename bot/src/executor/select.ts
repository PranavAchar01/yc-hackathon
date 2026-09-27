import { log } from "../log.ts";
import type { EventSink, Executor, ExecutorName, RunResult, RunTask } from "./types.ts";

/** An executor that can say whether it is ready right now. */
export interface CheckedExecutor extends Executor {
  healthy(): Promise<boolean>;
}

/**
 * Stage safety: use the primary (bsk or qm) only when its health check is green and OTS_FORCE_SCRIPTED
 * is off; otherwise, or if it fails before finishing, run the scripted executor with the same card UI.
 * The fallback is silent on screen by design and only logged.
 */
export class ResilientExecutor implements Executor {
  constructor(
    private readonly primary: CheckedExecutor | null,
    private readonly fallback: Executor,
    private readonly forceScripted: () => boolean,
  ) {}

  get name(): ExecutorName {
    return this.primary?.name ?? this.fallback.name;
  }

  async run(task: RunTask, onEvent: EventSink, signal?: AbortSignal): Promise<RunResult> {
    if (!this.primary || this.forceScripted()) return this.fallback.run(task, onEvent, signal);
    if (!(await this.primary.healthy().catch(() => false))) {
      log.warn(`${this.primary.name} not ready; running scripted`);
      return this.fallback.run(task, onEvent, signal);
    }
    try {
      return await this.primary.run(task, onEvent, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      log.error(
        `${this.primary.name} failed mid-run, finishing with scripted:`,
        err instanceof Error ? err.message : err,
      );
      return this.fallback.run(task, onEvent, signal);
    }
  }
}

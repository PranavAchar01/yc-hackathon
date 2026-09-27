import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Token meter. Every LLM call reports the provider's own usage numbers into the meter of the run it belongs to
 * (AsyncLocalStorage, so concurrent runs never mix). Numbers are what the API billed, never estimates.
 */
export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (a subset of inputTokens). */
  cachedTokens: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

const store = new AsyncLocalStorage<Usage>();

/** Run fn with a fresh meter; returns fn's result and everything the LLM calls inside it used. */
export async function metered<T>(fn: () => Promise<T>): Promise<{ result: T; usage: Usage }> {
  const usage = emptyUsage();
  const result = await store.run(usage, fn);
  return { result, usage };
}

/** Called by the providers after each API response. Outside a metered scope it is a no-op. */
export function recordUsage(input: number, output: number, cached = 0): void {
  const u = store.getStore();
  if (!u) return;
  u.calls += 1;
  u.inputTokens += input;
  u.outputTokens += output;
  u.cachedTokens += cached;
}

export const totalTokens = (u: Usage): number => u.inputTokens + u.outputTokens;

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

/** 48213 -> "48.2k" */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

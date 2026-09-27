import { describe, expect, it } from "vitest";
import { GTM_STEP_MS, ScriptedExecutor, SPEC_TOTAL_MS, stepDurations } from "../src/executor/scripted.ts";
import type { ExecEvent } from "../src/executor/types.ts";
import type { Procedure } from "../src/procedure.ts";

const gtm: Procedure = {
  name: "gtm",
  title: "GTM launch emails",
  description: "d",
  teacher: "Mark Ellis",
  demonstrations: 1,
  steps: ["a", "b", "c", "d", "e", "f", "g"],
};

describe("stepDurations", () => {
  it("uses the SPEC timings for the 7-step demo and they sum to 38 s", () => {
    expect(stepDurations(7)).toEqual([...GTM_STEP_MS]);
    expect(GTM_STEP_MS.reduce((a, b) => a + b, 0)).toBe(SPEC_TOTAL_MS);
  });

  it("spreads 38 s over any other step count", () => {
    for (const n of [1, 3, 5, 9]) {
      const d = stepDurations(n);
      expect(d).toHaveLength(n);
      expect(d.reduce((a, b) => a + b, 0)).toBe(SPEC_TOTAL_MS);
    }
    expect(stepDurations(0)).toEqual([]);
  });
});

describe("ScriptedExecutor", () => {
  it("ticks every step running then done, in order, and returns 12 example.com drafts", async () => {
    const slept: number[] = [];
    const exec = new ScriptedExecutor(async (ms) => {
      slept.push(ms);
    });
    const events: ExecEvent[] = [];
    const result = await exec.run({ procedure: gtm, userId: "U1", threadRef: "C1:1", extra: "" }, (e) => {
      events.push(e);
    });

    expect(events).toHaveLength(14);
    events.forEach((e, i) => {
      expect(e).toEqual({ kind: "step", index: Math.floor(i / 2), state: i % 2 === 0 ? "running" : "done" });
    });
    expect(slept).toEqual([...GTM_STEP_MS]);
    expect(result.elapsedMs).toBe(38_000);
    expect(result.executedBy).toBe("scripted");
    expect(result.drafts).toHaveLength(12);
    expect(result.drafts.every((d) => d.to.endsWith("@example.com"))).toBe(true);
    expect(result.drafts[0]?.body.endsWith("Mark Ellis")).toBe(true);
  });

  it("compresses time with speed but reports nominal elapsed", async () => {
    const slept: number[] = [];
    const exec = new ScriptedExecutor(async (ms) => {
      slept.push(ms);
    }, 10);
    const result = await exec.run({ procedure: gtm, userId: "U1", threadRef: "t", extra: "" }, () => {});
    expect(slept[0]).toBe(300);
    expect(result.elapsedMs).toBe(38_000);
  });

  it("stops when aborted", async () => {
    const exec = new ScriptedExecutor();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      exec.run({ procedure: gtm, userId: "U1", threadRef: "t", extra: "" }, () => {}, ctrl.signal),
    ).rejects.toThrow("aborted");
  });
});

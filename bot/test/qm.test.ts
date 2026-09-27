import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStepReport, QmExecutor, signHeaders } from "../src/executor/qm.ts";
import { ScriptedExecutor } from "../src/executor/scripted.ts";
import { ResilientExecutor } from "../src/executor/select.ts";
import type { ExecEvent } from "../src/executor/types.ts";
import { MemorableClient, parseStatus } from "../src/memorable.ts";
import type { Procedure } from "../src/procedure.ts";

const proc: Procedure = {
  name: "gtm",
  title: "GTM launch emails",
  description: "d",
  teacher: "Mark Ellis",
  demonstrations: 1,
  steps: ["a", "b", "c"],
};

describe("QM source auth", () => {
  it("signs exactly like qm/src/auth/source-auth-sign.ts", () => {
    const h = signHeaders("s".repeat(32), "POST", "/v1/turns", '{"x":1}', 1_700_000_000);
    const expected = createHmac("sha256", "s".repeat(32))
      .update('v0:1700000000:POST\n/v1/turns\n{"x":1}')
      .digest("hex");
    expect(h).toEqual({ "x-timestamp": "1700000000", "x-signature": `v0=${expected}` });
  });
});

describe("parseStepReport", () => {
  it("reads the last fenced JSON block", () => {
    const reply =
      'Done.\n```json\n{"steps":[{"index":1,"status":"done"},{"index":2,"status":"failed","note":"no list"}]}\n```';
    expect(parseStepReport(reply)?.steps[1]).toEqual({ index: 2, status: "failed", note: "no list" });
  });
  it("returns null for prose", () => {
    expect(parseStepReport("all good")).toBeNull();
  });
});

describe("QmExecutor", () => {
  it("posts a TurnRequest to /v1/turns and maps the step report", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const reply =
        '```json\n{"steps":[{"index":1,"status":"done"},{"index":2,"status":"done"},{"index":3,"status":"done"}],"drafts":[{"to":"dana@example.com","toName":"Dana","company":"Contoso","subject":"Hi","body":"b","attachment":"a.pdf"},{"to":"x@real.com","toName":"X","company":"Y","subject":"s","body":"b","attachment":"a"}]}\n```';
      return new Response(JSON.stringify({ status: "ok", reply }), { status: 200 });
    }) as typeof fetch;
    const qm = new QmExecutor("http://qm.local", undefined, 1000, fakeFetch);
    const events: ExecEvent[] = [];
    const res = await qm.run({ procedure: proc, userId: "U1", threadRef: "C1:1", extra: "" }, (e) => {
      events.push(e);
    });
    expect(calls[0]?.url).toBe("http://qm.local/v1/turns");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      actor: { externalId: string };
      conversation: { kind: string };
    };
    expect(body.actor.externalId).toBe("U1");
    expect(body.conversation.kind).toBe("dm");
    expect(events.filter((e) => e.kind === "step" && e.state === "done")).toHaveLength(3);
    // non-example.com recipients are dropped
    expect(res.drafts.map((d) => d.to)).toEqual(["dana@example.com"]);
    expect(res.executedBy).toBe("qm");
  });

  it("falls back to scripted when QM is down", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const exec = new ResilientExecutor(
      new QmExecutor("http://qm.local", undefined, 1000, down),
      new ScriptedExecutor(async () => {}),
      () => false,
    );
    const res = await exec.run({ procedure: proc, userId: "U1", threadRef: "t", extra: "" }, () => {});
    expect(res.executedBy).toBe("scripted");
  });
});

describe("memorable", () => {
  const LOGGED_OUT =
    "backend        local (~/.memorable/procedures.jsonl)\n write consent  unset\n extraction api  not configured, run `memorable login`";
  it("parses status", () => {
    expect(parseStatus(LOGGED_OUT)).toEqual({ backend: "local", loggedIn: false, consent: false });
    expect(parseStatus("backend  gbrain\nwrite consent  granted\nextraction api  https://x")).toEqual({
      backend: "gbrain",
      loggedIn: true,
      consent: true,
    });
  });

  it("degrades without calling ingest when not logged in", async () => {
    const seen: string[][] = [];
    const client = new MemorableClient(["memorable"], async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: LOGGED_OUT, stderr: "" };
    });
    const out = await client.save(proc, "/tmp/x/SKILL.md", "personal");
    expect(out.saved).toBe(false);
    expect(out.detail).toMatch(/login/);
    expect(seen).toEqual([["memorable", "status"]]);
  });

  it("uses ingest on the local backend and record --scope on qm", async () => {
    const ok = "backend local\nwrite consent granted\nextraction api https://api";
    for (const [env, expected] of [
      [{}, ["memorable", "ingest", "-"]],
      [{ MEMORABLE_BACKEND: "qm" }, ["memorable", "record", "--scope", "personal", "-"]],
    ] as const) {
      const seen: { argv: string[]; stdin?: string }[] = [];
      const client = new MemorableClient(
        ["memorable"],
        async (argv, stdin) => {
          seen.push({ argv, stdin });
          return { code: 0, stdout: argv[1] === "status" ? ok : "stored", stderr: "" };
        },
        env,
      );
      expect((await client.save(proc, "/tmp/SKILL.md", "personal")).saved).toBe(true);
      expect(seen[1]?.argv).toEqual(expected);
      expect(JSON.parse(seen[1]?.stdin ?? "{}")).toBeTypeOf("object");
    }
  });
});

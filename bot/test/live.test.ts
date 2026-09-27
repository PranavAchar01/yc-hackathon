import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CARD_MIN_GAP_MS, LiveCard, retryAfterMs } from "../src/app.ts";
import type { Card } from "../src/blocks.ts";
import { FramePump, LIVE_RUN_ID, LiveRelay, newLiveRunId } from "../src/live.ts";

const card = (text: string, extra: Card["blocks"] = []): Card => ({
  text,
  blocks: [{ type: "section", text: { type: "mrkdwn", text } }, ...extra],
});

function fakeClient(fail?: (n: number, blocks: unknown[]) => unknown) {
  const sent: string[] = [];
  let n = 0;
  const client = {
    chat: {
      update: vi.fn(async (a: { text: string; blocks: unknown[] }) => {
        n++;
        const err = fail?.(n, a.blocks);
        if (err) throw err;
        sent.push(a.text);
      }),
    },
  };
  return { client, sent };
}

describe("LiveCard", () => {
  it("coalesces bursts: only the newest card is sent after the one in flight", async () => {
    const { client, sent } = fakeClient();
    // biome-ignore lint/suspicious/noExplicitAny: a minimal fake of the Slack WebClient
    const live = new LiveCard(client as any, "C1", "1.0", 5);
    const all = ["a", "b", "c", "d"].map((t) => live.update(card(t)));
    await Promise.all(all);
    expect(sent).toEqual(["a", "d"]);
  });

  it("pauses for Retry-After on a rate limit and then sends the card", async () => {
    const { client, sent } = fakeClient((n) =>
      n === 1
        ? Object.assign(new Error("rl"), { code: "slack_webapi_rate_limited_error", retryAfter: 0.01 })
        : null,
    );
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const live = new LiveCard(client as any, "C1", "1.0", 1);
    await live.update(card("x"));
    expect(sent).toEqual(["x"]);
    expect(client.chat.update).toHaveBeenCalledTimes(2);
  });

  it("drops a rejected video block, resends without it and says so", async () => {
    const { client, sent } = fakeClient((_n, blocks) =>
      JSON.stringify(blocks).includes('"video"') ? new Error("An API error occurred: invalid_blocks") : null,
    );
    // biome-ignore lint/suspicious/noExplicitAny: fake client
    const live = new LiveCard(client as any, "C1", "1.0", 1);
    const heard: Array<[string, boolean]> = [];
    live.onMediaRejected = (r, v) => heard.push([r, v]);
    await live.update(
      card("v", [
        {
          type: "video",
          video_url: "https://x/live?run=a",
          thumbnail_url: "https://x/f.jpg",
          title: { type: "plain_text", text: "t" },
          alt_text: "a",
        },
      ]),
    );
    expect(sent).toEqual(["v"]);
    expect(heard[0]?.[1]).toBe(true);
  });

  it("recognises Slack rate-limit errors", () => {
    expect(retryAfterMs({ code: "slack_webapi_rate_limited_error", retryAfter: 3 })).toBe(3_000);
    expect(retryAfterMs(new Error("other"))).toBeNull();
    expect(CARD_MIN_GAP_MS).toBeGreaterThanOrEqual(1_200);
  });
});

describe("live relay client", () => {
  it("run ids are long, random and URL safe", () => {
    const a = newLiveRunId();
    expect(a).toMatch(LIVE_RUN_ID);
    expect(a).not.toBe(newLiveRunId());
  });

  it("builds the player and frame URLs and posts frames with the secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ots-live-"));
    const png = join(dir, "shot.png");
    await writeFile(png, "png-bytes");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ seq: 7 }), { status: 200 });
    }) as unknown as typeof fetch;
    const runner = async (args: string[]) => {
      await writeFile(args.at(-1) ?? "", "jpeg-bytes");
      return { code: 0, stdout: "", stderr: "" };
    };
    const relay = new LiveRelay("https://site.example/", "s".repeat(24), runner, fetchImpl);
    expect(relay.playerUrl("abc")).toBe("https://site.example/live?run=abc");
    expect(relay.frameUrl("abc")).toBe("https://site.example/api/live/abc?frame=1");
    expect(await relay.pushFrame("abc", png, "Triaging issues")).toBe(7);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("https://site.example/api/live/abc");
    expect(headers.authorization).toBe(`Bearer ${"s".repeat(24)}`);
    await relay.finish("abc", { state: "done", replayUrl: "https://blob/x.mp4" });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      state: "done",
      replayUrl: "https://blob/x.mp4",
    });
  });

  it("frame pump keeps one push in flight and always sends the newest frame", async () => {
    const pushed: string[] = [];
    let release: () => void = () => undefined;
    let first = 0;
    const pump = new FramePump(
      (png) =>
        new Promise<number>((r) => {
          pushed.push(png);
          release = () => r(pushed.length);
        }),
      () => first++,
    );
    pump.offer("1");
    pump.offer("2");
    pump.offer("3");
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(pushed).toEqual(["1", "3"]);
    expect(first).toBe(1);
    expect(pump.seq).toBe(2);
  });
});

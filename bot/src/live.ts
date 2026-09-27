import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { log } from "./log.ts";
import type { CliRunner } from "./memorable.ts";

/**
 * Live video in Slack. While a browser run is going, the bot pushes the agent's latest screenshot (JPEG,
 * 1280 wide) to a relay on the site (`site/api/live/[run].js`, Postgres-backed: it keeps only the latest frame
 * per run and forgets runs after 30 minutes). The run card carries a Block Kit video block whose video_url is
 * the player page (`/live?run=<id>`), which polls the relay about 8 times a second.
 */

export interface LiveFinish {
  state: "done" | "failed";
  /** The finished run's replay mp4 (public Blob URL), shown by the player when the run ends. */
  replayUrl?: string;
}

/** 20 random bytes as base64url: run ids are unguessable, so a player link is the only way in. */
export function newLiveRunId(): string {
  return randomBytes(20).toString("base64url");
}

export const LIVE_RUN_ID = /^[A-Za-z0-9_-]{16,64}$/;

export class LiveRelay {
  private readonly base: string;

  constructor(
    base: string,
    private readonly secret: string,
    private readonly runner: CliRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  playerUrl(runId: string): string {
    return `${this.base}/live?run=${encodeURIComponent(runId)}`;
  }

  /** Latest frame as a JPEG (a stable URL; the relay serves it uncached). */
  frameUrl(runId: string): string {
    return `${this.base}/api/live/${encodeURIComponent(runId)}?frame=1`;
  }

  private endpoint(runId: string): string {
    return `${this.base}/api/live/${encodeURIComponent(runId)}`;
  }

  /** PNG screenshot to a ~1280 wide JPEG at quality 70 (sips on macOS; the PNG as is elsewhere). */
  async toJpeg(png: string): Promise<{ body: Buffer; type: string }> {
    if (process.platform !== "darwin") return { body: await readFile(png), type: "image/png" };
    const out = `${png}.live.jpg`;
    const r = await this.runner([
      "sips",
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "70",
      "-Z",
      "1280",
      png,
      "--out",
      out,
    ]);
    if (r.code !== 0) return { body: await readFile(png), type: "image/png" };
    try {
      return { body: await readFile(out), type: "image/jpeg" };
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  }

  /** Store one frame as the run's latest. Returns the relay's sequence number. */
  async pushFrame(runId: string, png: string, title: string): Promise<number> {
    const { body, type } = await this.toJpeg(png);
    const res = await this.fetchImpl(this.endpoint(runId), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secret}`,
        "content-type": type,
        "x-title": encodeURIComponent(title.slice(0, 120)),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const j = (await res.json()) as { seq?: number };
    return j.seq ?? 0;
  }

  /** Mark the run finished so the player swaps to the replay. Best effort. */
  async finish(runId: string, f: LiveFinish): Promise<void> {
    const res = await this.fetchImpl(this.endpoint(runId), {
      method: "POST",
      headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      body: JSON.stringify(f),
      signal: AbortSignal.timeout(5_000),
    }).catch((err: unknown) => {
      log.warn("live relay finish failed", err instanceof Error ? err.message : err);
      return null;
    });
    if (res && !res.ok) log.warn(`live relay finish: ${res.status}`);
  }
}

/**
 * Keeps at most one push in flight and always sends the newest frame: frames that arrive while a push is
 * going replace each other, so a slow network lowers the frame rate instead of building a queue.
 */
export class FramePump {
  private busy = false;
  private next: string | null = null;
  seq = 0;

  constructor(
    private readonly push: (png: string) => Promise<number>,
    private readonly onFirst: () => void,
  ) {}

  offer(png: string): void {
    this.next = png;
    if (!this.busy) void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    while (this.next) {
      const png = this.next;
      this.next = null;
      try {
        const seq = await this.push(png);
        const first = this.seq === 0;
        this.seq = seq || this.seq + 1;
        if (first) this.onFirst();
      } catch (err) {
        log.warn("live frame push failed", err instanceof Error ? err.message : err);
      }
    }
    this.busy = false;
  }
}

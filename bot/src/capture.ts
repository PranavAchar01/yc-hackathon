import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./log.ts";

const run = promisify(execFile);

export const FRAME_INTERVAL_MS = 1500;
/** Long edge in pixels for frames sent to the model; keeps 16 frames well under the request limit. */
const MODEL_FRAME_EDGE = 1568;
/** Stop by itself after this long, so a forgotten recording does not fill the disk. */
const MAX_RECORDING_MS = 10 * 60_000;

/**
 * Records the local Mac screen with `screencapture -x` (silent) every ~1.5 s into a temp dir.
 * Needs the Screen Recording permission for the terminal that runs the bot; without it macOS
 * returns only the wallpaper, which the extractor will then describe as nothing useful.
 */
export class ScreenRecorder {
  private dir: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cap: NodeJS.Timeout | null = null;
  private readonly frames: string[] = [];
  private busy = false;
  private seq = 0;

  constructor(private readonly intervalMs = FRAME_INTERVAL_MS) {}

  get frameCount(): number {
    return this.frames.length;
  }

  async start(): Promise<void> {
    if (process.platform !== "darwin") throw new Error("screen capture needs macOS (screencapture)");
    this.dir = await mkdtemp(join(tmpdir(), "ots-frames-"));
    await this.grab();
    this.timer = setInterval(() => void this.grab(), this.intervalMs);
    this.cap = setTimeout(() => void this.stop(), MAX_RECORDING_MS);
  }

  private async grab(): Promise<void> {
    if (!this.dir || this.busy) return;
    this.busy = true;
    const path = join(this.dir, `frame-${String(this.seq++).padStart(4, "0")}.jpg`);
    try {
      await run("screencapture", ["-x", "-t", "jpg", path]);
      this.frames.push(path);
    } catch (err) {
      log.warn("screencapture failed", err instanceof Error ? err.message : err);
    } finally {
      this.busy = false;
    }
  }

  /** Stops recording and returns the captured frame paths in order. */
  async stop(): Promise<string[]> {
    if (this.timer) clearInterval(this.timer);
    if (this.cap) clearTimeout(this.cap);
    this.timer = null;
    this.cap = null;
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    return [...this.frames];
  }

  /** Downscale in place with macOS `sips` before upload. */
  static async shrink(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map((p) => run("sips", ["-Z", String(MODEL_FRAME_EDGE), "-s", "formatOptions", "70", p])),
    );
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = null;
  }
}

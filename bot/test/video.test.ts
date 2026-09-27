import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { concatList, listFrames, secondsPerFrame } from "../src/video.ts";

describe("run videos", () => {
  it("keeps only frames, oldest first, across drafting and Gmail frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ots-video-"));
    for (const n of [
      "shot-2000-g0001.png",
      "shot-1000-0001.png",
      "frames.txt",
      "shot-1500-0002.png",
      "run.mp4",
    ])
      await writeFile(join(dir, n), "x");
    const frames = (await listFrames(dir)).map((f) => f.split("/").pop());
    expect(frames).toEqual(["shot-1000-0001.png", "shot-1500-0002.png", "shot-2000-g0001.png"]);
  });

  it("writes a concat list that holds the last frame", () => {
    const list = concatList(["/a/1.png", "/a/it's.png"], 0.2);
    expect(list).toContain("file '/a/1.png'\nduration 0.2");
    expect(list).toContain("file '/a/it'\\''s.png'");
    expect(list.trim().split("\n").at(-1)).toBe("file '/a/it'\\''s.png'");
  });

  it("paces clips to roughly 6-12 seconds (the card waits for one play before it flips to Done)", () => {
    for (const n of [10, 60, 150, 400]) {
      const total = n * secondsPerFrame(n);
      expect(total).toBeGreaterThanOrEqual(1);
      expect(total).toBeLessThanOrEqual(12.5);
    }
    expect(150 * secondsPerFrame(150)).toBeGreaterThanOrEqual(6);
  });
});

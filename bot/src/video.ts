import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { put } from "@vercel/blob";
import { log } from "./log.ts";
import type { CliRunner } from "./memorable.ts";

/**
 * Every real browser run becomes its own demo clip: the run's screenshots (about one a second) are cut into a
 * short, silent timelapse, uploaded to Vercel Blob, and set as the command's library video.
 */

/** Frame names sort in time order (shot-<ms>-<n>.png); keep only real frames, oldest first. */
export async function listFrames(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => /^shot-.*\.png$/.test(n)).sort();
  return names.map((n) => join(dir, n));
}

/** ffmpeg concat list: every frame holds for the same slice of time. */
export function concatList(frames: string[], secondsPerFrame: number): string {
  const lines = frames.flatMap((f) => [`file '${f.replace(/'/g, "'\\''")}'`, `duration ${secondsPerFrame}`]);
  // The concat demuxer ignores the last duration unless the final file is repeated.
  if (frames.length) lines.push(`file '${(frames.at(-1) ?? "").replace(/'/g, "'\\''")}'`);
  return `${lines.join("\n")}\n`;
}

/** Aim for a 6-12 s clip whatever the run length: long runs play faster. The run card waits for one play of
 * it before it flips to Done, so it stays short. */
export function replaySeconds(frameCount: number): number {
  return Math.min(12, Math.max(6, frameCount * 0.08));
}

export function secondsPerFrame(frameCount: number): number {
  const target = replaySeconds(frameCount);
  return Math.max(1 / 48, Math.min(0.5, target / Math.max(1, frameCount)));
}

export interface BuiltVideo {
  mp4: string;
  poster: string;
  frames: number;
}

export async function buildVideo(
  dir: string,
  runner: CliRunner,
  ffmpeg = "ffmpeg",
): Promise<BuiltVideo | null> {
  const frames = await listFrames(dir);
  if (frames.length < 3) return null;
  const list = join(dir, "frames.txt");
  await writeFile(list, concatList(frames, secondsPerFrame(frames.length)), "utf8");
  const mp4 = join(dir, "run.mp4");
  const poster = join(dir, "poster.jpg");
  // Low priority: never compete with long renders on this machine.
  const v = await runner([
    "nice",
    "-n",
    "19",
    ffmpeg,
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-vf",
    "scale=1280:-2:flags=lanczos,fps=24,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-movflags",
    "+faststart",
    "-an",
    mp4,
  ]);
  if (v.code !== 0) {
    log.warn(`video: ffmpeg failed: ${v.stderr.trim().split("\n").slice(-2).join(" ")}`);
    return null;
  }
  // Poster: the last frame, the finished result (it is also where the live stream left off).
  const pick = frames[frames.length - 1] ?? "";
  const p = await runner([
    "nice",
    "-n",
    "19",
    ffmpeg,
    "-y",
    "-i",
    pick,
    "-vf",
    "scale=1280:-2",
    "-q:v",
    "4",
    poster,
  ]);
  if (p.code !== 0) return null;
  return { mp4, poster, frames: frames.length };
}

export interface UploadedVideo {
  videoUrl: string;
  posterUrl: string;
}

export async function uploadVideo(built: BuiltVideo, name: string, token: string): Promise<UploadedVideo> {
  const stamp = Date.now();
  const [video, poster] = await Promise.all([
    put(`runs/${name}/${stamp}.mp4`, await readFile(built.mp4), {
      access: "public",
      contentType: "video/mp4",
      token,
    }),
    put(`runs/${name}/${stamp}.jpg`, await readFile(built.poster), {
      access: "public",
      contentType: "image/jpeg",
      token,
    }),
  ]);
  return { videoUrl: video.url, posterUrl: poster.url };
}

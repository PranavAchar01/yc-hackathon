/**
 * Run the /learn pipeline on one video without Slack, and print what it learned plus the wall time.
 * usage: source scripts/secrets.sh && nice -n 19 tsx scripts/learn-offline.ts <video url> [model]
 * The model defaults to OTS_LEARN_MODEL, then gpt-5.4-mini.
 */
import { rm } from "node:fs/promises";
import { parseVideoUrl, VideoLearner } from "../src/learn.ts";
import { OpenAIProvider } from "../src/llm.ts";
import { defaultRunner } from "../src/memorable.ts";

const [raw = "", modelArg] = process.argv.slice(2);
const check = parseVideoUrl(raw);
if (!check.ok) throw new Error(check.reason);
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY missing: source scripts/secrets.sh first");
const model = modelArg ?? process.env.OTS_LEARN_MODEL ?? "gpt-5.4-mini";

const learner = new VideoLearner(new OpenAIProvider(key, model), defaultRunner(process.env, 15 * 60_000), {
  ytdlp: process.env.YTDLP_BIN ?? "yt-dlp",
  ffmpeg: process.env.FFMPEG_BIN ?? "ffmpeg",
  ffprobe: process.env.FFPROBE_BIN ?? "ffprobe",
});

const t0 = Date.now();
const marks: string[] = [];
const out = await learner.learn(check.url, (p) => {
  marks.push(
    `${p.phase} +${((Date.now() - t0) / 1000).toFixed(1)}s${p.frames ? ` (${p.frames.length} frames)` : ""}`,
  );
});
const wall = (Date.now() - t0) / 1000;
await rm(out.dir, { recursive: true, force: true });
process.stdout.write(
  `${JSON.stringify({ model, wallSeconds: Math.round(wall * 10) / 10, phases: marks, ...out.learned }, null, 2)}\n`,
);

// Lays the film's sound effects under a rendered film: reads window.SFX (name + time, from the deck's own take
// marks) and mixes film/sfx/<name>.wav at each time. Video is copied untouched.
// usage: tsx film/tools/sfx-mix.mts <deck-url> <in.mp4> <out.mp4>
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const [deck, input, out] = process.argv.slice(2);
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const VOL: Record<string, number> = { type: 0.45, click: 0.65, whoosh: 0.32, swoosh: 0.22, chime: 0.55, pop: 0.5, tab: 0.45 };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--mute-audio"], defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
await page.goto(deck, { waitUntil: "load", timeout: 120_000 });
await page.waitForFunction("window.deckReady === true", { timeout: 180_000, polling: 250 });
const events = (await page.evaluate(() => (window as unknown as { SFX: { name: string; t: number }[] }).SFX)).filter((e) => e.name in VOL);
await browser.close();
console.log(events.length, "sound cues");

const args = ["-v", "error", "-y", "-i", input];
for (const e of events) args.push("-i", `${import.meta.dirname}/../sfx/${e.name}.wav`);
const parts = events.map((e, i) => {
  const ms = Math.max(0, Math.round(e.t * 1000));
  return `[${i + 1}:a]adelay=${ms}|${ms},volume=${VOL[e.name]}[a${i}]`;
});
const mix = `${events.map((_, i) => `[a${i}]`).join("")}amix=inputs=${events.length}:normalize=0:dropout_transition=0,alimiter=limit=0.8,apad[aout]`;
args.push("-filter_complex", [...parts, mix].join(";"), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out);
const r = spawnSync("nice", ["-n", "19", "ffmpeg", ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);

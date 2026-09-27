// Renders film/deck/v4.html frame by frame on a virtual clock: for every output frame k the page is laid out for
// t = k / FPS (window.seek, which also seeks every visible video to its exact frame) and screenshotted. No wall
// clock is involved anywhere, so the film has one real, different frame every 1/FPS s, however slow the machine is.
// Frames are piped straight into ffmpeg (H.264, CRF 14, no audio).
// usage: tsx film/tools/render-v4.mts <out.mp4> <deck-url> [--from s] [--to s] [--stills s,s,...] [--fps 30]
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import puppeteer from "puppeteer-core";

const out = process.argv[2];
const deck = process.argv[3] ?? "http://localhost:4650/deck/v4.html";
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const FPS = Number(arg("fps") ?? 30);
const stills = arg("stills")?.split(",").map(Number);
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

await mkdir(dirname(out), { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--force-device-scale-factor=1", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
page.on("console", (m) => { if (/error/i.test(m.text())) console.log("console", m.text().slice(0, 200)); });
await page.goto(deck, { waitUntil: "load", timeout: 120_000 });
await page.waitForFunction("window.deckReady === true", { timeout: 180_000, polling: 250 });
const total = await page.evaluate(() => (window as unknown as { DURATION: number }).DURATION);
const plan = await page.evaluate(() => (window as unknown as { PLAN: unknown }).PLAN);
console.log("duration", total.toFixed(2), "s", JSON.stringify(plan));
const seek = (t: number) => page.evaluate((x) => (window as unknown as { seek: (t: number) => Promise<void> }).seek(x), t);

if (stills) {
  for (const t of stills) {
    await seek(t);
    await page.screenshot({ path: out.replace(/\.(mp4|png)$/, "") + `-${t.toFixed(2)}.png`, type: "png" });
  }
  await browser.close();
  process.exit(0);
}

const from = Number(arg("from") ?? 0), to = Math.min(Number(arg("to") ?? total), total);
const n0 = Math.round(from * FPS), n1 = Math.round(to * FPS);
const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
const started = Date.now();
for (let k = n0; k < n1; k++) {
  await seek(k / FPS);
  const png = await page.screenshot({ type: "png", optimizeForSpeed: true });
  if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
  if ((k - n0) % 150 === 0) console.log(`frame ${k - n0}/${n1 - n0}  t=${(k / FPS).toFixed(1)}s  ${((Date.now() - started) / 1000).toFixed(0)}s elapsed`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log("wrote", out, n1 - n0, "frames", ((Date.now() - started) / 1000).toFixed(0), "s");

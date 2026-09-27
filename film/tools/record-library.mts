// Records the live library page (real deployed site) in headless Chrome at 1920x1080, 30 fps, with a scripted
// Mac-like tour: land, hover a real run video, scroll, open Quick Look, close. Works with the screen locked.
// usage: tsx film/tools/record-library.mts <out.webm>
import puppeteer from "puppeteer-core";

const out = process.argv[2] ?? "raw/library.webm";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--force-device-scale-factor=1", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await page.goto("https://over-the-shoulder-brown.vercel.app/library", { waitUntil: "networkidle0", timeout: 60_000 });
await page.waitForSelector(".card", { timeout: 30_000 });
await wait(1500);

// Smooth cursor moves: many small mouse steps.
const moveTo = async (sel: string, ms = 900) => {
  const box = await (await page.$(sel))?.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35, { steps: Math.round(ms / 16) });
};

const rec = await page.screencast({ path: out as `${string}.webm`, fps: 30 } as Parameters<typeof page.screencast>[0]);
await wait(1800);
await moveTo('.card[aria-label^="Triage"]');
await wait(4200);                                   // the real /triage run plays on hover
await moveTo('.card[aria-label^="GTM"]', 700);
await wait(2600);
for (let i = 0; i < 24; i++) { await page.mouse.wheel({ deltaY: 22 }); await wait(16); }
await wait(1200);
for (let i = 0; i < 24; i++) { await page.mouse.wheel({ deltaY: -22 }); await wait(16); }
await wait(700);
await moveTo('.card[aria-label^="Triage"]', 600);
await page.click('.card[aria-label^="Triage"]');
await wait(6500);                                   // Quick Look plays the run
await page.keyboard.press("Escape");
await wait(1500);
await page.type("#q", "label new issues", { delay: 70 });
await wait(2500);
await rec.stop();
await browser.close();
console.log("wrote", out);

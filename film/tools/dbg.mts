import puppeteer from "puppeteer-core";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const p = await b.newPage();
await p.goto("http://127.0.0.1:4652/deck/film.html", { waitUntil: "load" });
await p.waitForFunction("window.deckReady === true", { timeout: 120000 });
console.log(await p.evaluate(async () => { try { await (window as any).seek(46); return "ok"; } catch (e) { return String(e) + " " + (e as Error).stack; } }));
console.log(await p.evaluate(() => { const e = document.getElementById("s-triage") as any; return JSON.stringify({ n: document.querySelectorAll("#s-triage").length, run: !!e._run, op: e.style.opacity, vids: document.querySelectorAll("video").length }); }));
console.log(await p.evaluate(async () => { const v = document.querySelector("#s-triage video") as HTMLVideoElement; const before = v.currentTime; await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = 8.2; setTimeout(r, 5000); }); return JSON.stringify({ before, after: v.currentTime, seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : null, buffered: v.buffered.length }); }));
const info = await p.evaluate(() => {
  const v = document.querySelector("#s-triage video") as HTMLVideoElement;
  const c = document.createElement("canvas"); c.width = 160; c.height = 90;
  const ctx = c.getContext("2d")!; ctx.drawImage(v, 0, 0, 160, 90);
  const d = ctx.getImageData(0, 0, 160, 90).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return { t: v.currentTime, dur: v.duration, rs: v.readyState, w: v.videoWidth, err: v.error?.code, mean: sum / (d.length / 4) / 3, src: v.currentSrc };
});
console.log(JSON.stringify(info));
await b.close();

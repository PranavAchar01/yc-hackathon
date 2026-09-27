// Library tiles without a run video get a real screenshot of the site the command works on (GitHub, Vercel,
// Slack, Gmail). One BrowserSkill session in the signed-in Chrome visits each page, screenshots the viewport,
// and the JPEG goes to Vercel Blob as the command's poster_url, with site_name for the tile's badge.
// Gmail pages are searches for the demo's own test sends only (never the inbox), cropped past the label list.
// usage: pnpm tsx scripts/shots.ts [name ...]   (secrets from scripts/secrets.sh; OTS_DATABASE_URL, BLOB_READ_WRITE_TOKEN)
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { put } from "@vercel/blob";
import pg from "pg";
import { log } from "../src/log.ts";

const run = promisify(execFile);
const REPO = "https://github.com/PranavAchar01/over-the-shoulder";
const SLACK = "https://app.slack.com/client/T0C4YS898AU";
const GMAIL = "https://mail.google.com/mail/u/0/#search/";
const sent = (who: string) => `${GMAIL}${encodeURIComponent(`in:sent to:achar.pranav+${who}@gmail.com`)}`;
const VERCEL = "https://vercel.com/phantom3452s-projects/over-the-shoulder";

type Site = "GitHub" | "Vercel" | "Slack" | "Gmail";
const PLAN: Record<string, [Site, string]> = {
  "api-docs-sync": ["GitHub", `${REPO}/tree/main/bot/src`],
  "bug-triage": ["GitHub", `${REPO}/issues?q=is%3Aissue+label%3Abug`],
  changelog: ["GitHub", `${REPO}/commits/main`],
  "code-review": ["GitHub", `${REPO}/pulls?q=is%3Apr`],
  "deploy-check": ["GitHub", `${REPO}/actions`],
  "incident-postmortem": ["GitHub", `${REPO}/issues?q=is%3Aissue+label%3AP1`],
  "tech-debt-log": ["GitHub", `${REPO}/issues?q=is%3Aissue+label%3Aperf`],
  "style-audit": ["GitHub", `${REPO}/blob/main/README.md`],
  "design-review": ["GitHub", `${REPO}/pull/13`],
  "user-test": ["GitHub", `${REPO}/issues/3`],
  "oncall-handoff": ["GitHub", `${REPO}/issues`],
  "sla-check": ["Vercel", VERCEL],
  gtm: ["Gmail", sent("dana")],
  "churn-save": ["Gmail", sent("ravi")],
  "customer-recap": ["Gmail", sent("mei")],
  "demo-request": ["Gmail", sent("dana")],
  "lead-routing": ["Gmail", sent("mei")],
  "outreach-list": [
    "Gmail",
    `${GMAIL}${encodeURIComponent("in:sent {to:achar.pranav+dana@gmail.com to:achar.pranav+ravi@gmail.com to:achar.pranav+mei@gmail.com}")}`,
  ],
  renewals: ["Gmail", sent("ravi")],
  "referral-bonus": ["Gmail", sent("dana")],
  "case-study": ["Gmail", sent("mei")],
  "webinar-recap": ["Gmail", sent("ravi")],
  "pricing-quote": ["Gmail", sent("dana")],
  "sales-deck": ["Gmail", sent("mei")],
  "board-update": ["Gmail", sent("ravi")],
  "culture-pulse": ["Slack", `${SLACK}/C0C3YJ5CB7V`],
  "team-survey": ["Slack", `${SLACK}/C0C3YJH4JV9`],
  "pto-tracker": ["Slack", `${SLACK}/C0C3YHQ4Q1Z`],
  onboard: ["Slack", `${SLACK}/C0C3ZQ4CE1K`],
  offboard: ["Slack", `${SLACK}/C0C3YJH4JV9`],
  "interview-loop": ["Slack", `${SLACK}/C0C3YHQ4Q1Z`],
  "facilities-ticket": ["Slack", `${SLACK}/C0C3YJH4JV9`],
  escalation: ["Slack", `${SLACK}/C0C3YJ5CB7V`],
  "feedback-digest": ["Slack", `${SLACK}/C0C3ZQ4CE1K`],
  "ticket-triage": ["Slack", `${SLACK}/C0C3YJ5CB7V`],
  "competitor-scan": ["Slack", `${SLACK}/C0C3ZQ4CE1K`],
  "supply-order": ["Slack", `${SLACK}/C0C3YJH4JV9`],
  "expense-audit": ["Slack", `${SLACK}/C0C3YJH4JV9`],
  expense: ["Slack", `${SLACK}/C0C3YJH4JV9`],
  "payroll-check": ["Slack", `${SLACK}/C0C3YJH4JV9`],
  "budget-review": ["Slack", `${SLACK}/C0C3YJ5CB7V`],
  invoice: ["Gmail", sent("ravi")],
  "tax-doc": ["Gmail", sent("mei")],
  "travel-request": ["Slack", `${SLACK}/C0C3YJH4JV9`],
  "vendor-check": ["Gmail", sent("dana")],
  "brand-assets": ["Gmail", sent("mei")],
  "asset-request": ["Slack", `${SLACK}/C0C3ZQ4CE1K`],
  "benefits-faq": ["Slack", `${SLACK}/C0C3YJH4JV9`],
};

async function bsk(...args: string[]): Promise<string> {
  const { stdout } = await run("bsk", args, { timeout: 60_000 });
  return stdout.trim();
}

const only = process.argv.slice(2);
const names = Object.keys(PLAN).filter((n) => only.length === 0 || only.includes(n));
const db = new pg.Client({ connectionString: process.env.OTS_DATABASE_URL });
await db.connect();
const dir = await mkdtemp(join(tmpdir(), "ots-shots-"));
const session = (
  await bsk("session", "start", "--name", "Library screenshots", "--width", "1440", "--height", "900")
)
  .split("\n")
  .at(-1) as string;
try {
  for (const name of names) {
    const [site, url] = PLAN[name] as [Site, string];
    // Slack's client can hold the load event open; the page is usable anyway, so a slow navigate is not fatal.
    await bsk("navigate", url, "--session", session).catch(() => "");
    await new Promise((r) => setTimeout(r, site === "Slack" || site === "Gmail" ? 6000 : 3500));
    const png = join(dir, `${name}.png`);
    await bsk("screenshot", "--session", session, "--out", png);
    // Gmail: crop past the label list on the left; everything else is the page as is.
    const jpg = join(dir, `${name}.jpg`);
    const crop = site === "Gmail" ? "crop=iw*0.8:ih:iw*0.2:0," : "";
    await run("nice", [
      "-n",
      "19",
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-i",
      png,
      "-vf",
      `${crop}scale=1280:-2:flags=lanczos`,
      "-q:v",
      "4",
      jpg,
    ]);
    const blob = await put(`shots/${name}.jpg`, await readFile(jpg), {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    const r = await db.query(
      "UPDATE commands SET poster_url = $2, site_name = $3 WHERE name = $1 AND video_url IS NULL",
      [name, blob.url, site],
    );
    log.info(`${name}: ${site} ${r.rowCount ? "set" : "skipped (has a run video)"}`);
  }
} finally {
  await bsk("session", "stop", session).catch(() => "");
  await db.end();
}

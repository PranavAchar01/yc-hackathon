import type { IncomingMessage, ServerResponse } from "node:http";
import { demoDrafts, type EmailDraft, LAUNCH_VIDEO_URL } from "./demo-data.ts";

/**
 * Local fake pages the Cua agent works in, so the demo task has zero network dependencies:
 * an inbox with Priya's forwarded deliverables, the contacts sheet, the one-pagers and a compose
 * form whose "Queue for review" button stores drafts in memory. Nothing here can send email.
 * Served by the bot's HTTP server under /mock/ (the sandbox reaches it via host.docker.internal).
 */

export class Outbox {
  private readonly drafts: Array<EmailDraft & { at: number }> = [];

  add(d: EmailDraft): void {
    this.drafts.push({ ...d, at: Date.now() });
  }

  since(t: number): EmailDraft[] {
    return this.drafts.filter((d) => d.at >= t).map(({ at: _at, ...d }) => d);
  }

  clear(): void {
    this.drafts.length = 0;
  }
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Northwind Mail</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--mute:#6e6e73;--line:#e5e5ea;--accent:#0071e3}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;gap:20px;align-items:center;padding:14px 24px;background:var(--card);border-bottom:1px solid var(--line)}
header b{font-size:17px}header a{color:var(--mute);text-decoration:none}header a:hover{color:var(--ink)}
main{max-width:920px;margin:24px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 24px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 4px}.mute{color:var(--mute)}a{color:var(--accent)}table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{color:var(--mute);font-weight:500}
label{display:block;margin:12px 0 4px;color:var(--mute)}input,select,textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font:inherit}
textarea{min-height:170px}button{margin-top:16px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;cursor:pointer}
.row{display:flex;justify-content:space-between;gap:12px}.pill{display:inline-block;padding:2px 10px;border-radius:99px;background:#eef4ff;color:var(--accent);font-size:13px}
</style></head><body><header><b>Northwind Mail</b><a href="/mock/">Inbox</a><a href="/mock/sheet">Launch list</a><a href="/mock/compose">Compose</a><a href="/mock/outbox">Review queue</a></header>
<main>${body}</main></body></html>`;
}

const CONTACTS = demoDrafts().map((d) => ({
  name: d.toName,
  email: d.to,
  company: d.company,
  onePager: d.attachment,
}));
const ONE_PAGERS = [...new Set(CONTACTS.map((c) => c.onePager))];

function inbox(): string {
  return page(
    "Inbox",
    `<h1>Inbox</h1><p class="mute">Mark Ellis</p>
<div class="card"><div class="row"><b><a href="/mock/mail/launch">Priya Shah</a></b><span class="mute">9:41 AM</span></div>
<div>Fwd: Launch deliverables</div><div class="mute">Hey Mark, all the deliverables are in place. Just forwarded them to you. Can you send out the GTM emails?</div></div>`,
  );
}

function mail(): string {
  const pagers = ONE_PAGERS.map(
    (p) => `<li><a href="/mock/files/${encodeURIComponent(p)}">${esc(p)}</a></li>`,
  ).join("");
  return page(
    "Fwd: Launch deliverables",
    `<div class="card"><h1>Fwd: Launch deliverables</h1><p class="mute">From Priya Shah &lt;priya@example.com&gt; to Mark Ellis</p>
<p>Hey Mark, all the deliverables are in place. Just forwarded them to you. Can you send out the GTM emails?</p>
<p><b>Launch list:</b> <a href="/mock/sheet">Launch contacts (12)</a></p>
<p><b>One-pagers:</b></p><ul>${pagers}</ul>
<p><b>Launch video:</b> <a href="${LAUNCH_VIDEO_URL}">${LAUNCH_VIDEO_URL}</a></p></div>`,
  );
}

function sheet(): string {
  const rows = CONTACTS.map(
    (c) =>
      `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.company)}</td><td>${esc(c.onePager)}</td></tr>`,
  ).join("");
  return page(
    "Launch list",
    `<div class="card"><h1>Launch contacts</h1><p class="mute">12 contacts · one-pager by segment</p>
<table><tr><th>Name</th><th>Email</th><th>Company</th><th>One-pager</th></tr>${rows}</table></div>`,
  );
}

function compose(queued: number): string {
  const options = ONE_PAGERS.map((p) => `<option>${esc(p)}</option>`).join("");
  return page(
    "Compose",
    `<div class="card"><div class="row"><h1>New draft</h1><span class="pill">${queued} queued for review</span></div>
<form method="post" action="/mock/queue">
<label for="to">To</label><input id="to" name="to" placeholder="name@example.com">
<label for="toName">Name</label><input id="toName" name="toName">
<label for="company">Company</label><input id="company" name="company">
<label for="subject">Subject</label><input id="subject" name="subject">
<label for="attachment">Attachment</label><select id="attachment" name="attachment">${options}</select>
<label for="body">Message</label><textarea id="body" name="body"></textarea>
<button type="submit">Queue for review</button></form>
<p class="mute">Drafts go to the review queue. Nothing is sent from here.</p></div>`,
  );
}

function outboxPage(drafts: EmailDraft[]): string {
  const rows = drafts
    .map(
      (d) =>
        `<tr><td>${esc(d.toName)}</td><td>${esc(d.to)}</td><td>${esc(d.subject)}</td><td>${esc(d.attachment)}</td></tr>`,
    )
    .join("");
  return page(
    "Review queue",
    `<div class="card"><h1>Review queue</h1><p class="mute">${drafts.length} drafts waiting for a human</p>
<table><tr><th>Name</th><th>Email</th><th>Subject</th><th>Attachment</th></tr>${rows}</table></div>`,
  );
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) break;
  }
  return new URLSearchParams(raw);
}

/** Handle /mock/* routes. Returns false when the path is not ours. */
export async function handleMock(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  outbox: Outbox,
): Promise<boolean> {
  if (!url.pathname.startsWith("/mock")) return false;
  const html = (body: string, status = 200) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };
  const p = url.pathname.replace(/\/+$/, "") || "/mock";
  if (req.method === "POST" && p === "/mock/queue") {
    const f = await readForm(req);
    const to = (f.get("to") ?? "").trim().toLowerCase();
    // Hard rule: only @example.com recipients can even be queued.
    if (to.endsWith("@example.com")) {
      outbox.add({
        to,
        toName: f.get("toName") ?? "",
        company: f.get("company") ?? "",
        subject: f.get("subject") ?? "",
        body: f.get("body") ?? "",
        attachment: f.get("attachment") ?? "",
      });
    }
    res.writeHead(303, { location: "/mock/compose" });
    res.end();
    return true;
  }
  if (req.method !== "GET") return false;
  if (p === "/mock") html(inbox());
  else if (p === "/mock/mail/launch") html(mail());
  else if (p === "/mock/sheet") html(sheet());
  else if (p === "/mock/compose") html(compose(outbox.since(0).length));
  else if (p === "/mock/outbox") html(outboxPage(outbox.since(0)));
  else if (p.startsWith("/mock/files/"))
    html(
      page(
        "One-pager",
        `<div class="card"><h1>${esc(decodeURIComponent(p.slice(12)))}</h1><p>Northwind launch one-pager.</p></div>`,
      ),
    );
  else html(page("Not found", "<p>Not found</p>"), 404);
  return true;
}

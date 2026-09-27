import type { EmailDraft } from "./demo-data.ts";
import { log } from "./log.ts";
import type { CliRunner } from "./memorable.ts";

/**
 * Real sends for the demo, through Gmail in the user's own Chrome (BrowserSkill).
 *
 * Safety model: the model never types a recipient. Code rewrites every draft to a Gmail plus-address of ONE
 * configured test inbox (achar.pranav+dana@gmail.com for dana@example.com), opens Gmail's compose URL with
 * to/subject/body already filled, and clicks Send. Anything that is not such a plus-address is refused.
 */

export interface TestInbox {
  local: string;
  domain: string;
}

export function parseTestInbox(address: string): TestInbox {
  const m = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(address.trim());
  if (!m?.[1] || !m[2]) throw new Error(`OTS_TEST_INBOX is not a plain email address: ${address}`);
  return { local: m[1].toLowerCase(), domain: m[2].toLowerCase() };
}

/** dana@example.com -> local+dana@domain. The tag is lowercase letters, digits and dashes only. */
export function testAddressFor(draftTo: string, inbox: TestInbox): string {
  const tag =
    (draftTo.split("@")[0] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "contact";
  return `${inbox.local}+${tag}@${inbox.domain}`;
}

/** The only recipients a real send may ever go to. */
export function isTestAddress(to: string, inbox: TestInbox): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc(inbox.local)}\\+[a-z0-9-]{1,40}@${esc(inbox.domain)}$`).test(to);
}

export function composeUrl(to: string, subject: string, body: string): string {
  const q = new URLSearchParams({ view: "cm", fs: "1", tf: "1", to, su: subject, body });
  return `https://mail.google.com/mail/?${q.toString()}`;
}

export function emailBody(d: EmailDraft, videoUrl: string): string {
  return `${d.body}\n\nOne-pager: ${d.attachment}\nLaunch video: ${videoUrl}`;
}

export interface SendProgress {
  sent: number;
  total: number;
  to: string;
}

export interface SendResult {
  sent: string[];
  failed: Array<{ to: string; reason: string }>;
}

/** Pull the ref of Gmail's compose Send button out of a `bsk observe` dump. */
export function findSendRef(observe: string): string | null {
  const m =
    /(@e\d+) button "Send[^"]*⌘Enter/.exec(observe) ?? /(@e\d+) button "Send(?: [^"]*)?"/.exec(observe);
  return m?.[1] ?? null;
}

export class GmailSender {
  constructor(
    private readonly o: {
      bin: string;
      runner: CliRunner;
      inbox: TestInbox;
      videoUrl: string;
      /** Poll budget per message while Gmail loads the compose window. */
      readyTries?: number;
    },
  ) {}

  private bsk(args: string[]) {
    return this.o.runner([this.o.bin, ...args]);
  }

  /** Open a prefilled compose, click Send, and wait for Gmail's own "Message sent" confirmation. */
  private async sendOne(session: string, to: string, d: EmailDraft): Promise<"sent" | string> {
    const nav = await this.bsk([
      "navigate",
      composeUrl(to, d.subject, emailBody(d, this.o.videoUrl)),
      "--session",
      session,
    ]);
    if (nav.code !== 0) return "could not open Gmail";
    let ref: string | null = null;
    for (let i = 0; i < (this.o.readyTries ?? 12) && !ref; i++) {
      await this.bsk(["wait-for-navigation", "--session", session, "--timeout", "1s"]);
      const obs = await this.bsk(["observe", "--session", session]);
      if (/Choose an account|Sign in to continue/i.test(obs.stdout))
        throw new Error("Gmail needs you to sign in");
      // The compose body loads after the Send button: wait until the recipient chip is on screen too.
      if (obs.stdout.includes(to)) ref = findSendRef(obs.stdout);
    }
    if (!ref) return "Send button never appeared";
    const click = await this.bsk(["click", ref, "--session", session]);
    if (click.code !== 0) return "Send click failed";
    for (let i = 0; i < 12; i++) {
      await this.bsk(["wait-for-navigation", "--session", session, "--timeout", "1s"]);
      const after = (await this.bsk(["observe", "--session", session])).stdout;
      if (/Message sent/i.test(after)) return "sent";
    }
    return "Gmail never confirmed the send";
  }

  async send(
    drafts: EmailDraft[],
    onProgress: (p: SendProgress) => Promise<void> | void,
  ): Promise<SendResult> {
    const result: SendResult = { sent: [], failed: [] };
    const start = await this.bsk([
      "session",
      "start",
      "--json",
      "--name",
      "Send launch emails (Over the Shoulder)",
    ]);
    const session =
      start.code === 0 ? (JSON.parse(start.stdout) as { session_id?: string }).session_id : undefined;
    if (!session)
      throw new Error(`bsk session start failed: ${(start.stderr || start.stdout).trim().slice(0, 200)}`);
    try {
      for (const d of drafts) {
        const to = testAddressFor(d.to, this.o.inbox);
        if (!isTestAddress(to, this.o.inbox)) {
          result.failed.push({ to, reason: "not a test address" });
          continue;
        }
        // One retry: a send only counts once Gmail itself says "Message sent".
        let outcome = await this.sendOne(session, to, d);
        if (outcome !== "sent") outcome = await this.sendOne(session, to, d);
        if (outcome === "sent") {
          result.sent.push(to);
          await onProgress({ sent: result.sent.length, total: drafts.length, to });
        } else result.failed.push({ to, reason: outcome });
      }
    } finally {
      await this.bsk(["session", "stop", session]).catch(() => undefined);
    }
    log.info(
      `gmail: sent ${result.sent.length}/${drafts.length}${result.failed.length ? `, failed ${result.failed.length}` : ""}`,
    );
    return result;
  }
}

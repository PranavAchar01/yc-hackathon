import type { types } from "@slack/bolt";

type KnownBlock = types.KnownBlock;

import type { EmailDraft } from "./demo-data.ts";
import type { StepState } from "./executor/types.ts";
import type { Procedure } from "./procedure.ts";

/**
 * Block Kit builders. Pure functions of state, so every card is unit tested and chat.update
 * always re-renders the whole card. Style: quiet, text-first, context lines for secondary
 * info, dividers between zones, one emoji (the recording dot the SPEC calls for).
 */

export const ACTIONS = {
  teachStop: "ots_teach_stop",
  reviewAll: "ots_review_all",
  send: "ots_send",
  editProcedure: "ots_edit_procedure",
  /** Link buttons still send an interaction; the app only acks it. */
  openLink: "ots_open_link",
} as const;

export const MARKS: Record<StepState, string> = {
  pending: "◻︎",
  running: "◐",
  done: "✓",
  failed: "✕",
};

export interface Card {
  text: string;
  blocks: KnownBlock[];
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Slack mrkdwn escaping for user-provided text. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const SUMMARY_MAX_LINES = 12;
const SUMMARY_MAX_CHARS = 2_800;

/**
 * An agent's finish summary as Slack mrkdwn: escaped, common Markdown mapped to mrkdwn (bold, bullets,
 * headings, links), blank lines dropped, at most 12 lines and well under Slack's 3000-char section limit.
 */
export function slackSummary(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !/^\s*(-{3,}|\|?[\s:|-]+\|[\s:|-]*)$/.test(l))
    .map((l) =>
      esc(l)
        .replace(/^\s*#{1,6}\s+(.+)$/, "*$1*")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
        .slice(0, 400),
    );
  const kept = lines.slice(0, SUMMARY_MAX_LINES);
  if (lines.length > kept.length) kept.push(`_${lines.length - kept.length} more lines_`);
  const text = kept.join("\n");
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}...` : text;
}

const md = (text: string) => ({ type: "mrkdwn" as const, text });
const context = (...lines: string[]): KnownBlock => ({ type: "context", elements: lines.map(md) });
const divider: KnownBlock = { type: "divider" };

// ---------------------------------------------------------------- /teach

export function teachRecordingCard(input: {
  skill: string;
  sessionId: string;
  elapsedMs: number;
  frames: number;
}): Card {
  return {
    text: "Watching over your shoulder",
    blocks: [
      {
        type: "section",
        text: md(":red_circle:  *Watching over your shoulder*"),
        accessory: {
          type: "button",
          action_id: ACTIONS.teachStop,
          value: input.sessionId,
          style: "danger",
          text: { type: "plain_text", text: "Stop" },
        },
      },
      context(
        `Teaching \`/${esc(input.skill)}\`  ·  ${formatClock(input.elapsedMs)}  ·  ${input.frames} frames`,
        "Do the task once, the way you always do it. Press Stop when you are done.",
      ),
    ],
  };
}

export function teachLearningCard(input: { skill: string; frames: number }): Card {
  return {
    text: "Learning from your demonstration",
    blocks: [
      { type: "section", text: md(`${MARKS.running}  *Learning from your demonstration*`) },
      context(`\`/${esc(input.skill)}\`  ·  ${input.frames} frames  ·  turning what you did into steps`),
    ],
  };
}

export function learnedHeadline(p: Procedure, memorableSaved: boolean): string {
  const n = p.steps.length;
  const demos = p.demonstrations === 1 ? "1 demonstration" : `${p.demonstrations} demonstrations`;
  const where = memorableSaved ? "Saved to Memorable." : "Saved as a QM skill.";
  return `Learned ${p.title}. ${n} ${n === 1 ? "step" : "steps"} from ${demos}. ${where}`;
}

export function teachLearnedCard(input: {
  procedure: Procedure;
  memorableSaved: boolean;
  memorableNote?: string;
  /** "/gtm" once registered, "/do gtm" through the router. */
  invoke?: string;
}): Card {
  const p = input.procedure;
  const headline = learnedHeadline(p, input.memorableSaved);
  const blocks: KnownBlock[] = [
    { type: "section", text: md(`${MARKS.done}  *${esc(headline)}*`) },
    divider,
    { type: "section", text: md(p.steps.map((s, i) => `${i + 1}.  ${esc(s)}`).join("\n")) },
    divider,
    context(`Run it with \`${esc(input.invoke ?? `/${p.name}`)}\`  ·  skills/${esc(p.name)}/SKILL.md`),
  ];
  if (!input.memorableSaved && input.memorableNote)
    blocks.push(context(`Memorable: ${esc(input.memorableNote)}`));
  return { text: headline, blocks };
}

/** Between Stop and Publish: the steps are ready; the sheet is open (or one click away). */
export function teachReviewCard(input: {
  title: string;
  steps: number;
  draftId: string;
  actionId: string;
  /** Where it was learned from; default "1 demonstration". */
  source?: string;
}): Card {
  const line = `Learned ${input.title}. ${input.steps} ${input.steps === 1 ? "step" : "steps"} from ${input.source ?? "1 demonstration"}.`;
  return {
    text: line,
    blocks: [
      { type: "section", text: md(`${MARKS.running}  *${esc(line)}*`) },
      context("Check the steps, then publish it as a command."),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: input.actionId,
            value: input.draftId,
            style: "primary",
            text: { type: "plain_text", text: "Review and publish" },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------- /learn <url>

export type LearnPhase = "downloading" | "sampling" | "reading" | "writing";

const LEARN_STATUS: Record<LearnPhase, string> = {
  downloading: "Downloading",
  sampling: "Sampling frames",
  reading: "Reading",
  writing: "Writing the steps",
};

/** Filmstrip thumbnails on the card; a context block holds at most 10 elements. */
export const LEARN_THUMBS = 8;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "video";
  }
}

/** `◐ Watching the recording`, a filmstrip of sampled frames, one tiny context line. */
export function learnWatchingCard(input: {
  url: string;
  phase: LearnPhase;
  frames: number;
  thumbFileIds: string[];
}): Card {
  const blocks: KnownBlock[] = [{ type: "section", text: md(`${MARKS.running}  *Watching the recording*`) }];
  const thumbs = input.thumbFileIds.slice(0, LEARN_THUMBS);
  if (thumbs.length > 0)
    blocks.push({
      type: "context",
      elements: thumbs.map((id, i) => ({
        type: "image" as const,
        slack_file: { id },
        alt_text: `Frame ${i + 1}`,
      })),
    });
  blocks.push(
    context(
      [`<${input.url}|${esc(hostOf(input.url))}>`, LEARN_STATUS[input.phase]]
        .concat(input.frames ? [`${input.frames} frames`] : [])
        .join("  ·  "),
    ),
  );
  return { text: "Watching the recording", blocks };
}

/** `✓ Learned /release · 5 steps` and one Publish button that opens the sheet. */
export function learnedCard(input: { name: string; steps: number; draftId: string; actionId: string }): Card {
  const line = `Learned /${input.name}  ·  ${input.steps} ${input.steps === 1 ? "step" : "steps"}`;
  return {
    text: line,
    blocks: [
      {
        type: "section",
        text: md(`${MARKS.done}  *${esc(line)}*`),
        accessory: {
          type: "button",
          action_id: input.actionId,
          value: input.draftId,
          style: "primary",
          text: { type: "plain_text", text: "Publish" },
        },
      },
    ],
  };
}

export function teachFailedCard(input: { skill: string; reason: string }): Card {
  return {
    text: "Could not learn that one",
    blocks: [
      { type: "section", text: md(`${MARKS.failed}  *Could not learn that one*`) },
      context(`\`/${esc(input.skill)}\`  ·  ${esc(input.reason)}`),
    ],
  };
}

// ---------------------------------------------------------------- /gtm and /ots <skill>

export type RunPhase = "running" | "review" | "done" | "sent" | "failed" | "needs_you";

export interface RunView {
  runId: string;
  procedure: Procedure;
  steps: StepState[];
  notes: (string | undefined)[];
  elapsedMs: number;
  phase: RunPhase;
  drafts: EmailDraft[];
  error?: string;
  summary?: string;
  needsYou?: string;
  /** Latest agent screenshot uploaded to Slack (files.uploadV2, private), shown while running. */
  liveImageFileId?: string;
  /** Live player on the site (Block Kit video block); preferred over the image when set. */
  liveVideo?: { url: string; thumbnailUrl: string };
  /** The finished run in the same video tile: the same player URL (it now plays the replay), final frame. */
  replay?: { url: string; thumbnailUrl: string };
  liveUrl?: string;
  /** Where the run started; the fallback target of the "Open in ..." button. */
  startUrl?: string;
  /** How to run it again, e.g. "/ship" or "/do ship". */
  invoke?: string;
}

/** Short verb titles for the commands people run on stage; everything else gets one derived from its title. */
const VERB_TITLES: Record<string, string> = {
  triage: "Triaging issues",
  announce: "Announcing the release",
  standup: "Writing the standup",
  ship: "Shipping the release",
  deploys: "Checking deploys",
  gtm: "Drafting launch emails",
  release: "Creating the release",
};

/** Present participle of a leading imperative verb: "Create the release" -> "Creating the release". */
function gerund(verb: string): string | null {
  const v = verb.toLowerCase();
  if (!/^[a-z]{3,}$/.test(v) || /ing$/.test(v)) return null;
  // One-syllable consonant-vowel-consonant verbs double the last letter: tag -> tagging, plan -> planning.
  if (/^[^aeiou]*[aeiou][bdgmnpt]$/.test(v)) return `${v}${v.at(-1)}ing`;
  if (/ie$/.test(v)) return `${v.slice(0, -2)}ying`;
  if (/[^aeiou]e$/.test(v) && v !== "be") return `${v.slice(0, -1)}ing`;
  return `${v}ing`;
}

const IMPERATIVES = new Set(
  "add archive assign build check clean close collect compile create deploy draft export file fill find fix label list merge move open pay plan post prepare publish pull reconcile refresh release review route run schedule send ship sort submit summarize sync tag triage update upload write".split(
    " ",
  ),
);

/** `Triaging issues`: one short verb phrase per command, never a sentence. */
export function verbTitle(p: Procedure): string {
  const known = VERB_TITLES[p.name];
  if (known) return known;
  const [first = "", ...rest] = p.title.trim().split(/\s+/);
  const g = IMPERATIVES.has(first.toLowerCase()) ? gerund(first) : null;
  if (g) return [g.charAt(0).toUpperCase() + g.slice(1), ...rest].join(" ").slice(0, 60);
  return `Running ${p.title}`.slice(0, 60);
}

/** 1-based step the agent is on (the first unfinished one), clamped to the step count. */
export function currentStep(states: StepState[]): number {
  const i = states.findIndex((s) => s !== "done");
  return i < 0 ? states.length : i + 1;
}

const RESULT_LINE_MAX = 60;

/**
 * At most `max` short result lines from an agent's finish summary: bullets, Markdown and preambles
 * ("Here is what I did:") stripped, links reduced to their text, each line clipped.
 */
export function resultLines(summary: string | undefined, max = 2): string[] {
  if (!summary) return [];
  return summary
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l && !/:$/.test(l) && !/^(\|?[\s:|-]+\|?)$/.test(l))
    .slice(0, max)
    .map((l) => (l.length > RESULT_LINE_MAX ? `${l.slice(0, RESULT_LINE_MAX - 3).trimEnd()}...` : l));
}

/** The most relevant link in a summary: a GitHub or Vercel URL first, else any https URL, else the fallback. */
export function resultUrl(summary: string | undefined, fallback?: string): string | undefined {
  const urls = (summary ?? "").match(/https:\/\/[^\s)<>|\]]+/g) ?? [];
  const clean = urls.map((u) => u.replace(/[.,;:]+$/, ""));
  return (
    clean.find((u) => /^https:\/\/(www\.)?github\.com\/.+\/(releases|issues|pull)\b/.test(u)) ??
    clean.find((u) => /^https:\/\/([a-z0-9-]+\.)*(github\.com|vercel\.com|vercel\.app)\//.test(u)) ??
    clean[0] ??
    fallback
  );
}

/** "Open in GitHub" for github.com, "Open in Vercel" for Vercel, plain "Open" otherwise. */
export function openLabel(url: string): string {
  const host = hostOf(url);
  if (/(^|\.)github\.com$/.test(host)) return "Open in GitHub";
  if (/(^|\.)vercel\.(com|app)$/.test(host)) return "Open in Vercel";
  if (/(^|\.)mail\.google\.com$/.test(host)) return "Open in Gmail";
  return "Open";
}

/** First sentence of an error, short enough for one line. */
export function shortReason(error: string | undefined): string {
  const first = (error ?? "something went wrong").split(/(?<=[.!?])\s|\n/)[0] ?? "";
  const s = first.replace(/[.!]+$/, "").trim() || "something went wrong";
  return s.length > 70 ? `${s.slice(0, 67).trimEnd()}...` : s;
}

function videoBlock(v: { url: string; thumbnailUrl: string }, title: string, alt: string): KnownBlock {
  return {
    type: "video",
    video_url: v.url,
    thumbnail_url: v.thumbnailUrl,
    title_url: v.url,
    title: { type: "plain_text", text: title },
    alt_text: alt,
    provider_name: "Over the Shoulder",
  };
}

function liveBlock(v: RunView): KnownBlock | null {
  if (v.liveVideo) return videoBlock(v.liveVideo, "Watch live", "Live view of the agent's browser");
  if (v.liveImageFileId)
    return {
      type: "image",
      slack_file: { id: v.liveImageFileId },
      alt_text: "Live view of the agent's browser",
    };
  return null;
}

/**
 * The run card, Apple style: the action, not a report.
 *   running  `◐ Triaging issues`, a large live view, `Step 3 of 6 · 0:42`
 *   done     `✓ Done · 1:26`, at most 2 result lines, one "Open in GitHub" link button
 *   failed   `Stopped · <one short reason>`
 * The GTM demo keeps its one Send button.
 */
export function runCard(v: RunView): Card {
  const p = v.procedure;
  const title = verbTitle(p);
  const clock = formatClock(v.elapsedMs);
  const n = v.drafts.length;
  const blocks: KnownBlock[] = [];

  if (v.phase === "running") {
    blocks.push({ type: "section", text: md(`${MARKS.running}  *${esc(title)}*`) });
    const live = liveBlock(v);
    if (live) blocks.push(live);
    // With the video the card must stay still (an update resets Slack's player); progress is in the player.
    if (!v.liveVideo) blocks.push(context(`Step ${currentStep(v.steps)} of ${p.steps.length}  ·  ${clock}`));
    return { text: title, blocks };
  }

  if (v.phase === "failed") {
    const line = `Stopped  ·  ${shortReason(v.error)}`;
    blocks.push({ type: "section", text: md(`*${esc(line)}*`) });
    return { text: line, blocks };
  }

  if (v.phase === "needs_you") {
    const line = `Needs you  ·  ${(v.needsYou ?? "sign in").replace(/^Needs you:\s*/i, "")}`;
    blocks.push({ type: "section", text: md(`*${esc(line)}*`) });
    blocks.push(
      context(`Sign in once in the agent's window, then run \`${esc(v.invoke ?? `/${p.name}`)}\` again.`),
    );
    return { text: line, blocks };
  }

  if (v.phase === "review" || v.phase === "sent") {
    const head = v.phase === "sent" ? `${sentLine(n).replace(/\.$/, "")}  ·  ${clock}` : `Done  ·  ${clock}`;
    blocks.push({ type: "section", text: md(`${MARKS.done}  *${esc(head)}*`) });
    if (v.replay) blocks.push(videoBlock(v.replay, `Replay  ·  ${title}`, "Replay of the agent's run"));
    const first = v.drafts[0];
    if (v.phase === "review") {
      const lines = [`${n} ${n === 1 ? "draft" : "drafts"} ready`];
      if (first) lines.push(`First to ${first.toName}, ${first.company}`);
      blocks.push({
        type: "section",
        text: md(lines.map(esc).join("\n")),
        ...(n > 0
          ? {
              accessory: {
                type: "button" as const,
                action_id: ACTIONS.send,
                value: v.runId,
                style: "primary" as const,
                text: { type: "plain_text" as const, text: `Send ${n}` },
              },
            }
          : {}),
      });
    }
    return {
      text: v.phase === "sent" ? sentLine(n) : `${p.title}: ${n} drafts ready for review`,
      blocks,
    };
  }

  // done
  blocks.push({ type: "section", text: md(`${MARKS.done}  *Done  ·  ${clock}*`) });
  if (v.replay) blocks.push(videoBlock(v.replay, `Replay  ·  ${title}`, "Replay of the agent's run"));
  const lines = resultLines(v.summary);
  const url = resultUrl(v.summary, v.startUrl);
  const open = url
    ? {
        type: "button" as const,
        action_id: ACTIONS.openLink,
        url,
        text: { type: "plain_text" as const, text: openLabel(url) },
      }
    : null;
  if (lines.length > 0)
    blocks.push({
      type: "section",
      text: md(lines.map(esc).join("\n")),
      ...(open ? { accessory: open } : {}),
    });
  else if (open) blocks.push({ type: "actions", elements: [open] });
  return { text: lines.length ? `Done: ${lines.join(", ")}` : "Done", blocks };
}

export function sentLine(n: number): string {
  return `${n} ${n === 1 ? "email" : "emails"} sent.`;
}

/** Thread reply after Send, per SPEC: "12 emails sent. Priya, done." */
export function sentThreadReply(n: number, requester: string): string {
  return `${sentLine(n)} ${requester}, done.`;
}

export function reviewAllBlocks(drafts: EmailDraft[]): Card {
  const lines = drafts.map(
    (d, i) =>
      `${i + 1}.  *${esc(d.toName)}*, ${esc(d.company)}  ·  ${esc(d.subject)}  ·  _${esc(d.attachment)}_`,
  );
  return {
    text: `${drafts.length} drafts`,
    blocks: [
      { type: "section", text: md(`*${drafts.length} drafts ready*`) },
      { type: "section", text: md(lines.join("\n")) },
      context("Nothing is sent until you press Send. Real sends go to test addresses only."),
    ],
  };
}

export function procedureBlocks(p: Procedure, path: string): Card {
  return {
    text: `Procedure: ${p.title}`,
    blocks: [
      { type: "section", text: md(`*${esc(p.title)}*\n${esc(p.description)}`) },
      { type: "section", text: md(p.steps.map((s, i) => `${i + 1}.  ${esc(s)}`).join("\n")) },
      context(`Edit \`${esc(path)}\`, or run \`/teach ${esc(p.name)}\` again to relearn it.`),
    ],
  };
}

export function notFoundCard(skill: string): Card {
  return {
    text: `No procedure called ${skill}`,
    blocks: [
      { type: "section", text: md(`*No procedure called \`${esc(skill)}\` yet*`) },
      context(`Teach it once with \`/teach ${esc(skill)}\`.`),
    ],
  };
}

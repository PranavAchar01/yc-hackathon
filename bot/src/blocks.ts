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
} as const;

export const MARKS: Record<StepState, string> = {
  pending: "◻︎",
  running: "◐",
  done: "✓",
  failed: "✕",
};

/** SPEC comparison chip, shown only on the GTM demo procedure. */
export const GTM_COMPARISON = "Without the demo: 41 tool calls, 3 min 12 s, 2 wrong attachments.";

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
}): Card {
  const line = `Learned ${input.title}. ${input.steps} ${input.steps === 1 ? "step" : "steps"} from 1 demonstration.`;
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
  /** Latest sandbox screenshot uploaded to Slack (files.uploadV2), shown while running. */
  liveImageFileId?: string;
  liveUrl?: string;
  /** How to run it again, e.g. "/ship" or "/do ship". */
  invoke?: string;
}

export function stepLines(p: Procedure, states: StepState[], notes: (string | undefined)[] = []): string {
  return p.steps
    .map((s, i) => {
      const st = states[i] ?? "pending";
      const label = st === "running" ? `*${esc(s)}*` : esc(s);
      const note = notes[i] ? `  _${esc(notes[i] ?? "")}_` : "";
      return `${MARKS[st]}   ${label}${note}`;
    })
    .join("\n");
}

export function runFooter(v: RunView): string {
  const n = v.procedure.steps.length;
  return `Recalled from ${esc(firstName(v.procedure.teacher))}'s demonstration  ·  ${n} ${n === 1 ? "step" : "steps"}  ·  ${formatDuration(v.elapsedMs)}`;
}

export function emailPreview(d: EmailDraft, index: number, total: number): KnownBlock[] {
  const quoted = d.body
    .split("\n")
    .map((l) => `>${esc(l)}`)
    .join("\n");
  return [
    {
      type: "section",
      text: md(
        `*To*  ${esc(d.toName)}  <mailto:${d.to}|${esc(d.to)}>\n*Subject*  ${esc(d.subject)}\n\n${quoted}`,
      ),
    },
    context(`${esc(d.attachment)}  ·  launch video link  ·  draft ${index + 1} of ${total}`),
  ];
}

function editButton(runId: string) {
  return {
    type: "button" as const,
    action_id: ACTIONS.editProcedure,
    value: runId,
    text: { type: "plain_text" as const, text: "Edit procedure" },
  };
}

export function runCard(v: RunView): Card {
  const p = v.procedure;
  const n = v.drafts.length;
  const mark =
    v.phase === "running"
      ? MARKS.running
      : v.phase === "failed"
        ? MARKS.failed
        : v.phase === "needs_you"
          ? MARKS.pending
          : MARKS.done;
  const blocks: KnownBlock[] = [
    { type: "section", text: md(`${mark}  *${esc(p.title)}*`) },
    { type: "section", text: md(stepLines(p, v.steps, v.notes)) },
  ];
  // Live sandbox view while a computer-use run is going (BrowserSkill). Scripted runs never set these.
  if (v.phase === "running" && v.liveImageFileId) {
    blocks.push({
      type: "image",
      slack_file: { id: v.liveImageFileId },
      alt_text: "Live view of the agent's screen",
    });
  }
  blocks.push(context(runFooter(v)));
  if (v.phase === "running" && v.liveUrl) blocks.push(context(`<${v.liveUrl}|Open live view>`));
  if (p.name === "gtm" && (v.phase === "review" || v.phase === "sent")) blocks.push(context(GTM_COMPARISON));

  if (v.phase === "failed") blocks.push(divider, context(`Stopped: ${esc(v.error ?? "unknown error")}`));

  if (v.phase === "needs_you") {
    blocks.push(divider, { type: "section", text: md(`*${esc(v.needsYou ?? "Needs you: sign in")}*`) });
    blocks.push(
      context(
        `Sign in once in the sandbox browser${v.liveUrl ? ` (<${v.liveUrl}|open it>)` : ""}, then run \`${esc(v.invoke ?? `/${p.name}`)}\` again.`,
      ),
    );
  }

  const first = v.drafts[0];
  if ((v.phase === "review" || v.phase === "sent") && first)
    blocks.push(divider, ...emailPreview(first, 0, n));

  if (v.phase === "review" && n > 0) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ACTIONS.reviewAll,
          value: v.runId,
          text: { type: "plain_text", text: `Review all ${n}` },
        },
        {
          type: "button",
          action_id: ACTIONS.send,
          value: v.runId,
          style: "primary",
          text: { type: "plain_text", text: `Send ${n}` },
        },
        editButton(v.runId),
      ],
    });
  }

  if (v.phase === "done") {
    if (v.summary) blocks.push(divider, context(esc(v.summary.slice(0, 600))));
    blocks.push({ type: "actions", elements: [editButton(v.runId)] });
  }

  if (v.phase === "sent")
    blocks.push(divider, { type: "section", text: md(`${MARKS.done}  *${sentLine(n)}*`) });

  const text =
    v.phase === "sent"
      ? sentLine(n)
      : v.phase === "review"
        ? `${p.title}: ${n} drafts ready for review`
        : v.phase === "needs_you"
          ? `${p.title}: ${v.needsYou ?? "Needs you"}`
          : p.title;
  return { text, blocks };
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

import type { types } from "@slack/bolt";
import { z } from "zod";
import { MARKS } from "./blocks.ts";
import { type Draft, EMOJI_CHOICES } from "./draft.ts";
import type { Visibility } from "./library/types.ts";
import { RESERVED } from "./registrar.ts";

type View = types.ModalView;
type KnownBlock = types.KnownBlock;

/**
 * Modals: one primary button each, few fields, smart defaults. Pure builders + a validated parser.
 */

export const CALLBACKS = {
  publish: "ots_publish",
  describe: "ots_new_describe",
  saveShortcut: "ots_save_as_command",
} as const;

export type SheetMode = "teach" | "new" | "save";

/** Carried through the modal in private_metadata (max 3000 chars). */
export const MetaSchema = z.object({
  mode: z.enum(["teach", "new", "save"]),
  channel: z.string().optional(),
  cardTs: z.string().optional(),
  frames: z.number().int().optional(),
});
export type SheetMeta = z.infer<typeof MetaSchema>;

const TITLES: Record<SheetMode, string> = {
  teach: "Here's what I learned",
  new: "New command",
  save: "Save as command",
};

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true });
const emojiOption = (e: string) => ({
  text: plain(`${e}  ${e.replace(/:/g, "").replace(/_/g, " ")}`),
  value: e,
});

const VISIBILITY_LABEL: Record<Visibility, string> = {
  me: "Just me",
  channel: "This channel",
  everyone: "Everyone",
};

export function publishModal(draft: Draft, meta: SheetMeta): View {
  const visibilities: Visibility[] = meta.channel ? ["me", "channel", "everyone"] : ["me", "everyone"];
  const opt = (v: Visibility) => ({ text: plain(VISIBILITY_LABEL[v]), value: v });
  const emoji = (EMOJI_CHOICES as readonly string[]).includes(draft.emoji) ? draft.emoji : ":sparkles:";
  const intro =
    meta.mode === "teach"
      ? `${draft.steps.length} steps from 1 demonstration${meta.frames ? `, ${meta.frames} frames` : ""}. Fix anything that looks off, then publish.`
      : "Fix anything that looks off, then publish.";
  const blocks: KnownBlock[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: intro }] },
    {
      type: "input",
      block_id: "name",
      label: plain("Command"),
      hint: plain("Becomes a slash command. Lowercase letters, numbers and dashes."),
      element: { type: "plain_text_input", action_id: "v", initial_value: draft.name, max_length: 32 },
    },
    {
      type: "input",
      block_id: "description",
      label: plain("What it does"),
      element: {
        type: "plain_text_input",
        action_id: "v",
        initial_value: draft.description,
        max_length: 140,
      },
    },
    {
      type: "input",
      block_id: "emoji",
      label: plain("Icon"),
      element: {
        type: "static_select",
        action_id: "v",
        initial_option: emojiOption(emoji),
        options: EMOJI_CHOICES.map(emojiOption),
      },
    },
    {
      type: "input",
      block_id: "steps",
      label: plain("Steps"),
      hint: plain("One per line, in order."),
      element: {
        type: "plain_text_input",
        action_id: "v",
        multiline: true,
        initial_value: draft.steps.join("\n"),
      },
    },
    {
      type: "input",
      block_id: "visibility",
      label: plain("Who can use it"),
      element: {
        type: "radio_buttons",
        action_id: "v",
        initial_option: opt("everyone"),
        options: visibilities.map(opt),
      },
    },
  ];
  return {
    type: "modal",
    callback_id: CALLBACKS.publish,
    private_metadata: JSON.stringify({ ...meta, title: draft.title }),
    title: plain(TITLES[meta.mode]),
    submit: plain("Publish"),
    close: plain("Cancel"),
    blocks,
  };
}

export function describeModal(meta: SheetMeta): View {
  return {
    type: "modal",
    callback_id: CALLBACKS.describe,
    private_metadata: JSON.stringify(meta),
    title: plain("New command"),
    submit: plain("Draft it"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "sentence",
        label: plain("Describe what it should do"),
        element: {
          type: "plain_text_input",
          action_id: "v",
          multiline: true,
          max_length: 600,
          placeholder: plain("Every Monday, pull last week's signups and post a summary to #metrics"),
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "One sentence is enough. You can edit the steps next." }],
      },
    ],
  };
}

export function loadingModal(title: string, line: string): View {
  return {
    type: "modal",
    title: plain(title.slice(0, 24)),
    close: plain("Close"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `${MARKS.running}  ${line}` } }],
  };
}

export function errorModal(title: string, line: string): View {
  return {
    type: "modal",
    title: plain(title.slice(0, 24)),
    close: plain("Close"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `${MARKS.failed}  ${line}` } }],
  };
}

// ------------------------------------------------------------------ parsing submissions

const Value = z.object({
  value: z.string().nullish(),
  selected_option: z.object({ value: z.string() }).nullish(),
});
const StateValues = z.record(z.string(), z.record(z.string(), Value));

export interface PublishInput {
  name: string;
  title: string;
  description: string;
  emoji: string;
  steps: string[];
  visibility: Visibility;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; errors: Record<string, string> };

function pick(values: z.infer<typeof StateValues>, block: string): string {
  const v = values[block]?.v;
  return (v?.selected_option?.value ?? v?.value ?? "").trim();
}

/** Validate a Publish submission. Errors are keyed by block_id, ready for response_action "errors". */
export function parsePublish(stateValues: unknown, privateMetadata: string): Parsed<PublishInput> {
  const values = StateValues.parse(stateValues);
  const errors: Record<string, string> = {};
  const name = pick(values, "name").toLowerCase().replace(/^\//, "");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) errors.name = "Use lowercase letters, numbers and dashes.";
  else if (RESERVED.has(name)) errors.name = `/${name} is taken by Slack or by this app.`;
  const description = pick(values, "description");
  if (!description) errors.description = "Say in a few words what it does.";
  const steps = pick(values, "steps")
    .split("\n")
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter(Boolean);
  if (steps.length === 0) errors.steps = "Add at least one step.";
  if (steps.length > 20) errors.steps = "Keep it to 20 steps or fewer.";
  const emoji = pick(values, "emoji") || ":sparkles:";
  const visibility = pick(values, "visibility");
  const vis =
    visibility === "me" || visibility === "channel" || visibility === "everyone" ? visibility : "everyone";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const meta = z.object({ title: z.string().optional() }).safeParse(JSON.parse(privateMetadata || "{}"));
  const title =
    (meta.success && meta.data.title) || name.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return { ok: true, data: { name, title, description, emoji, steps, visibility: vis } };
}

export function parseSentence(stateValues: unknown): string {
  return pick(StateValues.parse(stateValues), "sentence");
}

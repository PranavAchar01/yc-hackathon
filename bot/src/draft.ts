import { z } from "zod";
import { parseExtraction } from "./extract.ts";
import type { LlmProvider } from "./llm.ts";
import { toSkillName } from "./procedure.ts";
import { RESERVED } from "./registrar.ts";

/** What every Publish sheet is prefilled with, whichever of the three ways made it. */
export interface Draft {
  name: string;
  title: string;
  description: string;
  emoji: string;
  steps: string[];
}

export const EMOJI_CHOICES = [
  ":rocket:",
  ":envelope:",
  ":memo:",
  ":bar_chart:",
  ":calendar:",
  ":receipt:",
  ":wave:",
  ":package:",
  ":mag:",
  ":credit_card:",
  ":busts_in_silhouette:",
  ":chart_with_upwards_trend:",
  ":telephone_receiver:",
  ":sparkles:",
] as const;

const KEYWORDS: Array<[RegExp, string]> = [
  [/launch|gtm|release/i, ":rocket:"],
  [/email|mail|outreach|reply/i, ":envelope:"],
  [/metric|dashboard|report|kpi/i, ":bar_chart:"],
  [/invoice|billing|bill/i, ":receipt:"],
  [/expense|card|payment/i, ":credit_card:"],
  [/schedul|calendar|meeting|renewal/i, ":calendar:"],
  [/onboard|welcome|new hire/i, ":wave:"],
  [/interview|candidate|hiring/i, ":busts_in_silhouette:"],
  [/bug|triage|issue|search/i, ":mag:"],
  [/changelog|ship|deploy/i, ":package:"],
  [/call|customer/i, ":telephone_receiver:"],
  [/standup|notes|summary|recap/i, ":memo:"],
];

export function suggestEmoji(text: string): string {
  return KEYWORDS.find(([re]) => re.test(text))?.[1] ?? ":sparkles:";
}

/** A usable, non-reserved command name: prefer the hint (e.g. "/teach gtm"), else derive from the title. */
export function suggestName(title: string, hint = ""): string {
  const candidates = [hint.trim(), title.split(/\s+/).slice(0, 3).join("-"), "my-command"];
  for (const c of candidates) {
    try {
      const n = toSkillName(c).slice(0, 32).replace(/[._]+/g, "-").replace(/-+$/, "");
      if (n && !RESERVED.has(n)) return n;
    } catch {
      // try the next candidate
    }
  }
  return "my-command";
}

export const DraftSchema = z.object({
  name: z
    .string()
    .describe(
      "Short slash-command name: lowercase, 2 to 20 chars, letters, digits and dashes, no leading slash",
    ),
  title: z.string().describe("Human title, 2 to 5 words, sentence case"),
  description: z.string().describe("One sentence: what it does"),
  emoji: z.enum(EMOJI_CHOICES).describe("The closest matching emoji"),
  steps: z.array(z.string()).describe("Ordered imperative steps, each under 12 words, starting with a verb"),
});

/** Validate and tidy a model draft. Pure, unit tested. */
export function normalizeDraft(raw: unknown, hint = ""): Draft {
  const parsed = DraftSchema.parse(raw);
  const base = parseExtraction(parsed);
  return {
    ...base,
    name: suggestName(parsed.name || base.title, hint || parsed.name),
    emoji: parsed.emoji,
  };
}

const SYSTEM = [
  "You turn a request into a reusable team command that a computer-use agent will replay.",
  "Steps are ordered, imperative, concise (under 12 words), start with a verb, and describe intent.",
  "Drafting only: any step that would send, pay or publish ends at 'Queue for review' instead.",
  "Do not use em dashes.",
].join(" ");

export interface CommandDrafter {
  fromSentence(sentence: string): Promise<Draft>;
  fromThread(messageText: string): Promise<Draft>;
}

export class LlmDrafter implements CommandDrafter {
  constructor(private readonly llm: LlmProvider) {}

  private async draft(prompt: string): Promise<Draft> {
    const out = await this.llm.structured({
      system: SYSTEM,
      schemaName: "command_draft",
      schema: DraftSchema,
      effort: "medium",
      content: [{ type: "text", text: prompt }],
    });
    return normalizeDraft(out);
  }

  fromSentence(sentence: string): Promise<Draft> {
    return this.draft(`Describe-it request from a teammate:\n\n${sentence}`);
  }

  fromThread(messageText: string): Promise<Draft> {
    return this.draft(
      `This is a finished agent run from Slack. Turn what it did into a command anyone can rerun.\n\n<run>\n${messageText.slice(0, 12_000)}\n</run>`,
    );
  }
}

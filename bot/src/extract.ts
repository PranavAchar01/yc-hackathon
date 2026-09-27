import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { LlmProvider, Part } from "./llm.ts";

export const MAX_FRAMES = 16;
export const MAX_STEPS = 12;

/** What the model must return. Validated again after the SDK parses it. */
export const ExtractionSchema = z.object({
  title: z.string().describe("Short human title for the procedure, 2 to 5 words, sentence case"),
  description: z.string().describe("One sentence saying when to use this procedure"),
  steps: z
    .array(z.string())
    .describe("Ordered imperative steps, each under 12 words, starting with a verb, no numbering"),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * Validate and normalise a raw model output. Pure, so it is unit tested without the API.
 * Strips list markers and trailing periods, drops empties and exact repeats, caps the count,
 * and replaces em and en dashes (house style forbids them in user-facing copy).
 */
export function parseExtraction(raw: unknown): Extraction {
  const parsed = ExtractionSchema.parse(raw);
  const clean = (s: string) =>
    s
      .replace(/\s*[\u2014\u2013]\s*/g, ", ")
      .replace(/\s+/g, " ")
      .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "")
      .replace(/[.\s]+$/, "")
      .trim();
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const s of parsed.steps.map(clean)) {
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    steps.push(s.charAt(0).toUpperCase() + s.slice(1));
  }
  if (steps.length === 0) throw new Error("the model returned no usable steps");
  const title = clean(parsed.title) || "Untitled procedure";
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    description: clean(parsed.description) || `Replay ${title}`,
    steps: steps.slice(0, MAX_STEPS),
  };
}

/** Evenly subsample so a long recording still fits the request. Always keeps first and last. */
export function subsample<T>(items: readonly T[], max = MAX_FRAMES): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return items.slice(-1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (items.length - 1)) / (max - 1));
    const item = items[idx];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export const SYSTEM_PROMPT = [
  "You watch screenshots of a person doing a task once on their Mac, in time order.",
  "Write the procedure another agent should follow to repeat the same task next time.",
  "Rules: steps are ordered, imperative, concise (under 12 words), start with a verb, and describe intent, not pixels or click coordinates.",
  "Merge trivial UI actions (scrolling, focusing a window) into the step they serve.",
  "Include counts and names you can read on screen when they matter (for example: 12 contacts).",
  "Never include passwords, tokens or other secrets you might see.",
  "Do not use em dashes.",
].join(" ");

export interface StepExtractor {
  extract(framePaths: string[], hint: string): Promise<Extraction>;
}

/** Frames to steps through whichever LLM provider is configured (vision + structured output). */
export class LlmStepExtractor implements StepExtractor {
  constructor(private readonly llm: LlmProvider) {}

  async extract(framePaths: string[], hint: string): Promise<Extraction> {
    const frames = subsample(framePaths);
    const images: Part[] = await Promise.all(
      frames.map(async (p) => ({
        type: "image" as const,
        mediaType: "image/jpeg" as const,
        base64: (await readFile(p)).toString("base64"),
      })),
    );
    const out = await this.llm.structured({
      system: SYSTEM_PROMPT,
      schemaName: "procedure",
      schema: ExtractionSchema,
      effort: "high",
      content: [
        ...images,
        {
          type: "text",
          text: `These ${frames.length} frames show one demonstration of "${hint}". Extract the procedure.`,
        },
      ],
    });
    return parseExtraction(out);
  }
}

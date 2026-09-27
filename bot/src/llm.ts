import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { z } from "zod";
import { log } from "./log.ts";

/**
 * One small interface for the three model call sites (/teach frames -> steps, /new and Save-as drafts,
 * the bsk agent loop), with OpenAI and Anthropic behind it. Callers never touch a vendor SDK.
 */

export type Effort = "low" | "medium" | "high";

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg"; base64: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object with additionalProperties: false. */
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResult {
  id: string;
  content: string | { imagePngBase64: string };
  isError?: boolean;
}
export interface AgentTurn {
  calls: ToolCall[];
  text: string;
  refused: boolean;
}
/** A running tool-use conversation; the provider owns the vendor-specific history. */
export interface AgentChat {
  next(): Promise<AgentTurn>;
  submit(results: ToolResult[]): void;
}

export interface LlmProvider {
  readonly name: "openai" | "anthropic";
  readonly model: string;
  structured<S extends z.ZodType>(o: {
    system: string;
    content: Part[];
    schema: S;
    schemaName: string;
    effort?: Effort;
  }): Promise<z.infer<S>>;
  agent(o: { system: string; tools: ToolSpec[]; firstMessage: string; effort?: Effort }): AgentChat;
}

// ------------------------------------------------------------------ OpenAI (official `openai` SDK, Chat Completions)

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

/**
 * OpenAI strict structured outputs need every property required and additionalProperties false on every
 * object. zod's JSON Schema is close; this makes it exact.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== "$schema") o[k] = walk(v);
    if (o.type === "object" && o.properties && typeof o.properties === "object") {
      o.required = Object.keys(o.properties);
      o.additionalProperties = false;
    }
    return o;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}

type OpenAIClient = Pick<OpenAI, "chat" | "models">;

function openaiParts(content: Part[]): OpenAI.Chat.ChatCompletionContentPart[] {
  return content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.base64}`, detail: "auto" } },
  );
}

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  private readonly client: OpenAIClient;

  constructor(
    apiKey: string | undefined,
    readonly model: string = DEFAULT_OPENAI_MODEL,
    client?: OpenAIClient,
  ) {
    this.client = client ?? new OpenAI({ apiKey });
  }

  /** Warn (once, at startup) when the configured model is not on this key's model list. */
  async checkModel(): Promise<boolean> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list()) ids.push(m.id);
      if (ids.includes(this.model)) return true;
      log.warn(
        `OpenAI model "${this.model}" is not available to this key. Set OTS_OPENAI_MODEL to one of: ${ids
          .filter((id) => /^gpt-|^o\d/.test(id))
          .slice(0, 12)
          .join(", ")}`,
      );
      return false;
    } catch (err) {
      log.warn(`could not list OpenAI models: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  async structured<S extends z.ZodType>(o: {
    system: string;
    content: Part[];
    schema: S;
    schemaName: string;
    effort?: Effort;
  }): Promise<z.infer<S>> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      reasoning_effort: o.effort ?? "medium",
      max_completion_tokens: 16000,
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: openaiParts(o.content) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: o.schemaName, strict: true, schema: strictJsonSchema(o.schema) },
      },
    });
    const choice = res.choices[0];
    if (choice?.message.refusal) throw new Error("the model declined this one");
    const text = choice?.message.content;
    if (!text) throw new Error(`no structured output (finish: ${choice?.finish_reason ?? "none"})`);
    return o.schema.parse(JSON.parse(text));
  }

  agent(o: { system: string; tools: ToolSpec[]; firstMessage: string; effort?: Effort }): AgentChat {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: o.system },
      { role: "user", content: o.firstMessage },
    ];
    const tools: OpenAI.Chat.ChatCompletionTool[] = o.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters, strict: false },
    }));
    const client = this.client;
    const model = this.model;
    return {
      async next() {
        const res = await client.chat.completions.create({
          model,
          reasoning_effort: o.effort ?? "medium",
          max_completion_tokens: 16000,
          messages,
          tools,
          tool_choice: "auto",
        });
        const msg = res.choices[0]?.message;
        if (!msg) return { calls: [], text: "", refused: false };
        messages.push(msg);
        const calls: ToolCall[] = [];
        for (const c of msg.tool_calls ?? []) {
          if (c.type !== "function") continue;
          let input: unknown = {};
          try {
            input = JSON.parse(c.function.arguments || "{}");
          } catch {
            input = { __invalid_json: c.function.arguments };
          }
          calls.push({ id: c.id, name: c.function.name, input });
        }
        return { calls, text: msg.content ?? "", refused: !!msg.refusal };
      },
      submit(results) {
        const images: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const r of results) {
          const isImage = typeof r.content !== "string";
          messages.push({
            role: "tool",
            tool_call_id: r.id,
            content: isImage
              ? "Screenshot attached in the next message."
              : `${r.isError ? "ERROR: " : ""}${r.content}`,
          });
          if (typeof r.content !== "string")
            images.push({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${r.content.imagePngBase64}` },
            });
        }
        // Tool messages are text-only in Chat Completions, so screenshots follow as a user image.
        if (images.length)
          messages.push({ role: "user", content: [{ type: "text", text: "Screenshot:" }, ...images] });
      },
    };
  }
}

// ------------------------------------------------------------------ Anthropic (the original code path)

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

type AnthropicClient = Pick<Anthropic, "messages">;

function anthropicParts(content: Part[]): Anthropic.ContentBlockParam[] {
  return content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } },
  );
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly client: AnthropicClient;

  constructor(
    apiKey: string | undefined,
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    client?: AnthropicClient,
  ) {
    this.client = client ?? new Anthropic({ apiKey });
  }

  async structured<S extends z.ZodType>(o: {
    system: string;
    content: Part[];
    schema: S;
    schemaName: string;
    effort?: Effort;
  }): Promise<z.infer<S>> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: o.system,
      output_config: { effort: o.effort ?? "high", format: zodOutputFormat(o.schema) },
      messages: [{ role: "user", content: anthropicParts(o.content) }],
    });
    if (res.stop_reason === "refusal") throw new Error("the model declined this one");
    if (res.parsed_output === null) throw new Error(`no structured output (stop: ${res.stop_reason})`);
    return o.schema.parse(res.parsed_output);
  }

  agent(o: { system: string; tools: ToolSpec[]; firstMessage: string; effort?: Effort }): AgentChat {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.firstMessage }];
    const tools: Anthropic.Tool[] = o.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
    const client = this.client;
    const model = this.model;
    return {
      async next() {
        const res = await client.messages.create({
          model,
          max_tokens: 16000,
          system: o.system,
          tools,
          output_config: { effort: o.effort ?? "medium" },
          messages,
        });
        // Keep every block (thinking included) so the next turn replays the history unchanged.
        messages.push({ role: "assistant", content: res.content });
        const calls = res.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return { calls, text, refused: res.stop_reason === "refusal" };
      },
      submit(results) {
        messages.push({
          role: "user",
          content: results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.id,
            content:
              typeof r.content === "string"
                ? r.content
                : [
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/png" as const,
                        data: r.content.imagePngBase64,
                      },
                    },
                  ],
            ...(r.isError ? { is_error: true } : {}),
          })),
        });
      },
    };
  }
}

// ------------------------------------------------------------------ selection

export type LlmChoice =
  | { provider: "openai" | "anthropic"; reason: string }
  | { provider: null; reason: string };

/** OTS_LLM wins; otherwise whichever key exists, preferring OpenAI. */
export function chooseProvider(env: {
  OTS_LLM?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}): LlmChoice {
  const want = env.OTS_LLM?.trim();
  if (want === "openai" || want === "anthropic") {
    const key = want === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
    return key
      ? { provider: want, reason: "OTS_LLM" }
      : { provider: null, reason: `OTS_LLM=${want} but its key is missing` };
  }
  if (env.OPENAI_API_KEY) return { provider: "openai", reason: "OPENAI_API_KEY present" };
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", reason: "ANTHROPIC_API_KEY present" };
  return { provider: null, reason: "no OPENAI_API_KEY or ANTHROPIC_API_KEY" };
}

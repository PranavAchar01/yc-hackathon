import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmDrafter } from "../src/draft.ts";
import { ExtractionSchema } from "../src/extract.ts";
import {
  AnthropicProvider,
  chooseProvider,
  DEFAULT_OPENAI_MODEL,
  OpenAIProvider,
  strictJsonSchema,
} from "../src/llm.ts";

// ---------------------------------------------------------------- fakes for both SDKs

function fakeOpenAI(replies: Array<Record<string, unknown>>, models: string[] = ["gpt-5.5", "gpt-5.4-mini"]) {
  const requests: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming[] = [];
  const client = {
    chat: {
      completions: {
        create: async (p: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) => {
          requests.push(JSON.parse(JSON.stringify(p)));
          const message = replies.shift();
          if (!message) throw new Error("no more replies");
          return {
            choices: [{ message: { role: "assistant", refusal: null, ...message }, finish_reason: "stop" }],
          };
        },
      },
    },
    models: {
      list: () =>
        (async function* () {
          for (const id of models) yield { id };
        })(),
    },
  } as unknown as Pick<OpenAI, "chat" | "models">;
  return { client, requests };
}

function fakeAnthropic(replies: Array<Record<string, unknown>>) {
  const requests: Array<Record<string, unknown>> = [];
  const next = (p: Record<string, unknown>) => {
    requests.push(JSON.parse(JSON.stringify(p)));
    const r = replies.shift();
    if (!r) throw new Error("no more replies");
    return r;
  };
  const client = {
    messages: {
      create: async (p: Record<string, unknown>) => next(p),
      parse: async (p: Record<string, unknown>) => next(p),
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, requests };
}

const extraction = {
  title: "GTM launch emails",
  description: "Send them",
  steps: ["Open the inbox", "Queue for review"],
};

// ---------------------------------------------------------------- selection

describe("chooseProvider", () => {
  it("prefers OpenAI when both keys exist, and honours OTS_LLM", () => {
    expect(chooseProvider({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }).provider).toBe("openai");
    expect(chooseProvider({ ANTHROPIC_API_KEY: "a" }).provider).toBe("anthropic");
    expect(
      chooseProvider({ OTS_LLM: "anthropic", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }).provider,
    ).toBe("anthropic");
    expect(chooseProvider({ OTS_LLM: "anthropic", OPENAI_API_KEY: "o" })).toEqual({
      provider: null,
      reason: "OTS_LLM=anthropic but its key is missing",
    });
    expect(chooseProvider({}).provider).toBeNull();
  });
});

// ---------------------------------------------------------------- OpenAI

describe("OpenAIProvider", () => {
  it("defaults to gpt-5.5", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-5.5");
  });

  it("makes zod schemas strict for structured outputs", () => {
    const s = strictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number() }).optional() }));
    expect(s.required).toEqual(["a", "b"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.$schema).toBeUndefined();
  });

  it("sends images and a strict json_schema, and validates the reply with zod", async () => {
    const { client, requests } = fakeOpenAI([{ content: JSON.stringify(extraction) }]);
    const llm = new OpenAIProvider(undefined, "gpt-5.5", client);
    const out = await llm.structured({
      system: "sys",
      schemaName: "procedure",
      schema: ExtractionSchema,
      content: [
        { type: "image", mediaType: "image/jpeg", base64: "AAAA" },
        { type: "text", text: "extract" },
      ],
    });
    expect(out).toEqual(extraction);
    const req = requests[0];
    expect(req?.model).toBe("gpt-5.5");
    expect(req?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "procedure", strict: true },
    });
    expect(JSON.stringify(req?.messages)).toContain("data:image/jpeg;base64,AAAA");
  });

  it("rejects output that fails the zod schema", async () => {
    const { client } = fakeOpenAI([{ content: JSON.stringify({ title: "x" }) }]);
    const llm = new OpenAIProvider(undefined, "gpt-5.5", client);
    await expect(
      llm.structured({
        system: "s",
        schemaName: "p",
        schema: ExtractionSchema,
        content: [{ type: "text", text: "t" }],
      }),
    ).rejects.toThrow();
  });

  it("runs a function-calling loop and feeds screenshots back as a user image", async () => {
    const { client, requests } = fakeOpenAI([
      {
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "screenshot", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "click", arguments: '{"ref":"@e3"}' } },
        ],
      },
      { content: "done", tool_calls: [] },
    ]);
    const chat = new OpenAIProvider(undefined, "gpt-5.4-mini", client).agent({
      system: "sys",
      firstMessage: "go",
      tools: [
        {
          name: "click",
          description: "d",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    const t1 = await chat.next();
    expect(t1.calls).toEqual([
      { id: "c1", name: "screenshot", input: {} },
      { id: "c2", name: "click", input: { ref: "@e3" } },
    ]);
    chat.submit([
      { id: "c1", content: { imagePngBase64: "PNG" } },
      { id: "c2", content: "not found", isError: true },
    ]);
    const t2 = await chat.next();
    expect(t2.calls).toEqual([]);
    const msgs = requests[1]?.messages ?? [];
    const roles = msgs.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    expect(JSON.stringify(msgs[4])).toContain("ERROR: not found");
    expect(JSON.stringify(msgs[5])).toContain("data:image/png;base64,PNG");
    expect(requests[0]?.tools?.[0]).toMatchObject({ type: "function", function: { name: "click" } });
  });

  it("warns when the configured model is not available", async () => {
    const ok = new OpenAIProvider(undefined, "gpt-5.5", fakeOpenAI([]).client);
    expect(await ok.checkModel()).toBe(true);
    const missing = new OpenAIProvider(undefined, "gpt-9", fakeOpenAI([]).client);
    expect(await missing.checkModel()).toBe(false);
  });

  it("backs the /new drafter", async () => {
    const { client } = fakeOpenAI([
      {
        content: JSON.stringify({
          name: "weekly-metrics",
          title: "Weekly metrics",
          description: "Post the digest",
          emoji: ":bar_chart:",
          steps: ["Open the dashboard", "Post the digest"],
        }),
      },
    ]);
    const d = await new LlmDrafter(new OpenAIProvider(undefined, "gpt-5.5", client)).fromSentence(
      "metrics every monday",
    );
    expect(d.name).toBe("weekly-metrics");
  });
});

// ---------------------------------------------------------------- Anthropic

describe("AnthropicProvider", () => {
  it("uses messages.parse for structured output with image blocks", async () => {
    const { client, requests } = fakeAnthropic([{ stop_reason: "end_turn", parsed_output: extraction }]);
    const out = await new AnthropicProvider(undefined, "claude-opus-5-5", client).structured({
      system: "s",
      schemaName: "procedure",
      schema: ExtractionSchema,
      content: [{ type: "image", mediaType: "image/png", base64: "QQ" }],
    });
    expect(out).toEqual(extraction);
    expect(JSON.stringify(requests[0])).toContain('"media_type":"image/png"');
    expect(requests[0]?.model).toBe("claude-opus-5-5");
  });

  it("runs a tool loop, replaying assistant blocks and returning tool_result blocks", async () => {
    const { client, requests } = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "tool_use", id: "u1", name: "snapshot", input: {} },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ]);
    const chat = new AnthropicProvider(undefined, "claude-opus-5-5", client).agent({
      system: "s",
      firstMessage: "go",
      tools: [{ name: "snapshot", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect((await chat.next()).calls).toEqual([{ id: "u1", name: "snapshot", input: {} }]);
    chat.submit([{ id: "u1", content: { imagePngBase64: "PNG" } }]);
    const t2 = await chat.next();
    expect(t2.text).toBe("ok");
    const msgs = requests[1]?.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(msgs[1]?.content)).toContain('"type":"thinking"');
    expect(JSON.stringify(msgs[2]?.content)).toContain('"tool_use_id":"u1"');
  });

  it("reports refusals", async () => {
    const { client } = fakeAnthropic([{ stop_reason: "refusal", content: [] }]);
    const chat = new AnthropicProvider(undefined, "claude-opus-5-5", client).agent({
      system: "s",
      firstMessage: "go",
      tools: [],
    });
    expect((await chat.next()).refused).toBe(true);
  });
});

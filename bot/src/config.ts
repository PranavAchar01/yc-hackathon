import { fileURLToPath } from "node:url";
import { z } from "zod";

const flag = (def: boolean) =>
  z
    .enum(["0", "1", "true", "false", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "1" || v === "true"));

const EnvSchema = z.object({
  // Slack (Keychain: SLACK_BOT_TOKEN, SLACK_APP_TOKEN)
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-", "SLACK_BOT_TOKEN must be a bot token (xoxb-...)"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-", "SLACK_APP_TOKEN must be an app-level token (xapp-...)"),
  // Optional: real slash-command registration (Keychain: SLACK_CONFIG_TOKEN, SLACK_CONFIG_REFRESH_TOKEN)
  SLACK_APP_ID: z.string().optional(),
  SLACK_CONFIG_TOKEN: z.string().optional(),
  SLACK_CONFIG_REFRESH_TOKEN: z.string().optional(),
  // LLM (Keychain: OPENAI_API_KEY and/or ANTHROPIC_API_KEY). OTS_LLM picks; default prefers OpenAI.
  OTS_LLM: z.enum(["openai", "anthropic", ""]).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OTS_OPENAI_MODEL: z.string().default("gpt-5.5"),
  /** Optional faster model for the per-step bsk agent loop only, e.g. gpt-5.4-mini. */
  OTS_OPENAI_FAST_MODEL: z.string().default("gpt-5.4-mini"),
  OTS_ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),

  OTS_EXECUTOR: z.enum(["bsk", "qm", "scripted"]).default("scripted"),
  OTS_FORCE_SCRIPTED: flag(false),
  OTS_SCRIPTED_SPEED: z.coerce.number().positive().default(1),

  OTS_QM_URL: z.url().default("http://localhost:8080"),
  OTS_QM_SIGNING_SECRET: z.string().optional(),

  // Agent Window size, "WIDTHxHEIGHT" in CSS px (e.g. 1710x1060 to fill a MacBook Air screen). Unset = bsk default.
  OTS_BSK_WINDOW: z
    .string()
    .regex(/^\d{3,4}x\d{3,4}$/)
    .optional(),
  BSK_BIN: z.string().default(`${process.env.HOME ?? ""}/.local/bin/bsk`),
  BSK_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  BSK_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),

  OTS_DATABASE_URL: z.string().default("postgres://ots:ots@127.0.0.1:5544/ots"),
  OTS_LIBRARY: z.enum(["postgres", "memory"]).default("postgres"),
  OTS_SEED: flag(true),

  OTS_GBRAIN: flag(true),
  GBRAIN_BIN: z.string().optional(),

  OTS_API_HOST: z.string().default("127.0.0.1"),
  OTS_API_PORT: z.coerce.number().int().positive().default(3977),

  // /learn: video download and frame sampling
  YTDLP_BIN: z.string().default("yt-dlp"),
  FFMPEG_BIN: z.string().default("ffmpeg"),
  FFPROBE_BIN: z.string().default("ffprobe"),

  OTS_SKILLS_DIR: z.string().optional(),
  OTS_REQUESTER: z.string().default("Priya"),
  // Real sends go ONLY to plus-addresses of this inbox (Keychain OTS_TEST_INBOX). Unset = Send is demo-only.
  OTS_TEST_INBOX: z.string().optional(),
  OTS_MEMORABLE_SCOPE: z.string().default("personal"),

  // Live video in Slack: the site relay + player (Keychain OTS_LIVE_SECRET). No secret = image live view.
  OTS_LIVE_SECRET: z.string().min(16).optional(),
  OTS_LIVE_BASE: z.url().default("https://over-the-shoulder-brown.vercel.app"),
  /** How often the bsk executor takes a screenshot: fast for the live relay, 1.2 s for the image view. */
  OTS_LIVE_FRAME_MS: z.coerce.number().int().min(100).default(200),
  /** /learn extraction model (OpenAI); defaults to the fast model. */
  OTS_LEARN_MODEL: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema> & { skillsDir: string; botRoot: string };

export const BOT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`bad environment:\n${issues}`);
  }
  return { ...parsed.data, skillsDir: parsed.data.OTS_SKILLS_DIR ?? DEFAULT_SKILLS_DIR, botRoot: BOT_ROOT };
}

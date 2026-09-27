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
  // Claude (Keychain: ANTHROPIC_API_KEY)
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  OTS_EXECUTOR: z.enum(["cua", "qm", "scripted"]).default("scripted"),
  OTS_FORCE_SCRIPTED: flag(false),
  OTS_SCRIPTED_SPEED: z.coerce.number().positive().default(1),

  OTS_QM_URL: z.url().default("http://localhost:8080"),
  OTS_QM_SIGNING_SECRET: z.string().optional(),

  CUA_CONTAINER: z.string().default("ots-cua"),
  CUA_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
  CUA_LIVE_URL: z.string().optional(),

  OTS_DATABASE_URL: z.string().default("postgres://ots:ots@127.0.0.1:5544/ots"),
  OTS_LIBRARY: z.enum(["postgres", "memory"]).default("postgres"),
  OTS_SEED: flag(true),

  OTS_GBRAIN: flag(true),
  GBRAIN_BIN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  OTS_API_HOST: z.string().default("127.0.0.1"),
  OTS_API_PORT: z.coerce.number().int().positive().default(3977),
  OTS_MOCK_URL: z.string().default("http://host.docker.internal:3977/mock/"),

  OTS_SKILLS_DIR: z.string().optional(),
  OTS_REQUESTER: z.string().default("Priya"),
  OTS_MEMORABLE_SCOPE: z.string().default("personal"),
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

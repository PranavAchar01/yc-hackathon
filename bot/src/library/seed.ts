import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CommandLibrary, NewCommand, RunRecord } from "./types.ts";

/**
 * Seed library: 50 fictional Northwind commands across eng, GTM, ops, finance, people, support and design.
 * The data lives in bot/seed/commands.json so a few can be hand-picked for the stage demo.
 * Everyone in it is made up; ids are placeholders, not real Slack users.
 */

export const SEED_FILE = fileURLToPath(new URL("../../seed/commands.json", import.meta.url));

const Member = z.object({ key: z.string(), id: z.string(), name: z.string(), team: z.string() });
const SeedCommand = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  title: z.string().min(1),
  description: z.string().min(1),
  emoji: z.string().regex(/^:[a-z0-9_+-]+:$/),
  team: z.string(),
  author: z.string(),
  visibility: z.enum(["me", "channel", "everyone"]),
  registered: z.enum(["slash", "router"]),
  startUrl: z.string().nullable(),
  steps: z.array(z.string().min(1)).min(1).max(20),
  usage: z.record(z.string(), z.number().int().min(0)),
});
export const SeedFile = z.object({ team: z.array(Member), commands: z.array(SeedCommand) });
export type SeedData = z.infer<typeof SeedFile>;

/** Placeholder channel for "channel"-visibility seeds, so they only show up to their author. */
export const SEED_CHANNEL = "C0NWSEED";

export function loadSeed(path = SEED_FILE): SeedData {
  const data = SeedFile.parse(JSON.parse(readFileSync(path, "utf8")));
  const people = new Set(data.team.map((m) => m.key));
  for (const c of data.commands) {
    if (!people.has(c.author)) throw new Error(`seed: ${c.name} has unknown author ${c.author}`);
    for (const k of Object.keys(c.usage))
      if (!people.has(k)) throw new Error(`seed: ${c.name} usage by unknown ${k}`);
  }
  return data;
}

export function seedCommands(data: SeedData): NewCommand[] {
  const people = new Map(data.team.map((m) => [m.key, m]));
  return data.commands.map((c) => {
    const author = people.get(c.author);
    if (!author) throw new Error(`seed: unknown author ${c.author}`);
    return {
      name: c.name,
      title: c.title,
      description: c.description,
      emoji: c.emoji,
      steps: c.steps,
      author: author.id,
      authorName: author.name,
      visibility: c.visibility,
      channelId: c.visibility === "channel" ? SEED_CHANNEL : null,
      registered: c.registered,
      startUrl: c.startUrl,
    };
  });
}

/** Deterministic run history spread over the last three weeks. */
export function seedRuns(data: SeedData, now = Date.now()): RunRecord[] {
  const people = new Map(data.team.map((m) => [m.key, m]));
  const runs: RunRecord[] = [];
  let k = 0;
  for (const c of data.commands) {
    for (const [key, times] of Object.entries(c.usage)) {
      const member = people.get(key);
      if (!member) continue;
      for (let i = 0; i < times; i++) {
        k++;
        runs.push({
          command: c.name,
          userId: member.id,
          channelId: null,
          executor: "scripted",
          status: "ok",
          elapsedMs: 20_000 + ((k * 7919) % 40_000),
          at: new Date(now - ((k * 104_729_000) % (21 * 86_400_000))),
        });
      }
    }
  }
  return runs;
}

/** Fill an empty library. Never touches a library that already has commands. */
export async function seedIfEmpty(lib: CommandLibrary, data: SeedData = loadSeed()): Promise<boolean> {
  if ((await lib.count()) > 0) return false;
  for (const c of seedCommands(data)) await lib.upsert(c);
  for (const r of seedRuns(data)) await lib.recordRun(r);
  return true;
}

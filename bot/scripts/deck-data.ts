// Writes pitch/data/deck.json from the real library and agent memory: every public skill with its owner and
// size, every memory note, and the context each way (characters of procedure + memory an agent carries per call).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OFF_TEAM, ownerOf, PgAgentMemory } from "../src/agents/team.ts";
import { loadConfig } from "../src/config.ts";
import { PgLibrary } from "../src/library/pg.ts";

const config = loadConfig();
const library = new PgLibrary(config.OTS_DATABASE_URL);
const memory = new PgAgentMemory(config.OTS_DATABASE_URL);
const all = await library.publicList("", 500);
const mem = await memory.all();
const text = (c: { name: string; title: string; startUrl: string | null; steps: string[] }) =>
  [`/${c.name}: ${c.title}${c.startUrl ? ` (starts at ${c.startUrl})` : ""}`, ...c.steps.map((s, i) => `  ${i + 1}. ${s}`)].join("\n");
const skills = all.map((c) => ({ name: c.name, owner: OFF_TEAM.has(c.name) ? null : ownerOf(c), chars: text(c).length }));
const memChars = Object.fromEntries(Object.entries(mem).map(([a, f]) => [a, f.map((x) => x.length)]));
const generalistChars = all.reduce((n, c) => n + text(c).length, 0) + Object.values(mem).flat().reduce((n, f) => n + f.length, 0);
// A worker running one of its skills carries that skill plus its own memory: the mean over the team's skills.
const own = all.filter((c) => !OFF_TEAM.has(c.name) && ownerOf(c));
const teamChars = Math.round(
  own.reduce((n, c) => n + text(c).length + (mem[ownerOf(c) as keyof typeof mem] ?? []).reduce((m, f) => m + f.length, 0), 0) / own.length,
);
const out = join(import.meta.dirname, "../../pitch/data/deck.json");
await writeFile(out, JSON.stringify({ at: new Date().toISOString(), skills, memories: memChars, generalistChars, teamChars }, null, 2));
process.stdout.write(`skills ${skills.length}, team-owned ${own.length}, generalist ${generalistChars} chars, team ${teamChars} chars per call\n`);
await library.close();
process.exit(0);

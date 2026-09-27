// Tokens: one generalist agent vs a team of skill-owning agents, measured on real runs.
//
// Same read-only task, same executor, same model, two ways:
//   team        the worker that owns the skill runs it with only its own memory (what /team does)
//   generalist  one agent that carries every skill (all 53 procedures, every step) and every agent's memory
// Every number is the API's own usage report (usage.ts), per run. Real browser runs in the signed-in Chrome,
// so this is a heavy step: run it under ~/helloworld/.heavy-lock, at nice 19.
// usage: pnpm tsx scripts/token-bench.ts [repeats=2] [skill ...]   (secrets from scripts/secrets.sh)
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentName, ownerOf, PgAgentMemory } from "../src/agents/team.ts";
import { toProcedure } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { BskExecutor } from "../src/executor/bsk.ts";
import { PgLibrary } from "../src/library/pg.ts";
import { OpenAIProvider } from "../src/llm.ts";
import { log } from "../src/log.ts";
import { defaultRunner } from "../src/memorable.ts";
import { metered, totalTokens, type Usage } from "../src/usage.ts";

const config = loadConfig();
const [repeatsArg, ...only] = process.argv.slice(2);
const repeats = Number(repeatsArg ?? 2);
const skills = only.length ? only : ["standup", "deploys"];

const library = new PgLibrary(config.OTS_DATABASE_URL);
const memory = new PgAgentMemory(config.OTS_DATABASE_URL);
const llm = new OpenAIProvider(
  config.OPENAI_API_KEY,
  config.OTS_OPENAI_FAST_MODEL ?? config.OTS_OPENAI_MODEL,
);
const executor = new BskExecutor({
  bin: config.BSK_BIN,
  runner: defaultRunner(),
  memorable: null,
  memorableScope: config.OTS_MEMORABLE_SCOPE,
  llm,
  timeoutMs: config.BSK_TIMEOUT_MS,
  effort: config.BSK_EFFORT,
  screenshotEveryMs: 60_000, // no live view needed here
});

/** Everything a generalist carries: every command's full procedure, and every agent's memory. */
async function catalog(): Promise<string> {
  const all = await library.publicList("", 500);
  const mem = await memory.all();
  return [
    ...all.map((c) =>
      [
        `/${c.name}: ${c.title}${c.startUrl ? ` (starts at ${c.startUrl})` : ""}`,
        ...c.steps.map((s, i) => `  ${i + 1}. ${s}`),
      ].join("\n"),
    ),
    ...Object.entries(mem).map(([a, facts]) =>
      [`Notes of the ${agentName(a as never)}:`, ...facts.map((f) => `  - ${f}`)].join("\n"),
    ),
  ].join("\n");
}

interface Row {
  skill: string;
  mode: "team" | "generalist";
  run: number;
  ok: boolean;
  seconds: number;
  usage: Usage;
  tokens: number;
}

const rows: Row[] = [];
const cat = await catalog();
log.info(`generalist catalog: ${cat.length} characters`);
for (const name of skills) {
  const rec = await library.get(name);
  if (!rec?.startUrl) throw new Error(`/${name} has no start URL`);
  const owner = ownerOf(rec);
  if (!owner) throw new Error(`/${name} has no owning agent`);
  const own = await memory.recall(owner);
  for (let i = 1; i <= repeats; i++) {
    // Alternate the order so neither mode always runs on a warmer page or cache.
    const modes = i % 2 ? (["team", "generalist"] as const) : (["generalist", "team"] as const);
    for (const mode of modes) {
      const task = {
        procedure: toProcedure(rec),
        userId: "U-bench",
        threadRef: `bench-${name}-${mode}-${i}`,
        extra: "",
        startUrl: rec.startUrl,
        ...(mode === "team" ? { agent: agentName(owner), memory: own } : { catalog: cat }),
      };
      const t0 = Date.now();
      let ok = true;
      const { usage } = await metered(async () => {
        try {
          const res = await executor.run(task, () => undefined);
          ok = !res.needsYou;
        } catch (err) {
          ok = false;
          log.warn(`${name}/${mode}: ${err instanceof Error ? err.message : err}`);
        }
      });
      const row = {
        skill: name,
        mode,
        run: i,
        ok,
        seconds: Math.round((Date.now() - t0) / 1000),
        usage,
        tokens: totalTokens(usage),
      };
      rows.push(row);
      log.info(
        `${name} ${mode} #${i}: ${ok ? "ok" : "FAILED"} ${row.seconds} s, ${usage.calls} calls, ${row.tokens} tokens (${usage.inputTokens} in, ${usage.cachedTokens} cached)`,
      );
    }
  }
}

// Summary: per skill, mean tokens per successful run in each mode, and the ratio.
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
const summary = skills.map((skill) => {
  const t = rows.filter((r) => r.skill === skill && r.mode === "team" && r.ok).map((r) => r.tokens);
  const g = rows.filter((r) => r.skill === skill && r.mode === "generalist" && r.ok).map((r) => r.tokens);
  return {
    skill,
    teamMean: Math.round(mean(t)),
    generalistMean: Math.round(mean(g)),
    ratio: +(mean(g) / mean(t)).toFixed(2),
    n: [t.length, g.length],
  };
});
const out = join(import.meta.dirname, "../../film/data/token-bench.json");
await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  JSON.stringify(
    { at: new Date().toISOString(), model: llm.model, catalogChars: cat.length, rows, summary },
    null,
    2,
  ),
);
log.info(`wrote ${out}\n${JSON.stringify(summary)}`);
await library.close();
process.exit(0);

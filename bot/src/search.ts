import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type CommandLibrary, type CommandRecord, canSee, invocation, type Viewer } from "./library/types.ts";
import { log } from "./log.ts";
import type { CliRunner } from "./memorable.ts";

/**
 * GBrain (github.com/garrytan/gbrain) as the search index. One page per command.
 * CLI surface verified against the repo and a live run (Bun 1.4.2, keyword-only PGLite brain):
 *   gbrain init --pglite --no-embedding       one-time, done by Pranav (see README)
 *   gbrain import <dir> [--no-embed] --json   pages are markdown files with YAML frontmatter; slug = file name
 *   gbrain search "<query>" --json            array of { slug, title, score, chunk_text, ... }
 * There is no single-page write verb, so we keep one file per command in pagesDir and re-import that dir.
 * Semantic search turns on when GBrain has an embedding key (OPENAI_API_KEY); otherwise it is keyword-only.
 */

const GBrainHit = z.object({ slug: z.string(), title: z.string().optional(), score: z.number().optional() });
const GBrainHits = z.array(GBrainHit);

export function commandPage(c: CommandRecord): string {
  const yamlSafe = (s: string) => JSON.stringify(s);
  return [
    "---",
    `title: ${yamlSafe(`${c.title} (/${c.name})`)}`,
    "type: command",
    `tags: [command, ${c.visibility}]`,
    `author: ${yamlSafe(c.authorName)}`,
    "---",
    "",
    `# ${c.title}`,
    "",
    `Slash command: ${invocation(c)}`,
    "",
    c.description,
    "",
    "## Steps",
    "",
    ...c.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    `Made by [[people/${c.authorName.toLowerCase().replace(/\s+/g, "-")}]].`,
    "",
  ].join("\n");
}

/** Slugs may come back as "gtm" or "commands/gtm"; the command name is the last segment. */
export function slugToName(slug: string): string {
  return slug.split("/").pop()?.replace(/\.md$/, "") ?? slug;
}

export function parseGBrainHits(stdout: string): string[] {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  const parsed = GBrainHits.safeParse(JSON.parse(stdout.slice(start)));
  if (!parsed.success) return [];
  const names: string[] = [];
  for (const hit of parsed.data) {
    const name = slugToName(hit.slug);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export class GBrainIndex {
  private upUntil = 0;
  private downUntil = 0;

  constructor(
    private readonly bin: string[],
    private readonly pagesDir: string,
    private readonly runner: CliRunner,
    private readonly embed = false,
  ) {}

  /** Cheap liveness probe, cached for a minute either way. */
  async available(): Promise<boolean> {
    const now = Date.now();
    if (now < this.upUntil) return true;
    if (now < this.downUntil) return false;
    const res = await this.runner([...this.bin, "search", "ping", "--json"]);
    const ok = res.code === 0;
    if (ok) this.upUntil = now + 60_000;
    else {
      this.downUntil = now + 60_000;
      log.warn(
        `gbrain unavailable (exit ${res.code}): ${res.stderr.trim().slice(0, 160)}; using Postgres search`,
      );
    }
    return ok;
  }

  async put(c: CommandRecord): Promise<boolean> {
    await mkdir(this.pagesDir, { recursive: true });
    await writeFile(join(this.pagesDir, `${c.name}.md`), commandPage(c), "utf8");
    if (!(await this.available())) return false;
    const args = [...this.bin, "import", this.pagesDir, "--json", ...(this.embed ? [] : ["--no-embed"])];
    const res = await this.runner(args);
    if (res.code !== 0) log.warn(`gbrain import failed: ${res.stderr.trim().slice(0, 200)}`);
    return res.code === 0;
  }

  /** Write every page, then one import. Used at startup so seeded commands are searchable. */
  async syncAll(commands: CommandRecord[]): Promise<boolean> {
    await mkdir(this.pagesDir, { recursive: true });
    for (const c of commands) await writeFile(join(this.pagesDir, `${c.name}.md`), commandPage(c), "utf8");
    if (!(await this.available())) return false;
    const res = await this.runner([
      ...this.bin,
      "import",
      this.pagesDir,
      "--json",
      ...(this.embed ? [] : ["--no-embed"]),
    ]);
    return res.code === 0;
  }

  async search(query: string): Promise<string[] | null> {
    if (!(await this.available())) return null;
    const res = await this.runner([...this.bin, "search", query, "--json"]);
    if (res.code !== 0) return null;
    try {
      return parseGBrainHits(res.stdout);
    } catch {
      return null;
    }
  }
}

export type SearchEngine = "gbrain" | "postgres" | "memory";

export class CommandSearch {
  constructor(
    private readonly library: CommandLibrary,
    private readonly gbrain: GBrainIndex | null,
  ) {}

  async search(
    viewer: Viewer,
    query: string,
    limit = 8,
  ): Promise<{ results: CommandRecord[]; engine: SearchEngine }> {
    const q = query.trim();
    if (!q) return { results: [], engine: this.library.kind };
    const names = this.gbrain ? await this.gbrain.search(q) : null;
    if (names && names.length > 0) {
      const results: CommandRecord[] = [];
      for (const name of names) {
        const c = await this.library.get(name);
        if (c && canSee(c, viewer)) results.push(c);
        if (results.length >= limit) break;
      }
      if (results.length > 0) return { results, engine: "gbrain" };
    }
    return { results: await this.library.search(viewer, q, limit), engine: this.library.kind };
  }
}

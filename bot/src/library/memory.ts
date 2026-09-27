import {
  type CommandLibrary,
  type CommandRecord,
  canSee,
  type NewCommand,
  type Registration,
  type RunRecord,
  type Viewer,
} from "./types.ts";

/** pg_trgm-style trigrams: lowercase alphanumeric words padded with two leading and one trailing space. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "to",
  "and",
  "or",
  "of",
  "for",
  "in",
  "on",
  "my",
  "our",
  "it",
  "with",
]);

/** Crude English stemmer, close enough to Postgres' for short command text. */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function terms(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

export function haystack(c: Pick<CommandRecord, "name" | "title" | "description" | "steps">): string {
  return `${c.name} ${c.title} ${c.description} ${c.steps.join(" ")}`;
}

/** Score = matched-term ratio (full text) * 2 + trigram similarity on name/title/description, like the SQL. */
export function scoreCommand(c: CommandRecord, query: string): number {
  const q = terms(query);
  if (q.length === 0) return 0;
  const hay = new Set(terms(haystack(c)));
  const matched = q.filter((t) => hay.has(t)).length;
  const fts = matched === q.length ? 1 : matched / q.length / 2;
  const sim = similarity(`${c.name} ${c.title} ${c.description}`, query);
  const exact = c.name === query.trim().toLowerCase().replace(/^\//, "") ? 3 : 0;
  return fts * 2 + sim + exact;
}

/** In-process library for tests and for running without Postgres. Same semantics as PgLibrary. */
export class MemoryLibrary implements CommandLibrary {
  readonly kind = "memory" as const;
  private readonly commands = new Map<string, CommandRecord>();
  private readonly runs: RunRecord[] = [];

  async upsert(cmd: NewCommand): Promise<CommandRecord> {
    const prev = this.commands.get(cmd.name);
    const rec: CommandRecord = {
      ...cmd,
      steps: [...cmd.steps],
      uses: prev?.uses ?? 0,
      lastUsed: prev?.lastUsed ?? null,
      createdAt: prev?.createdAt ?? new Date(),
    };
    this.commands.set(cmd.name, rec);
    return rec;
  }

  async setRegistration(name: string, registered: Registration): Promise<void> {
    const c = this.commands.get(name);
    if (c) c.registered = registered;
  }

  async get(name: string): Promise<CommandRecord | null> {
    return this.commands.get(name) ?? null;
  }

  private visible(v: Viewer): CommandRecord[] {
    return [...this.commands.values()].filter((c) => canSee(c, v));
  }

  async popular(v: Viewer, limit: number): Promise<CommandRecord[]> {
    return this.visible(v)
      .filter((c) => c.uses > 0)
      .sort((a, b) => b.uses - a.uses || (b.lastUsed?.getTime() ?? 0) - (a.lastUsed?.getTime() ?? 0))
      .slice(0, limit);
  }

  async teammatesUseNotTried(v: Viewer, limit: number): Promise<CommandRecord[]> {
    const tried = new Set(this.runs.filter((r) => r.userId === v.userId).map((r) => r.command));
    const users = new Map<string, Set<string>>();
    for (const r of this.runs) {
      if (r.userId === v.userId) continue;
      const set = users.get(r.command) ?? new Set<string>();
      set.add(r.userId);
      users.set(r.command, set);
    }
    return this.visible(v)
      .filter((c) => c.author !== v.userId && !tried.has(c.name) && (users.get(c.name)?.size ?? 0) > 0)
      .sort((a, b) => (users.get(b.name)?.size ?? 0) - (users.get(a.name)?.size ?? 0) || b.uses - a.uses)
      .slice(0, limit);
  }

  async yours(v: Viewer): Promise<CommandRecord[]> {
    return [...this.commands.values()]
      .filter((c) => c.author === v.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async search(v: Viewer, query: string, limit: number): Promise<CommandRecord[]> {
    return rank(this.visible(v), query, limit);
  }

  async publicList(query: string, limit: number): Promise<CommandRecord[]> {
    const all = [...this.commands.values()].filter((c) => c.visibility === "everyone");
    return query.trim() ? rank(all, query, limit) : all.sort((a, b) => b.uses - a.uses).slice(0, limit);
  }

  readonly videos = new Map<string, { videoUrl: string; posterUrl: string }>();

  async setVideo(name: string, videoUrl: string, posterUrl: string): Promise<void> {
    this.videos.set(name, { videoUrl, posterUrl });
  }

  async recordRun(run: RunRecord): Promise<void> {
    const at = run.at ?? new Date();
    this.runs.push({ ...run, at });
    const c = this.commands.get(run.command);
    if (c) {
      c.uses += 1;
      if (!c.lastUsed || c.lastUsed < at) c.lastUsed = at;
    }
  }

  async count(): Promise<number> {
    return this.commands.size;
  }

  async close(): Promise<void> {}
}

function rank(list: CommandRecord[], query: string, limit: number): CommandRecord[] {
  // Same admission rule as SEARCH_SQL: any full-text hit, trigram similarity over 0.12, or the exact name.
  const q = terms(query);
  return list
    .map((c) => {
      const hay = new Set(terms(haystack(c)));
      const hit = q.some((t) => hay.has(t));
      const sim = similarity(`${c.name} ${c.title} ${c.description}`, query);
      return { c, s: scoreCommand(c, query), admit: hit || sim > 0.12 };
    })
    .filter((x) => x.admit || x.s >= 3)
    .sort((a, b) => b.s - a.s || b.c.uses - a.c.uses)
    .slice(0, limit)
    .map((x) => x.c);
}

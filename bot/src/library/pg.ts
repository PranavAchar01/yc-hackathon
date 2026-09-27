import pg from "pg";
import type {
  CommandLibrary,
  CommandRecord,
  NewCommand,
  Registration,
  RunRecord,
  Viewer,
  Visibility,
} from "./types.ts";

export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS commands (
  name         text PRIMARY KEY,
  title        text NOT NULL,
  description  text NOT NULL,
  emoji        text NOT NULL DEFAULT ':sparkles:',
  steps        jsonb NOT NULL,
  author       text NOT NULL,
  author_name  text NOT NULL,
  visibility   text NOT NULL CHECK (visibility IN ('me', 'channel', 'everyone')),
  channel_id   text,
  uses         integer NOT NULL DEFAULT 0,
  last_used    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  registered   text NOT NULL DEFAULT 'router' CHECK (registered IN ('slash', 'router')),
  start_url    text,
  search       tsvector GENERATED ALWAYS AS (
                 to_tsvector('english', name || ' ' || title || ' ' || description || ' ' || steps::text)
               ) STORED
);
ALTER TABLE commands ADD COLUMN IF NOT EXISTS start_url text;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS site_name text;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS poster_url text;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS video_at timestamptz;
CREATE INDEX IF NOT EXISTS commands_search_idx ON commands USING gin (search);
CREATE INDEX IF NOT EXISTS commands_trgm_idx ON commands USING gin ((name || ' ' || title || ' ' || description) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS runs (
  id          bigserial PRIMARY KEY,
  command     text NOT NULL REFERENCES commands(name) ON DELETE CASCADE,
  user_id     text NOT NULL,
  channel_id  text,
  executor    text NOT NULL,
  status      text NOT NULL CHECK (status IN ('ok', 'failed')),
  elapsed_ms  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_command_idx ON runs (command);
CREATE INDEX IF NOT EXISTS runs_user_idx ON runs (user_id);
`;

/** SQL predicate for "viewer can see this command". $1 = viewer user id, $2 = viewer channel id (nullable). */
export const VISIBLE_SQL = `(c.visibility = 'everyone' OR c.author = $1 OR (c.visibility = 'channel' AND c.channel_id = $2))`;

/** Full-text + trigram search. $3 = query, $4 = limit. Weights mirror MemoryLibrary.scoreCommand. */
export const SEARCH_SQL = `
SELECT c.*,
       ts_rank(c.search, websearch_to_tsquery('english', $3)) * 2
       + similarity(c.name || ' ' || c.title || ' ' || c.description, $3)
       + CASE WHEN c.name = lower(regexp_replace(trim($3), '^/', '')) THEN 3 ELSE 0 END AS score
FROM commands c
WHERE ${VISIBLE_SQL}
  AND (c.search @@ websearch_to_tsquery('english', $3)
       OR similarity(c.name || ' ' || c.title || ' ' || c.description, $3) > 0.12
       OR c.name = lower(regexp_replace(trim($3), '^/', '')))
ORDER BY score DESC, c.uses DESC
LIMIT $4`;

interface Row {
  name: string;
  title: string;
  description: string;
  emoji: string;
  steps: unknown;
  author: string;
  author_name: string;
  visibility: Visibility;
  channel_id: string | null;
  uses: number;
  last_used: Date | null;
  created_at: Date;
  registered: Registration;
  start_url: string | null;
  poster_url?: string | null;
}

function toRecord(r: Row): CommandRecord {
  return {
    name: r.name,
    title: r.title,
    description: r.description,
    emoji: r.emoji,
    steps: Array.isArray(r.steps) ? r.steps.map(String) : [],
    author: r.author,
    authorName: r.author_name,
    visibility: r.visibility,
    channelId: r.channel_id,
    uses: r.uses,
    lastUsed: r.last_used,
    createdAt: r.created_at,
    registered: r.registered,
    startUrl: r.start_url,
    posterUrl: r.poster_url ?? null,
  };
}

export class PgLibrary implements CommandLibrary {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  private async rows(sql: string, params: unknown[]): Promise<CommandRecord[]> {
    const res = await this.pool.query<Row>(sql, params);
    return res.rows.map(toRecord);
  }

  async upsert(c: NewCommand): Promise<CommandRecord> {
    const [rec] = await this.rows(
      `INSERT INTO commands (name, title, description, emoji, steps, author, author_name, visibility, channel_id, registered, start_url)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (name) DO UPDATE SET
         title = EXCLUDED.title, description = EXCLUDED.description, emoji = EXCLUDED.emoji,
         steps = EXCLUDED.steps, author = EXCLUDED.author, author_name = EXCLUDED.author_name,
         visibility = EXCLUDED.visibility, channel_id = EXCLUDED.channel_id, registered = EXCLUDED.registered,
         start_url = EXCLUDED.start_url
       RETURNING *`,
      [
        c.name,
        c.title,
        c.description,
        c.emoji,
        JSON.stringify(c.steps),
        c.author,
        c.authorName,
        c.visibility,
        c.channelId,
        c.registered,
        c.startUrl,
      ],
    );
    if (!rec) throw new Error(`upsert of ${c.name} returned nothing`);
    return rec;
  }

  async setRegistration(name: string, registered: Registration): Promise<void> {
    await this.pool.query("UPDATE commands SET registered = $2 WHERE name = $1", [name, registered]);
  }

  async get(name: string): Promise<CommandRecord | null> {
    const [rec] = await this.rows("SELECT * FROM commands WHERE name = $1", [name]);
    return rec ?? null;
  }

  async popular(v: Viewer, limit: number): Promise<CommandRecord[]> {
    return this.rows(
      `SELECT c.* FROM commands c WHERE ${VISIBLE_SQL} AND c.uses > 0
       ORDER BY c.uses DESC, c.last_used DESC NULLS LAST LIMIT $3`,
      [v.userId, v.channelId ?? null, limit],
    );
  }

  async teammatesUseNotTried(v: Viewer, limit: number): Promise<CommandRecord[]> {
    return this.rows(
      `SELECT c.*, t.teammates FROM commands c
       JOIN (SELECT command, count(DISTINCT user_id) AS teammates FROM runs WHERE user_id <> $1 GROUP BY command) t
         ON t.command = c.name
       WHERE ${VISIBLE_SQL}
         AND c.author <> $1
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.command = c.name AND r.user_id = $1)
       ORDER BY t.teammates DESC, c.uses DESC LIMIT $3`,
      [v.userId, v.channelId ?? null, limit],
    );
  }

  async yours(v: Viewer): Promise<CommandRecord[]> {
    return this.rows("SELECT * FROM commands WHERE author = $1 ORDER BY created_at DESC", [v.userId]);
  }

  async search(v: Viewer, query: string, limit: number): Promise<CommandRecord[]> {
    if (!query.trim()) return [];
    return this.rows(SEARCH_SQL, [v.userId, v.channelId ?? null, query, limit]);
  }

  async publicList(query: string, limit: number): Promise<CommandRecord[]> {
    // A viewer id that can never be an author, and no channel: only "everyone" rows pass VISIBLE_SQL.
    if (query.trim()) return this.rows(SEARCH_SQL, ["__public__", null, query, limit]);
    return this.rows(
      "SELECT * FROM commands WHERE visibility = 'everyone' ORDER BY uses DESC, name LIMIT $1",
      [limit],
    );
  }

  async setVideo(name: string, videoUrl: string, posterUrl: string): Promise<void> {
    await this.pool.query(
      "UPDATE commands SET video_url = $2, poster_url = $3, video_at = now() WHERE name = $1",
      [name, videoUrl, posterUrl],
    );
  }

  async recordRun(run: RunRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO runs (command, user_id, channel_id, executor, status, elapsed_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))`,
        [run.command, run.userId, run.channelId, run.executor, run.status, run.elapsedMs, run.at ?? null],
      );
      await client.query(
        `UPDATE commands SET uses = uses + 1, last_used = GREATEST(COALESCE(last_used, 'epoch'), COALESCE($2, now()))
         WHERE name = $1`,
        [run.command, run.at ?? null],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async count(): Promise<number> {
    const res = await this.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM commands");
    return Number(res.rows[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

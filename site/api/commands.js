import pg from "pg";

// Read-only public view of the command library: only commands shared with "everyone".
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

const COLS = `name, title, description, author_name, uses, steps, registered, created_at, video_url, poster_url, video_at`;

export default async function handler(req, res) {
  const q = String(req.query?.q ?? "").trim().slice(0, 200);
  try {
    const { rows } = q
      ? await pool.query(
          `SELECT ${COLS},
                  ts_rank(search, websearch_to_tsquery('english', $1)) * 2
                  + similarity(name || ' ' || title || ' ' || description, $1) AS score
             FROM commands
            WHERE visibility = 'everyone'
              AND (search @@ websearch_to_tsquery('english', $1)
                   OR similarity(name || ' ' || title || ' ' || description, $1) > 0.12)
            ORDER BY score DESC, (video_url IS NOT NULL) DESC, uses DESC
            LIMIT 50`,
          [q],
        )
      : await pool.query(
          `SELECT ${COLS} FROM commands WHERE visibility = 'everyone' ORDER BY (video_url IS NOT NULL) DESC, uses DESC, name LIMIT 200`,
        );
    const total = q ? null : (await pool.query(`SELECT count(*)::int AS n, coalesce(sum(uses),0)::int AS runs FROM commands WHERE visibility = 'everyone'`)).rows[0];
    res.setHeader("cache-control", "s-maxage=10, stale-while-revalidate=60");
    res.status(200).json({ query: q, total, commands: rows.map(({ score, ...r }) => r) });
  } catch (err) {
    res.status(503).json({ error: "library unavailable" });
  }
}

import { timingSafeEqual } from "node:crypto";
import pg from "pg";

// Live relay for the agent's browser. The bot POSTs the latest frame of a run (JPEG, bearer OTS_LIVE_SECRET);
// the player page GETs it about 8 times a second. Postgres keeps exactly one row per run (the latest frame,
// overwritten in place) and forgets runs 30 minutes after their last frame. Why not Vercel Blob: an overwritten
// blob URL is CDN-cached for at least a minute, and every put is a billed operation; this needs a fresh read
// every 125 ms. Why not memory: POSTs and GETs can land on different function instances.

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

const RUN_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_FRAME_BYTES = 2_500_000;
const TTL = "30 minutes";

let ready;
function migrate() {
  ready ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS live_frames (
         run_id text PRIMARY KEY,
         seq integer NOT NULL DEFAULT 0,
         state text NOT NULL DEFAULT 'live',
         title text,
         frame bytea,
         frame_type text,
         replay_url text,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .catch((err) => {
      ready = undefined;
      throw err;
    });
  return ready;
}

function authorized(req) {
  const secret = process.env.OTS_LIVE_SECRET ?? "";
  const got = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 16 || got.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const noStore = (res) => {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", "x-seq, x-state, x-replay, x-title, etag");
};

export default async function handler(req, res) {
  const run = String(req.query?.run ?? "");
  noStore(res);
  if (!RUN_ID.test(run)) return res.status(404).json({ error: "no such run" });
  try {
    await migrate();
    if (req.method === "POST") return await post(req, res, run);
    if (req.method === "GET" || req.method === "HEAD") return await get(req, res, run);
    res.setHeader("allow", "GET, HEAD, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    return res.status(err.status ?? 503).json({ error: err.status ? err.message : "relay unavailable" });
  }
}

async function post(req, res, run) {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim();
  // Forget stale runs whenever anyone writes: nothing lives past the TTL.
  await pool.query(`DELETE FROM live_frames WHERE updated_at < now() - interval '${TTL}'`);
  if (type === "application/json") {
    const body = JSON.parse((await readBody(req, 10_000)).toString("utf8") || "{}");
    const state = body.state === "failed" ? "failed" : "done";
    const replay = typeof body.replayUrl === "string" && /^https:\/\/[^\s"'<>]+$/.test(body.replayUrl) ? body.replayUrl : null;
    const { rows } = await pool.query(
      `INSERT INTO live_frames (run_id, state, replay_url) VALUES ($1, $2, $3)
       ON CONFLICT (run_id) DO UPDATE SET state = $2, replay_url = coalesce($3, live_frames.replay_url), updated_at = now()
       RETURNING seq`,
      [run, state, replay],
    );
    return res.status(200).json({ seq: rows[0].seq, state });
  }
  if (type !== "image/jpeg" && type !== "image/png") return res.status(415).json({ error: "send image/jpeg" });
  const frame = await readBody(req, MAX_FRAME_BYTES);
  if (frame.length < 100) return res.status(400).json({ error: "empty frame" });
  const title = decodeURIComponent(String(req.headers["x-title"] ?? "")).slice(0, 120) || null;
  const { rows } = await pool.query(
    `INSERT INTO live_frames (run_id, seq, state, title, frame, frame_type) VALUES ($1, 1, 'live', $2, $3, $4)
     ON CONFLICT (run_id) DO UPDATE SET seq = live_frames.seq + 1, state = 'live', title = coalesce($2, live_frames.title),
       frame = $3, frame_type = $4, updated_at = now()
     RETURNING seq`,
    [run, title, frame, type],
  );
  return res.status(200).json({ seq: rows[0].seq });
}

async function get(req, res, run) {
  const wantFrame = req.query?.frame !== undefined;
  const { rows } = await pool.query(
    `SELECT seq, state, title, replay_url, frame_type, ${wantFrame ? "frame" : "NULL AS frame"}
       FROM live_frames WHERE run_id = $1 AND updated_at > now() - interval '${TTL}'`,
    [run],
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "no such run" });
  res.setHeader("x-seq", String(row.seq));
  res.setHeader("x-state", row.state);
  if (row.replay_url) res.setHeader("x-replay", row.replay_url);
  if (row.title) res.setHeader("x-title", encodeURIComponent(row.title));
  if (!wantFrame)
    return res.status(200).json({ seq: row.seq, state: row.state, title: row.title, replayUrl: row.replay_url });
  if (!row.frame) return res.status(404).json({ error: "no frame yet" });
  const etag = `"${row.seq}"`;
  res.setHeader("etag", etag);
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  res.setHeader("content-type", row.frame_type || "image/jpeg");
  return res.status(200).send(row.frame);
}

import { createServer, type Server } from "node:http";
import type { CommandLibrary, CommandRecord } from "./library/types.ts";
import { invocation } from "./library/types.ts";
import { log } from "./log.ts";
import type { CommandSearch } from "./search.ts";

export interface HealthLine {
  name: string;
  ok: boolean;
  detail: string;
  /** Optional services are shown but do not make the stage red. */
  optional?: boolean;
}

/** Public, read-only shape for the website. Only "everyone" commands, no Slack ids. */
export function publicCommand(c: CommandRecord) {
  return {
    name: c.name,
    invoke: invocation(c),
    title: c.title,
    description: c.description,
    emoji: c.emoji,
    steps: c.steps,
    author: c.authorName,
    uses: c.uses,
    lastUsed: c.lastUsed?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

export interface ApiDeps {
  library: CommandLibrary;
  search: CommandSearch;
  health: () => Promise<HealthLine[]>;
}

/**
 * Small local HTTP server:
 *   GET /api/commands?q=&limit=   read-only library for the website (CORS open, GET only)
 *   GET /api/health               one line per service, used by `pnpm stage`
 */
export function createApiServer(deps: ApiDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method === "OPTIONS") return json(204, {});
        if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
        if (url.pathname === "/api/health") {
          const lines = await deps.health();
          return json(200, { ok: lines.every((l) => l.ok || l.optional), services: lines });
        }
        if (url.pathname === "/api/commands") {
          const q = (url.searchParams.get("q") ?? "").slice(0, 200);
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
          const list = q
            ? (await deps.search.search({ userId: "__public__" }, q, limit)).results.filter(
                (c) => c.visibility === "everyone",
              )
            : await deps.library.publicList("", limit);
          return json(200, { query: q, commands: list.map(publicCommand) });
        }
        return json(404, { error: "not_found" });
      } catch (err) {
        log.error("api error", err instanceof Error ? err.message : err);
        return json(500, { error: "internal" });
      }
    })();
  });
}

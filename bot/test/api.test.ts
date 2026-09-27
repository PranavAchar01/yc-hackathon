import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api.ts";
import { MemoryLibrary } from "../src/library/memory.ts";
import { seedIfEmpty } from "../src/library/seed.ts";
import { CommandSearch } from "../src/search.ts";

const lib = new MemoryLibrary();
const server = createApiServer({
  library: lib,
  search: new CommandSearch(lib, null),
  health: async () => [{ name: "Library", ok: true, detail: "memory" }],
});
let base = "";

beforeAll(async () => {
  await seedIfEmpty(lib);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("local HTTP API", () => {
  it("serves the public library with CORS", async () => {
    const res = await fetch(`${base}/api/commands?limit=5`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { commands: Array<{ name: string; visibility?: string }> };
    expect(body.commands).toHaveLength(5);
    expect(body.commands.every((c) => c.visibility === undefined)).toBe(true);
  });

  it("searches: send launch emails finds /gtm", async () => {
    const body = (await (await fetch(`${base}/api/commands?q=send%20launch%20emails`)).json()) as {
      commands: Array<{ name: string; invoke: string }>;
    };
    expect(body.commands[0]).toMatchObject({ name: "gtm", invoke: "/gtm" });
  });

  it("is read-only", async () => {
    expect((await fetch(`${base}/api/commands`, { method: "DELETE" })).status).toBe(405);
  });

  it("reports health", async () => {
    const body = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("no mock pages", () => {
  it("serves nothing under /mock: demos run only on real sites", async () => {
    expect((await fetch(`${base}/mock/`)).status).toBe(404);
    expect((await fetch(`${base}/mock/queue`, { method: "POST" })).status).toBe(405);
  });
});

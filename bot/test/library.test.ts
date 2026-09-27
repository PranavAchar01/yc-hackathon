import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryLibrary, scoreCommand, similarity, stem } from "../src/library/memory.ts";
import { PgLibrary } from "../src/library/pg.ts";
import { loadSeed, SEED_CHANNEL, seedCommands, seedIfEmpty, seedRuns } from "../src/library/seed.ts";
import type { CommandLibrary, NewCommand } from "../src/library/types.ts";
import { canSee, invocation } from "../src/library/types.ts";

const base = (over: Partial<NewCommand>): NewCommand => ({
  name: "x",
  title: "X",
  description: "d",
  emoji: ":sparkles:",
  steps: ["Do it"],
  author: "UA",
  authorName: "Ana Ortiz",
  visibility: "everyone",
  channelId: null,
  registered: "router",
  startUrl: null,
  ...over,
});

const gtm = base({
  name: "gtm",
  title: "GTM launch emails",
  description: "Send the launch emails once the deliverables are forwarded",
  steps: ["Open the deliverables", "Draft 12 emails", "Queue for review"],
  author: "UMARK",
  authorName: "Mark Ellis",
  registered: "slash",
});
const standup = base({
  name: "standup",
  title: "Daily standup notes",
  description: "Post the standup summary",
  author: "UJORDAN",
});
const secret = base({ name: "private-thing", title: "Private thing", visibility: "me", author: "UMARK" });
const room = base({
  name: "room-thing",
  title: "Room thing",
  visibility: "channel",
  channelId: "C1",
  author: "UMARK",
});

/** The same behaviour contract, run against both implementations. */
function contract(make: () => Promise<CommandLibrary>) {
  let lib: CommandLibrary;
  beforeAll(async () => {
    lib = await make();
    for (const c of [gtm, standup, secret, room]) await lib.upsert(c);
    for (const u of ["UJORDAN", "UBEN", "UAISHA"]) await lib.recordRun(run("standup", u));
    await lib.recordRun(run("gtm", "UMARK"));
    await lib.recordRun(run("gtm", "UPRIYA"));
  });
  const run = (command: string, userId: string) => ({
    command,
    userId,
    channelId: null,
    executor: "scripted",
    status: "ok" as const,
    elapsedMs: 1000,
  });

  it("upserts and reads back", async () => {
    const c = await lib.get("gtm");
    expect(c?.steps).toEqual(gtm.steps);
    expect(c?.uses).toBe(2);
    expect(c?.registered).toBe("slash");
  });

  it("keeps usage on re-publish", async () => {
    await lib.upsert({ ...gtm, description: "Send the launch emails once the deliverables are forwarded" });
    expect((await lib.get("gtm"))?.uses).toBe(2);
  });

  it("ranks popular by uses and respects visibility", async () => {
    const pop = await lib.popular({ userId: "UNEW" }, 5);
    expect(pop.map((c) => c.name)).toEqual(["standup", "gtm"]);
  });

  it("finds what teammates use that the viewer has not tried", async () => {
    const forPriya = await lib.teammatesUseNotTried({ userId: "UPRIYA" }, 5);
    expect(forPriya.map((c) => c.name)).toEqual(["standup"]);
    const forNew = await lib.teammatesUseNotTried({ userId: "UNEW" }, 5);
    expect(forNew.map((c) => c.name)).toEqual(["standup", "gtm"]);
  });

  it("lists yours including private ones", async () => {
    const mine = (await lib.yours({ userId: "UMARK" })).map((c) => c.name).sort();
    expect(mine).toEqual(["gtm", "private-thing", "room-thing"]);
  });

  it("searches by meaning of words, not just the name", async () => {
    const hits = await lib.search({ userId: "UNEW" }, "send launch emails", 5);
    expect(hits[0]?.name).toBe("gtm");
    expect((await lib.search({ userId: "UNEW" }, "/gtm", 5))[0]?.name).toBe("gtm");
    expect((await lib.search({ userId: "UNEW" }, "stand up", 5)).map((c) => c.name)).toContain("standup");
  });

  it("hides private and other-channel commands from search", async () => {
    expect((await lib.search({ userId: "UNEW" }, "private thing", 5)).map((c) => c.name)).not.toContain(
      "private-thing",
    );
    expect(
      (await lib.search({ userId: "UNEW", channelId: "C1" }, "room thing", 5)).map((c) => c.name),
    ).toContain("room-thing");
    expect(
      (await lib.search({ userId: "UNEW", channelId: "C2" }, "room thing", 5)).map((c) => c.name),
    ).not.toContain("room-thing");
  });

  it("public list only has everyone-visible commands", async () => {
    const names = (await lib.publicList("", 50)).map((c) => c.name);
    expect(names).toContain("gtm");
    expect(names).not.toContain("private-thing");
    expect(names).not.toContain("room-thing");
  });

  it("records registration", async () => {
    await lib.setRegistration("standup", "slash");
    expect((await lib.get("standup"))?.registered).toBe("slash");
  });
}

describe("MemoryLibrary", () => {
  contract(async () => new MemoryLibrary());
});

// Integration: runs against the local ots-postgres (qm-config/docker-compose.yml) when it is up.
const PG_URL = process.env.OTS_TEST_DATABASE_URL ?? "postgres://ots:ots@127.0.0.1:5544/ots";
const pgUp = await (async () => {
  const lib = new PgLibrary(PG_URL);
  try {
    await lib.migrate();
    return true;
  } catch {
    return false;
  } finally {
    await lib.close();
  }
})();

describe.skipIf(!pgUp)("PgLibrary (local Postgres)", () => {
  const schema = `ots_test_${process.pid}`;
  let lib: PgLibrary;
  contract(async () => {
    lib = new PgLibrary(`${PG_URL}?options=-c%20search_path%3D${schema},public`);
    const admin = new PgLibrary(PG_URL);
    await (admin as unknown as { pool: { query: (s: string) => Promise<unknown> } }).pool.query(
      `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    );
    await admin.close();
    await lib.migrate();
    return lib;
  });
  afterAll(async () => {
    await (lib as unknown as { pool: { query: (s: string) => Promise<unknown> } }).pool.query(
      `DROP SCHEMA ${schema} CASCADE`,
    );
    await lib.close();
  });
});

describe("helpers", () => {
  it("visibility and invocation", () => {
    expect(canSee(secret as never, { userId: "UNEW" })).toBe(false);
    expect(canSee(room as never, { userId: "UNEW", channelId: "C1" })).toBe(true);
    expect(invocation(gtm)).toBe("/gtm");
    expect(invocation(standup)).toBe("/do standup");
  });

  it("stems and scores like Postgres, roughly", () => {
    expect(stem("emails")).toBe("email");
    expect(stem("summaries")).toBe("summary");
    expect(similarity("gtm launch", "gtm launch")).toBe(1);
    const rec = { ...gtm, uses: 0, lastUsed: null, createdAt: new Date() };
    expect(scoreCommand(rec, "send launch emails")).toBeGreaterThan(scoreCommand(rec, "payroll"));
  });
});

describe("seed", () => {
  const data = loadSeed();
  it("has 50 unique, fully filled commands with gtm and ship first", () => {
    const names = data.commands.map((c) => c.name);
    expect(names).toHaveLength(50);
    expect(new Set(names).size).toBe(50);
    expect(names.slice(0, 2)).toEqual(["gtm", "ship"]);
    for (const c of data.commands) {
      expect(c.steps.length).toBeGreaterThanOrEqual(4);
      expect(c.steps.length).toBeLessThanOrEqual(8);
      expect(c.title && c.description && c.emoji).toBeTruthy();
    }
    expect(JSON.stringify(data)).not.toMatch(/[\u2013\u2014]/);
  });

  it("spreads across all seven teams", () => {
    expect(new Set(data.commands.map((c) => c.team))).toEqual(
      new Set(["eng", "gtm", "ops", "finance", "people", "support", "design"]),
    );
  });

  it("maps to library rows and runs", () => {
    const cmds = seedCommands(data);
    expect(cmds.find((c) => c.name === "gtm")?.registered).toBe("slash");
    expect(cmds.filter((c) => c.visibility === "channel").every((c) => c.channelId === SEED_CHANNEL)).toBe(
      true,
    );
    const total = data.commands.reduce((n, c) => n + Object.values(c.usage).reduce((a, b) => a + b, 0), 0);
    expect(seedRuns(data)).toHaveLength(total);
  });

  it("seeds an empty library once", async () => {
    const lib = new MemoryLibrary();
    expect(await seedIfEmpty(lib, data)).toBe(true);
    expect(await lib.count()).toBe(50);
    expect(await seedIfEmpty(lib, data)).toBe(false);
    expect((await lib.teammatesUseNotTried({ userId: "U0NWPRIYA" }, 5)).length).toBeGreaterThan(0);
    expect((await lib.search({ userId: "UNEW" }, "send launch emails", 3))[0]?.name).toBe("gtm");
  });
});

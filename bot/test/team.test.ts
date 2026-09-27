import { describe, expect, it } from "vitest";
import {
  InMemoryAgentMemory,
  lessonFrom,
  ownerOf,
  roster,
  routerBrief,
  SEED_MEMORY,
  validPlan,
} from "../src/agents/team.ts";
import { metered, recordUsage, totalTokens } from "../src/usage.ts";

const skills = [
  {
    name: "triage",
    title: "Triage new issues",
    startUrl: "https://github.com/PranavAchar01/over-the-shoulder/issues",
  },
  {
    name: "create-release",
    title: "Create GitHub release",
    startUrl: "https://github.com/PranavAchar01/over-the-shoulder",
  },
  {
    name: "announce",
    title: "Announce the release",
    startUrl: "https://github.com/PranavAchar01/over-the-shoulder/releases/latest",
  },
  {
    name: "deploys",
    title: "Latest production deploy",
    startUrl: "https://vercel.com/phantom3452s-projects/over-the-shoulder",
  },
  { name: "benefits-faq", title: "Benefits FAQ update", startUrl: null },
];

describe("team of agents", () => {
  it("gives every skill with a real site to exactly one worker; email skills go to Gmail", () => {
    expect(skills.map(ownerOf)).toEqual(["github", "github", "gmail", "vercel", null]);
    const team = roster(skills);
    expect([...team.keys()].sort()).toEqual(["github", "gmail", "vercel"]);
    expect(team.get("github")?.map((s) => s.name)).toEqual(["triage", "create-release"]);
  });

  it("the router's brief is one line per skill, nothing else", () => {
    const brief = routerBrief(roster(skills));
    expect(brief.split("\n")).toHaveLength(3 + 4);
    expect(brief).toContain("  - announce: Announce the release");
    expect(brief).not.toContain("Open ");
  });

  it("drops plan steps that name a skill the worker does not own", () => {
    const plan = validPlan(
      {
        reply: "ok",
        steps: [
          { agent: "github", skill: "create-release", note: "v1.3.0" },
          { agent: "github", skill: "announce", note: "" },
          { agent: "gmail", skill: "announce", note: "" },
        ],
      },
      roster(skills),
    );
    expect(plan.steps.map((s) => `${s.agent}/${s.skill}`)).toEqual([
      "github/create-release",
      "gmail/announce",
    ]);
  });

  it("memory is scoped per agent and keeps the latest lessons", async () => {
    const m = new InMemoryAgentMemory();
    for (let i = 0; i < 9; i++) await m.learn("github", `lesson ${i}`);
    const gh = await m.recall("github");
    expect(gh.slice(0, SEED_MEMORY.github.length)).toEqual(SEED_MEMORY.github);
    expect(gh.slice(SEED_MEMORY.github.length)).toEqual([
      "lesson 3",
      "lesson 4",
      "lesson 5",
      "lesson 6",
      "lesson 7",
      "lesson 8",
    ]);
    expect(await m.recall("gmail")).toEqual(SEED_MEMORY.gmail);
  });

  it("a lesson is the first line of the result, dated", () => {
    expect(lessonFrom("triage", "- #19 bug, P1\n- #18 perf", new Date("2026-09-26T12:00:00Z"))).toBe(
      "2026-09-26 /triage: #19 bug, P1",
    );
    expect(lessonFrom("triage", "")).toBeNull();
  });

  it("meters tokens per scope, never mixing concurrent runs", async () => {
    const run = (n: number) =>
      metered(async () => {
        recordUsage(n, 10);
        await new Promise((r) => setTimeout(r, 5));
        recordUsage(n, 10, 5);
      });
    const [a, b] = await Promise.all([run(100), run(1000)]);
    expect(totalTokens(a.usage)).toBe(220);
    expect(totalTokens(b.usage)).toBe(2020);
    expect(b.usage).toMatchObject({ calls: 2, cachedTokens: 5 });
    recordUsage(1, 1); // outside any scope: ignored, no throw
  });
});

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { thumbnailUrl } from "../src/home.ts";
import type { CommandRecord } from "../src/library/types.ts";
import { teamCoverUrl, teamOf } from "../src/teams.ts";

const seedPath = fileURLToPath(new URL("../seed/commands.json", import.meta.url));
const siteCovers = pathToFileURL(fileURLToPath(new URL("../../site/covers.js", import.meta.url))).href;

interface SeedCmd {
  name: string;
  title: string;
  description: string;
  team: string;
}

describe("team covers", () => {
  it("puts every seeded command in its own team, in the bot and on the site alike", async () => {
    const seed = JSON.parse(await readFile(seedPath, "utf8")) as { commands: SeedCmd[] };
    const site = (await import(siteCovers)) as {
      teamOf: (c: SeedCmd) => string;
      glyphOf: (c: SeedCmd) => string;
      coverHtml: (c: SeedCmd, invoke: string) => string;
      TEAMS: Record<string, unknown>;
    };
    for (const c of seed.commands) {
      expect([c.name, teamOf(c)]).toEqual([c.name, c.team]);
      expect(site.teamOf(c)).toBe(teamOf(c));
      expect(Object.keys(site.TEAMS)).toContain(teamOf(c));
    }
    const html = site.coverHtml(seed.commands[0] as SeedCmd, "/gtm");
    expect(html).toContain('class="slash">/gtm<');
    expect(html).toContain("<svg");
    expect(site.coverHtml({ name: "x", title: "<b>", description: "", team: "" }, "/<x>")).not.toContain(
      "<b>",
    );
  });

  it("App Home thumbnails use the run poster when there is one, else the team cover", () => {
    const rec = { name: "triage", title: "Triage new issues", description: "" } as CommandRecord;
    expect(thumbnailUrl(rec, "https://site.example")).toBe("https://site.example/covers/eng.png");
    expect(thumbnailUrl({ ...rec, posterUrl: "https://blob/p.jpg" })).toBe("https://blob/p.jpg");
    expect(teamCoverUrl("https://s/", "gtm")).toBe("https://s/covers/gtm.png");
  });
});

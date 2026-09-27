import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadSkill,
  type Procedure,
  parseSkillMarkdown,
  renderSkillMarkdown,
  saveSkill,
  toSkillName,
} from "../src/procedure.ts";

const p: Procedure = {
  name: "gtm",
  title: "GTM launch emails",
  description: "Send launch emails: one per contact",
  teacher: "Mark Ellis",
  demonstrations: 1,
  steps: ["Open the deliverables", "Queue for review"],
};

describe("skill files", () => {
  it("round-trips through QM's SKILL.md format", () => {
    const md = renderSkillMarkdown(p);
    expect(md.startsWith("---\nname: gtm\ndescription: ")).toBe(true);
    expect(md).toContain("## Steps\n\n1. Open the deliverables\n2. Queue for review");
    const back = parseSkillMarkdown(md);
    expect(back).toEqual({ ...p, description: "Send launch emails, one per contact" });
  });

  it("slugifies names the way QM accepts them", () => {
    expect(toSkillName("GTM")).toBe("gtm");
    expect(toSkillName("Weekly metrics!")).toBe("weekly-metrics");
    expect(() => toSkillName("!!!")).toThrow();
  });

  it("saves and loads from a skills dir, null when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ots-skills-"));
    const path = await saveSkill(dir, p);
    expect(await readFile(path, "utf8")).toContain("# GTM launch emails");
    expect((await loadSkill(dir, "gtm"))?.steps).toEqual(p.steps);
    expect(await loadSkill(dir, "nope")).toBeNull();
  });

  it("ships a seeded gtm skill with the 7 SPEC steps", async () => {
    const dir = fileURLToPath(new URL("../skills", import.meta.url));
    const gtm = await loadSkill(dir, "gtm");
    expect(gtm?.title).toBe("GTM launch emails");
    expect(gtm?.steps).toHaveLength(7);
    expect(gtm?.steps[1]).toBe("Pull the launch list (12 contacts)");
  });
});

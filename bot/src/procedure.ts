import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/** A learned procedure: what /teach produces and what /gtm and /ots replay. */
export interface Procedure {
  /** Skill name, QM-safe (letters, digits, dot, underscore, hyphen). Also the slash word, e.g. "gtm". */
  name: string;
  /** Human title, e.g. "GTM launch emails". */
  title: string;
  /** One-line description for QM's skill index. */
  description: string;
  /** Ordered imperative steps. */
  steps: string[];
  /** Display name of the person who demonstrated it. */
  teacher: string;
  /** How many demonstrations this was learned from. */
  demonstrations: number;
}

/** Same rule QM enforces in src/skills/skill-name.ts. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?$/;

export function toSkillName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 128);
  if (!SAFE_SKILL_NAME.test(slug)) throw new Error(`"${raw}" is not a usable skill name`);
  return slug;
}

const MetaSchema = z.object({
  title: z.string().min(1),
  teacher: z.string().min(1),
  demonstrations: z.number().int().positive(),
});

const META_OPEN = "<!-- over-the-shoulder ";
const META_CLOSE = " -->";

/**
 * Render as a QM skill (see qm/skills-seed/*): YAML frontmatter with `name` and
 * `description`, then a markdown body. Our own metadata rides in an HTML comment so
 * QM's frontmatter parser sees only the keys it knows.
 */
export function renderSkillMarkdown(p: Procedure): string {
  const meta = JSON.stringify({ title: p.title, teacher: p.teacher, demonstrations: p.demonstrations });
  // QM parses frontmatter line by line and does not unescape quotes; keep it a plain, colon-free scalar.
  const description = p.description.replace(/\s+/g, " ").replace(/:\s/g, ", ").trim();
  return [
    "---",
    `name: ${p.name}`,
    `description: ${description}`,
    "---",
    "",
    `${META_OPEN}${meta}${META_CLOSE}`,
    "",
    `# ${p.title}`,
    "",
    `Learned by watching ${p.teacher} do this once. Replay the steps in order. Draft, never send: stop at review and wait for a human to approve.`,
    "",
    "## Steps",
    "",
    ...p.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
  ].join("\n");
}

export function parseSkillMarkdown(md: string): Procedure {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!fm?.[1]) throw new Error("skill file has no frontmatter");
  const attrs = new Map<string, string>();
  for (const line of fm[1].split("\n")) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) attrs.set(m[1], m[2].trim());
  }
  const name = attrs.get("name");
  const description = attrs.get("description");
  if (!name || !description) throw new Error("skill frontmatter needs name and description");

  const body = md.slice(fm[0].length);
  const metaLine = body.split("\n").find((l) => l.startsWith(META_OPEN) && l.endsWith(META_CLOSE));
  const meta = metaLine
    ? MetaSchema.parse(JSON.parse(metaLine.slice(META_OPEN.length, -META_CLOSE.length)))
    : { title: /^# (.+)$/m.exec(body)?.[1] ?? name, teacher: "someone", demonstrations: 1 };

  const stepsSection = body.split(/^## Steps\s*$/m)[1] ?? "";
  const steps = [...stepsSection.matchAll(/^\d+\.\s+(.+)$/gm)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  if (steps.length === 0) throw new Error(`skill ${name} has no numbered steps`);

  return { name, description, steps, ...meta };
}

export function skillPath(skillsDir: string, name: string): string {
  return join(skillsDir, toSkillName(name), "SKILL.md");
}

export async function saveSkill(skillsDir: string, p: Procedure): Promise<string> {
  const path = skillPath(skillsDir, p.name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderSkillMarkdown(p), "utf8");
  return path;
}

export async function loadSkill(skillsDir: string, name: string): Promise<Procedure | null> {
  try {
    return parseSkillMarkdown(await readFile(skillPath(skillsDir, name), "utf8"));
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Which team a command belongs to, from its name, title and description. Mirrors `teamOf` in site/covers.js
 * (the library covers); test/covers.test.ts keeps the two in step and checks them against the seed library.
 */
export type Team = "eng" | "gtm" | "ops" | "finance" | "people" | "support" | "design";

const RULES: Array<[Team, RegExp]> = [
  ["eng", /\b(code review|pull request|deploy\w*|incident|postmortem|on ?call|oncall|tech debt|changelog)\b/],
  ["gtm", /\b(case study|gtm|launch emails?|lead routing|demo request)\b/],
  ["ops", /\b(vendor|onboard\w*|offboard\w*|facilities|travel|supply|office|procurement)\b/],
  ["design", /\b(design|brand|style guide|style|asset|mockup|figma|user test|usability)\b/],
  ["people", /\b(interview|hire|hiring|recruit|referral|benefits?|pto|survey|culture|pulse|people)\b/],
  [
    "finance",
    /\b(invoice|payroll|budget|renewals?|board|tax|reimburse\w*|finance|revenue|billing|expense reimbursement)\b/,
  ],
  ["support", /\b(customer|churn|support|ticket|feedback|sla|escalation|csat)\b/],
  ["ops", /\b(expense|audit|order|it request)\b/],
  [
    "gtm",
    /\b(lead|leads|competitor|pricing|quote|webinar|outreach|sales|deck|prospect|campaign|marketing)\b/,
  ],
  ["eng", /\b(bug|triage|code|review|release|ship|standup|api|docs|pr|merge|ci|github|issues?)\b/],
];

export function teamOf(c: { name?: string; title?: string; description?: string }): Team {
  const name = c.name ?? "";
  const hay = `${name} ${name.replace(/-/g, " ")} ${c.title ?? ""} ${c.description ?? ""}`.toLowerCase();
  for (const [team, re] of RULES) if (re.test(hay)) return team;
  return "ops";
}

/** Static per-team cover (a soft gradient PNG) served by the site, for App Home thumbnails. */
export function teamCoverUrl(base: string, team: Team): string {
  return `${base.replace(/\/+$/, "")}/covers/${team}.png`;
}

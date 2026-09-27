// Generated covers for library tiles that have no run video yet: a soft gradient per team, one white glyph for
// the kind of command, and the slash command in SF Mono. Pure functions, no network. Shared by library.html and
// the bot's tests (bot/test/covers.test.ts checks the team rules against the seed library).

export const TEAMS = {
  eng: { label: "Engineering", from: "#5e5ce6", to: "#0a84ff" },
  gtm: { label: "Sales", from: "#ff8a5c", to: "#ff375f" },
  ops: { label: "Operations", from: "#34c759", to: "#00a99d" },
  finance: { label: "Finance", from: "#ffc94a", to: "#ff9500" },
  people: { label: "People", from: "#ff6fae", to: "#bf5af2" },
  support: { label: "Support", from: "#64d2ff", to: "#2d9cdb" },
  design: { label: "Design", from: "#8e8e93", to: "#3a3a3c" },
};

// First match wins. Words are matched against the command name, title and description.
const TEAM_RULES = [
  ["eng", /\b(code review|pull request|deploy\w*|incident|postmortem|on ?call|oncall|tech debt|changelog)\b/],
  ["gtm", /\b(case study|gtm|launch emails?|lead routing|demo request|announce)\b/],
  ["ops", /\b(vendor|onboard\w*|offboard\w*|facilities|travel|supply|office|procurement)\b/],
  ["design", /\b(design|brand|style guide|style|asset|mockup|figma|user test|usability)\b/],
  ["people", /\b(interview|hire|hiring|recruit|referral|benefits?|pto|survey|culture|pulse|people)\b/],
  ["finance", /\b(invoice|payroll|budget|renewals?|board|tax|reimburse\w*|finance|revenue|billing|expense reimbursement)\b/],
  ["support", /\b(customer|churn|support|ticket|feedback|sla|escalation|csat)\b/],
  ["ops", /\b(expense|audit|order|it request)\b/],
  ["gtm", /\b(lead|leads|competitor|pricing|quote|webinar|outreach|sales|deck|prospect|campaign|marketing)\b/],
  ["eng", /\b(bug|triage|code|review|release|ship|standup|api|docs|pr|merge|ci|github|issues?)\b/],
];

export function teamOf(c) {
  const hay = `${c.name ?? ""} ${String(c.name ?? "").replace(/-/g, " ")} ${c.title ?? ""} ${c.description ?? ""}`.toLowerCase();
  for (const [team, re] of TEAM_RULES) if (re.test(hay)) return team;
  return "ops";
}

// White line glyphs on a 24 grid, SF Symbols in spirit: 1.8 px strokes, round caps.
const GLYPHS = {
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7.5 8 5.5 8-5.5"/>',
  issue: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  tag: '<path d="M3.5 12.2V4.8c0-.7.6-1.3 1.3-1.3h7.4l8.3 8.3-8.7 8.7z"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  merge: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="12" r="2.2"/><path d="M6.5 7.7v8.6M6.5 8c0 2.8 3.5 4 8.8 4"/>',
  bolt: '<path d="M13 2.8 5 13.2h6.2L10.6 21.2 19 10.6h-6.3z"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16.5V11M12 16.5V6.5M17 16.5v-4"/>',
  person: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20c.9-3.6 3.7-5.6 7.2-5.6s6.3 2 7.2 5.6"/>',
  shapes: '<circle cx="8.5" cy="8.5" r="4.5"/><rect x="11" y="11" width="9" height="9" rx="2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  doc: '<path d="M6.5 3h7.5l4.5 4.5V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13.5 3v5h5M9 13h6M9 16.5h6"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  cursor: '<path d="M5 3.5 5 18.5l4.2-3.8 2.7 6 2.6-1.2-2.6-5.9h5.6z"/>',
};

const GLYPH_RULES = [
  ["mail", /\b(email|emails|mail|outreach|gtm|newsletter)\b/],
  ["tag", /\b(release|ship|changelog|tag|version)\b/],
  ["merge", /\b(code review|pull request|pr|merge)\b/],
  ["doc", /\b(case study)\b/],
  ["issue", /\b(bug|triage|issue|issues|ticket|escalation)\b/],
  ["bolt", /\b(deploy\w*|incident|on ?call|oncall|postmortem|sla)\b/],
  ["chart", /\b(budget|payroll|board|numbers|expense|spend|invoice|renewals?|tax|pricing|quote|revenue|churn)\b/],
  ["person", /\b(onboard\w*|offboard\w*|interview|hire|referral|lead|leads|customer|account)\b/],
  ["shapes", /\b(design|brand|style|asset|mockup|deck)\b/],
  ["calendar", /\b(standup|webinar|travel|pto|schedule|meeting|demo)\b/],
  ["chat", /\b(survey|pulse|feedback|faq)\b/],
  ["check", /\b(check|audit|sync|test)\b/],
  ["doc", /\b(draft|docs?|note|recap|summary|log|scan|list)\b/],
  ["box", /\b(order|supply|supplies|shipment)\b/],
];

export function glyphOf(c) {
  const hay = `${String(c.name ?? "").replace(/-/g, " ")} ${c.title ?? ""}`.toLowerCase();
  for (const [g, re] of GLYPH_RULES) if (re.test(hay)) return g;
  return "cursor";
}

const escAttr = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** Cover markup for one command. `invoke` is the slash command as shown ("/triage" or "/do triage"). */
export function coverHtml(c, invoke) {
  const team = TEAMS[teamOf(c)];
  const glyph = GLYPHS[glyphOf(c)];
  return `<div class="cover" style="--c0:${team.from};--c1:${team.to}" role="img" aria-label="${escAttr(team.label)} command ${escAttr(invoke)}">
  <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>
  <span class="slash">${escAttr(invoke)}</span>
</div>`;
}

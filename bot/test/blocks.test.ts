import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  formatDuration,
  GTM_COMPARISON,
  learnedHeadline,
  type RunView,
  runCard,
  SUMMARY_MAX_LINES,
  sentThreadReply,
  slackSummary,
  stepLines,
  teachLearnedCard,
  teachRecordingCard,
} from "../src/blocks.ts";
import { demoDrafts } from "../src/demo-data.ts";
import type { Procedure } from "../src/procedure.ts";

const gtm: Procedure = {
  name: "gtm",
  title: "GTM launch emails",
  description: "Send the launch emails",
  teacher: "Mark Ellis",
  demonstrations: 1,
  steps: [
    "Open the deliverables Priya forwarded",
    "Pull the launch list (12 contacts)",
    "Match each contact to the right one-pager",
    "Draft 12 emails in Mark's voice",
    "Attach the one-pager and launch video link",
    "Check links and names",
    "Queue for review",
  ],
};

const view = (over: Partial<RunView> = {}): RunView => ({
  runId: "C1:123.456",
  procedure: gtm,
  steps: gtm.steps.map(() => "pending"),
  notes: [],
  elapsedMs: 0,
  phase: "running",
  drafts: [],
  ...over,
});

const allText = (blocks: unknown) => JSON.stringify(blocks);

describe("teach cards", () => {
  it("recording card has the SPEC title and a Stop button carrying the session id", () => {
    const card = teachRecordingCard({ skill: "gtm", sessionId: "s1", elapsedMs: 12_000, frames: 8 });
    expect(card.text).toBe("Watching over your shoulder");
    const section = card.blocks[0];
    expect(section?.type).toBe("section");
    expect(allText(card.blocks)).toContain(":red_circle:");
    expect(allText(card.blocks)).toContain(`"action_id":"${ACTIONS.teachStop}"`);
    expect(allText(card.blocks)).toContain('"value":"s1"');
    expect(allText(card.blocks)).toContain("0:12");
  });

  it("learned headline matches the SPEC copy exactly", () => {
    expect(learnedHeadline(gtm, true)).toBe(
      "Learned GTM launch emails. 7 steps from 1 demonstration. Saved to Memorable.",
    );
    expect(learnedHeadline(gtm, false)).toBe(
      "Learned GTM launch emails. 7 steps from 1 demonstration. Saved as a QM skill.",
    );
  });

  it("learned card lists the steps and says how to run it", () => {
    const card = teachLearnedCard({ procedure: gtm, memorableSaved: true });
    const text = allText(card.blocks);
    expect(text).toContain("1.  Open the deliverables Priya forwarded");
    expect(text).toContain("7.  Queue for review");
    expect(text).toContain("/gtm");
    expect(text).not.toContain("Memorable:");
  });
});

describe("run card", () => {
  it("renders pending, running and done marks", () => {
    const lines = stepLines(gtm, [
      "done",
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]).split("\n");
    expect(lines[0]).toBe("✓   Open the deliverables Priya forwarded");
    expect(lines[1]).toBe("◐   *Pull the launch list (12 contacts)*");
    expect(lines[2]?.startsWith("◻︎   ")).toBe(true);
  });

  it("footer matches the SPEC copy when finished at 38 s", () => {
    const card = runCard(
      view({ phase: "review", elapsedMs: 38_000, steps: gtm.steps.map(() => "done"), drafts: demoDrafts() }),
    );
    const text = allText(card.blocks);
    expect(text).toContain("Recalled from Mark's demonstration  ·  7 steps  ·  38 s");
    expect(text).toContain(GTM_COMPARISON);
  });

  it("shows no buttons or comparison while running", () => {
    const text = allText(runCard(view()).blocks);
    expect(text).not.toContain('"type":"actions"');
    expect(text).not.toContain(GTM_COMPARISON);
  });

  it("final card has a preview and Review all 12 / Send 12 (primary) / Edit procedure", () => {
    const card = runCard(view({ phase: "review", elapsedMs: 38_000, drafts: demoDrafts() }));
    const actions = card.blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    const buttons = actions && actions.type === "actions" ? actions.elements : [];
    const labels = buttons.map((b) => (b.type === "button" ? b.text.text : ""));
    expect(labels).toEqual(["Review all 12", "Send 12", "Edit procedure"]);
    const send = buttons[1];
    expect(send?.type === "button" && send.style).toBe("primary");
    expect(allText(card.blocks)).toContain("@example.com");
    expect(allText(card.blocks)).toContain("draft 1 of 12");
  });

  it("done state drops the buttons and says 12 emails sent", () => {
    const card = runCard(view({ phase: "sent", elapsedMs: 38_000, drafts: demoDrafts() }));
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(card.text).toBe("12 emails sent.");
    expect(sentThreadReply(12, "Priya")).toBe("12 emails sent. Priya, done.");
  });

  it("escapes user text", () => {
    const evil = { ...gtm, title: "<!channel> & co" };
    expect(allText(runCard(view({ procedure: evil })).blocks)).toContain("&lt;!channel&gt; &amp; co");
  });

  it("uses no em or en dashes anywhere in card copy", () => {
    const cards = [
      runCard(view({ phase: "review", drafts: demoDrafts() })),
      runCard(view({ phase: "sent", drafts: demoDrafts() })),
      teachLearnedCard({ procedure: gtm, memorableSaved: false, memorableNote: "not connected" }),
    ];
    for (const c of cards) expect(allText(c)).not.toMatch(/[\u2014\u2013]/);
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(38_000)).toBe("38 s");
    expect(formatDuration(192_000)).toBe("3 min 12 s");
    expect(formatDuration(120_000)).toBe("2 min");
  });
});

describe("finish summary on the run card", () => {
  it("shows the summary as a section on a done card", () => {
    const card = runCard(
      view({ phase: "done", summary: "Yesterday: merged #6\nToday: triage\nBlockers: None" }),
    );
    const section = card.blocks.find(
      (b) => b.type === "section" && JSON.stringify(b).includes("Blockers: None"),
    );
    expect(section).toBeTruthy();
    expect(allText(card.blocks)).toContain("Yesterday: merged #6\\nToday: triage");
  });

  it("maps Markdown to Slack mrkdwn and escapes the rest", () => {
    const out = slackSummary(
      "## Standup\n\n**Yesterday**: shipped <b>v0.1.0</b> & more\n- item one\n* item two\n[release](https://github.com/x/y/releases/tag/v0.1.0)",
    );
    expect(out.split("\n")).toEqual([
      "*Standup*",
      "*Yesterday*: shipped &lt;b&gt;v0.1.0&lt;/b&gt; &amp; more",
      "• item one",
      "• item two",
      "<https://github.com/x/y/releases/tag/v0.1.0|release>",
    ]);
  });

  it("drops table rules and caps the summary at 12 lines", () => {
    const long = [
      "| a | b |",
      "| --- | --- |",
      ...Array.from({ length: 20 }, (_, i) => `line ${i + 1}`),
    ].join("\n");
    const lines = slackSummary(long).split("\n");
    expect(lines).toHaveLength(SUMMARY_MAX_LINES + 1);
    expect(lines.at(-1)).toBe("_9 more lines_");
    expect(lines).not.toContain("| --- | --- |");
  });

  it("stays under Slack's section text limit", () => {
    expect(slackSummary("x".repeat(10_000)).length).toBeLessThan(3_000);
    expect(slackSummary(Array.from({ length: 12 }, () => "y".repeat(390)).join("\n")).length).toBeLessThan(
      3_000,
    );
  });
});

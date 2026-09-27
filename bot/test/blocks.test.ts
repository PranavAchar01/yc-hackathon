import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  currentStep,
  formatDuration,
  learnedCard,
  learnedHeadline,
  openLabel,
  type RunView,
  resultLines,
  resultUrl,
  runCard,
  SUMMARY_MAX_LINES,
  sentThreadReply,
  shortReason,
  slackSummary,
  teachLearnedCard,
  teachRecordingCard,
  verbTitle,
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

const triage: Procedure = {
  name: "triage",
  title: "Triage new issues",
  description: "Label open issues",
  teacher: "Jordan Lee",
  demonstrations: 1,
  steps: ["Open issues", "Read each", "Pick labels", "Apply labels", "Check", "Finish"],
};

const texts = (blocks: unknown[]) =>
  blocks.flatMap((b) => {
    const j = JSON.stringify(b);
    return [...j.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  });

describe("run card (Apple style)", () => {
  it("running: one verb line, the live image, and Step n of N with the clock. No step list.", () => {
    const card = runCard(
      view({
        procedure: triage,
        steps: ["done", "done", "running", "pending", "pending", "pending"],
        elapsedMs: 42_000,
        liveImageFileId: "F123",
      }),
    );
    expect(card.blocks.map((b) => b.type)).toEqual(["section", "image", "context"]);
    expect(texts(card.blocks)).toEqual(["◐  *Triaging issues*", "Step 3 of 6  ·  0:42"]);
    expect(allText(card.blocks)).toContain('"slack_file":{"id":"F123"}');
    expect(allText(card.blocks)).not.toContain("Read each");
  });

  it("running with the live relay uses a video block to the player", () => {
    const card = runCard(
      view({
        procedure: triage,
        liveImageFileId: "F1",
        liveVideo: {
          url: "https://x.vercel.app/live?run=abc",
          thumbnailUrl: "https://x.vercel.app/api/live/abc?frame=1",
        },
      }),
    );
    const video = card.blocks.find((b) => b.type === "video");
    expect(video).toMatchObject({
      type: "video",
      video_url: "https://x.vercel.app/live?run=abc",
      thumbnail_url: "https://x.vercel.app/api/live/abc?frame=1",
      title: { type: "plain_text", text: "Triaging issues" },
    });
    expect(card.blocks.some((b) => b.type === "image")).toBe(false);
  });

  it("done: Done and the time, two result lines and an Open in GitHub link button", () => {
    const card = runCard(
      view({
        procedure: triage,
        phase: "done",
        elapsedMs: 86_000,
        summary:
          "Here is what I did:\n- Labeled #7 bug · P1\n- Labeled #8 perf · P2\n- Labeled #9 feature · P2\nhttps://github.com/PranavAchar01/over-the-shoulder/issues",
      }),
    );
    expect(texts(card.blocks)).toEqual([
      "✓  *Done  ·  1:26*",
      "Labeled #7 bug · P1\\nLabeled #8 perf · P2",
      "Open in GitHub",
    ]);
    expect(allText(card.blocks)).toContain(
      '"url":"https://github.com/PranavAchar01/over-the-shoulder/issues"',
    );
    expect(allText(card.blocks)).toContain(ACTIONS.openLink);
  });

  it("done without a summary still links to where the run started", () => {
    const card = runCard(
      view({ procedure: triage, phase: "done", startUrl: "https://github.com/x/y/issues" }),
    );
    expect(card.blocks.map((b) => b.type)).toEqual(["section", "actions"]);
    expect(allText(card.blocks)).toContain("https://github.com/x/y/issues");
  });

  it("failed: Stopped and one short reason", () => {
    const card = runCard(
      view({ phase: "failed", error: "bsk session start failed: no browser. Try again later.\nstack" }),
    );
    expect(texts(card.blocks)).toEqual(["*Stopped  ·  bsk session start failed: no browser*"]);
  });

  it("GTM review keeps only the Send button", () => {
    const card = runCard(view({ phase: "review", elapsedMs: 38_000, drafts: demoDrafts() }));
    const json = allText(card.blocks);
    expect(json).toContain("Done  ·  0:38");
    expect(json).toContain("12 drafts ready");
    const buttons = [...json.matchAll(/"action_id":"([^"]+)"/g)].map((m) => m[1]);
    expect(buttons).toEqual([ACTIONS.send]);
    expect(json).toContain('"style":"primary"');
  });

  it("sent: the count and time, no buttons", () => {
    const card = runCard(view({ phase: "sent", elapsedMs: 38_000, drafts: demoDrafts() }));
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(allText(card.blocks)).not.toContain("action_id");
    expect(card.text).toBe("12 emails sent.");
    expect(sentThreadReply(12, "Priya")).toBe("12 emails sent. Priya, done.");
  });

  it("escapes user text", () => {
    const evil = { ...gtm, name: "x", title: "<!channel> & co" };
    expect(allText(runCard(view({ procedure: evil })).blocks)).toContain("&lt;!channel&gt; &amp; co");
  });

  it("uses no em or en dashes anywhere in card copy", () => {
    const cards = [
      runCard(view({ phase: "review", drafts: demoDrafts() })),
      runCard(view({ phase: "sent", drafts: demoDrafts() })),
      runCard(view({ phase: "done", summary: "a\nb" })),
      runCard(view({ phase: "failed", error: "x" })),
      runCard(view({ phase: "needs_you", needsYou: "Needs you: sign in" })),
      learnedCard({ name: "release", steps: 5, draftId: "d", actionId: "a" }),
      teachLearnedCard({ procedure: gtm, memorableSaved: false, memorableNote: "not connected" }),
    ];
    for (const c of cards) expect(allText(c)).not.toMatch(/[\u2014\u2013]/);
  });
});

describe("run card helpers", () => {
  it("verb titles: known commands, imperative titles, and a calm fallback", () => {
    expect(verbTitle(triage)).toBe("Triaging issues");
    expect(verbTitle({ ...gtm, name: "notes", title: "Create the release" })).toBe("Creating the release");
    expect(verbTitle({ ...gtm, name: "tags", title: "Tag issues" })).toBe("Tagging issues");
    expect(verbTitle({ ...gtm, name: "bug-triage", title: "Bug triage sweep" })).toBe(
      "Running Bug triage sweep",
    );
  });

  it("current step is the first unfinished one", () => {
    expect(currentStep(["done", "running", "pending"])).toBe(2);
    expect(currentStep(["pending"])).toBe(1);
    expect(currentStep(["done", "done"])).toBe(2);
  });

  it("result lines drop preambles, bullets, markdown and links, and clip long lines", () => {
    expect(
      resultLines("## Result\n**Done**: [v0.2.0](https://github.com/x/y/releases/tag/v0.2.0)\n- two"),
    ).toEqual(["Result", "Done: v0.2.0"]);
    expect(resultLines(`- ${"x".repeat(100)}`)[0]).toHaveLength(60);
    expect(resultLines(undefined)).toEqual([]);
  });

  it("result URL prefers a GitHub release, issue or PR link", () => {
    expect(
      resultUrl(
        "see https://example.com/a and https://github.com/x/y/releases/tag/v1.",
        "https://github.com/x/y",
      ),
    ).toBe("https://github.com/x/y/releases/tag/v1");
    expect(resultUrl("nothing", "https://github.com/x/y")).toBe("https://github.com/x/y");
    expect(openLabel("https://vercel.com/x")).toBe("Open in Vercel");
    expect(openLabel("https://example.com")).toBe("Open");
  });

  it("short reasons are one line", () => {
    expect(shortReason(undefined)).toBe("something went wrong");
    expect(shortReason("a".repeat(200))).toHaveLength(70);
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
  it("shows at most two summary lines on a done card (the rest goes to the thread)", () => {
    const card = runCard(
      view({ phase: "done", summary: "Yesterday: merged #6\nToday: triage\nBlockers: None" }),
    );
    expect(allText(card.blocks)).toContain("Yesterday: merged #6\\nToday: triage");
    expect(allText(card.blocks)).not.toContain("Blockers");
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

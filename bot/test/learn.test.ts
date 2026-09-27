import { describe, expect, it } from "vitest";
import { learnedCard, learnWatchingCard } from "../src/blocks.ts";
import {
  cleanStartUrl,
  framePlan,
  frameTime,
  isDirectVideo,
  LEARN_MAX_FRAMES,
  LEARN_MAX_STEPS,
  parseLearned,
  parseVideoUrl,
  parseVtt,
} from "../src/learn.ts";
import { MetaSchema, publishModal } from "../src/modals.ts";

describe("/learn URL validation", () => {
  it("accepts public http(s) links, including Slack-wrapped ones", () => {
    for (const raw of [
      "https://www.youtube.com/watch?v=abc123",
      "https://www.loom.com/share/0123456789abcdef",
      "<https://youtu.be/abc123>",
      "<https://example.com/demo.mp4|demo.mp4>",
      "http://cdn.example.org/clip.mov",
    ])
      expect(parseVideoUrl(raw).ok, raw).toBe(true);
  });

  it("refuses non-http(s) schemes, junk and credentials", () => {
    for (const raw of [
      "",
      "file:///etc/passwd",
      "ftp://example.com/a.mp4",
      "javascript:alert(1)",
      "not a url",
      "https://user:pw@example.com/a.mp4",
    ])
      expect(parseVideoUrl(raw).ok, raw).toBe(false);
  });

  it("refuses local and private addresses", () => {
    for (const raw of [
      "http://localhost:3977/x.mp4",
      "http://127.0.0.1/x.mp4",
      "http://2130706433/x.mp4",
      "http://10.0.0.5/x.mp4",
      "http://172.20.1.1/x.mp4",
      "http://192.168.1.10/x.mp4",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/x.mp4",
      "http://nas.local/x.mp4",
    ])
      expect(parseVideoUrl(raw).ok, raw).toBe(false);
    expect(parseVideoUrl("http://172.32.0.1/x.mp4").ok).toBe(true);
  });

  it("spots direct video files", () => {
    expect(isDirectVideo(new URL("https://example.com/a/demo.MP4"))).toBe(true);
    expect(isDirectVideo(new URL("https://www.youtube.com/watch?v=abc"))).toBe(false);
  });
});

describe("frame sampling math", () => {
  it("takes one frame every 2 s for short videos", () => {
    expect(framePlan(30)).toEqual({ intervalS: 2, count: 15 });
    expect(framePlan(32)).toEqual({ intervalS: 2, count: 16 });
    expect(framePlan(1)).toEqual({ intervalS: 2, count: 1 });
  });

  it("spreads 16 frames evenly over longer videos", () => {
    const p = framePlan(600);
    expect(p).toEqual({ intervalS: 37.5, count: LEARN_MAX_FRAMES });
    expect(p.intervalS * p.count).toBeCloseTo(600);
    expect(framePlan(120).count).toBe(16);
    expect(framePlan(120).intervalS).toBeCloseTo(7.5);
  });

  it("falls back to the cap when the duration is unknown", () => {
    expect(framePlan(Number.NaN)).toEqual({ intervalS: 2, count: 16 });
    expect(framePlan(0)).toEqual({ intervalS: 2, count: 16 });
  });

  it("maps frame index to its time in the video", () => {
    const p = framePlan(600);
    expect(frameTime(p, 0)).toBe(19);
    expect(frameTime(p, 15)).toBe(581);
  });
});

describe("captions", () => {
  it("strips WebVTT timing, tags and rolling repeats", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:00.000 --> 00:00:02.000 align:start position:0%",
      "open the<00:00:01.000><c> issues</c> page",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "open the issues page",
      "then add the bug label",
      "",
      "3",
      "00:00:04.000 --> 00:00:06.000",
      "and P1 &amp; done",
    ].join("\n");
    expect(parseVtt(vtt)).toBe("open the issues page then add the bug label and P1 & done");
  });
});

describe("extraction parsing", () => {
  const raw = {
    title: "triage new issues",
    name: "Triage Issues!",
    description: "Label new issues.",
    steps: [
      "1. Open the issues page.",
      "- Filter to unlabeled issues",
      "Add a type label — bug or feature",
      "Add a priority label",
      "Add a priority label",
    ],
    startUrl: "https://github.com/PranavAchar01/over-the-shoulder/issues#top",
  };

  it("normalises title, name, steps and the start URL", () => {
    const x = parseLearned(raw, new URL("https://www.youtube.com/watch?v=abc"));
    expect(x.title).toBe("Triage new issues");
    expect(x.name).toBe("triage-issues");
    expect(x.steps).toEqual([
      "Open the issues page",
      "Filter to unlabeled issues",
      "Add a type label, bug or feature",
      "Add a priority label",
    ]);
    expect(x.startUrl).toBe("https://github.com/PranavAchar01/over-the-shoulder/issues");
  });

  it("caps steps at 10 and falls back when the name is reserved", () => {
    const x = parseLearned({
      ...raw,
      name: "learn",
      steps: Array.from({ length: 14 }, (_, i) => `Do thing ${i + 1}`),
    });
    expect(x.steps).toHaveLength(LEARN_MAX_STEPS);
    expect(x.name).toBe("triage-new-issues");
  });

  it("drops a start URL that is the video host, private or empty", () => {
    expect(cleanStartUrl("https://www.youtube.com/watch?v=x")).toBeNull();
    expect(cleanStartUrl("https://www.loom.com/share/abc")).toBeNull();
    expect(cleanStartUrl("http://localhost:3977/mock/")).toBeNull();
    expect(cleanStartUrl("")).toBeNull();
    expect(cleanStartUrl("vercel.com/phantom3452s-projects")).toBe(
      "https://vercel.com/phantom3452s-projects",
    );
    expect(
      cleanStartUrl("https://files.example.com/app", new URL("https://files.example.com/demo.mp4")),
    ).toBeNull();
  });

  it("refuses a video that showed no task", () => {
    expect(() => parseLearned({ ...raw, steps: ["Watch"] })).toThrow("too little");
    expect(() => parseLearned({ title: "x" })).toThrow();
  });
});

describe("Watching the recording card", () => {
  it("shows the verb line, a filmstrip of at most 8 frames and one tiny context line", () => {
    const card = learnWatchingCard({
      url: "https://www.loom.com/share/abc",
      phase: "reading",
      frames: 16,
      thumbFileIds: Array.from({ length: 10 }, (_, i) => `F${i}`),
    });
    const json = JSON.stringify(card.blocks);
    expect(card.text).toBe("Watching the recording");
    expect(json).toContain("◐  *Watching the recording*");
    expect(json).toContain("loom.com");
    expect(json).toContain("16 frames");
    const strip = card.blocks.find((b) => b.type === "context" && JSON.stringify(b).includes("slack_file"));
    expect(strip && "elements" in strip ? strip.elements.length : 0).toBe(8);
    expect(json).not.toMatch(/[–—]/);
  });

  it("learned card: name, step count and one Publish button", () => {
    const card = learnedCard({ name: "release", steps: 5, draftId: "d1", actionId: "open" });
    const json = JSON.stringify(card.blocks);
    expect(json).toContain("✓  *Learned /release  ·  5 steps*");
    expect(json).toContain('"text":"Publish"');
    expect(json).toContain('"value":"d1"');
  });

  it("carries the start URL into the Publish sheet", () => {
    const meta = MetaSchema.parse({
      mode: "learn",
      channel: "C1",
      frames: 20,
      startUrl: "https://github.com/x/y/issues",
    });
    const view = publishModal(
      { name: "triage", title: "Triage", description: "d", emoji: ":sparkles:", steps: ["a", "b", "c", "d"] },
      meta,
    );
    expect(JSON.stringify(view)).toContain("Starts at https://github.com/x/y/issues");
    expect(JSON.parse(view.private_metadata ?? "{}").startUrl).toBe("https://github.com/x/y/issues");
  });
});

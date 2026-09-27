import { describe, expect, it } from "vitest";
import { MAX_STEPS, parseExtraction, subsample } from "../src/extract.ts";

describe("parseExtraction", () => {
  it("normalises numbering, trailing periods, dashes and repeats", () => {
    const out = parseExtraction({
      title: "gtm launch emails.",
      description: "Use after launch \u2014 when deliverables arrive.",
      steps: [
        "1. Open the deliverables Priya forwarded.",
        "- pull the launch list",
        "Pull the launch list",
        "  ",
        "• Queue for review",
      ],
    });
    expect(out.title).toBe("Gtm launch emails");
    expect(out.description).toBe("Use after launch, when deliverables arrive");
    expect(out.steps).toEqual([
      "Open the deliverables Priya forwarded",
      "Pull the launch list",
      "Queue for review",
    ]);
    expect(out.description).not.toMatch(/[\u2014\u2013]/);
  });

  it("caps the number of steps", () => {
    const steps = Array.from({ length: 30 }, (_, i) => `Do thing ${i}`);
    expect(parseExtraction({ title: "x", description: "y", steps }).steps).toHaveLength(MAX_STEPS);
  });

  it("rejects malformed output", () => {
    expect(() => parseExtraction({ title: "x", steps: "not an array" })).toThrow();
    expect(() => parseExtraction(null)).toThrow();
  });

  it("rejects output with no usable steps", () => {
    expect(() => parseExtraction({ title: "x", description: "y", steps: ["", " . "] })).toThrow(
      /no usable steps/,
    );
  });
});

describe("subsample", () => {
  it("keeps everything when under the cap", () => {
    expect(subsample([1, 2, 3], 16)).toEqual([1, 2, 3]);
  });

  it("spreads evenly and keeps first and last", () => {
    const frames = Array.from({ length: 100 }, (_, i) => i);
    const picked = subsample(frames, 5);
    expect(picked).toEqual([0, 25, 50, 74, 99]);
    expect(new Set(picked).size).toBe(5);
  });
});

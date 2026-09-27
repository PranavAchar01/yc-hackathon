import { describe, expect, it } from "vitest";
import { publicCommand } from "../src/api.ts";
import { DYNAMIC_COMMAND, firstUploadedFileId } from "../src/app.ts";
import { normalizeDraft, suggestEmoji, suggestName } from "../src/draft.ts";
import { ScriptedExecutor } from "../src/executor/scripted.ts";
import { type CheckedExecutor, ResilientExecutor } from "../src/executor/select.ts";
import type { RunResult, RunTask } from "../src/executor/types.ts";
import { commandRow, homeView, publishedMessage } from "../src/home.ts";
import { MemoryLibrary } from "../src/library/memory.ts";
import type { CommandRecord } from "../src/library/types.ts";
import { describeModal, loadingModal, parsePublish, publishModal } from "../src/modals.ts";
import {
  CommandRegistrar,
  type Manifest,
  type ManifestApi,
  slashEntry,
  withSlashCommand,
} from "../src/registrar.ts";
import { CommandSearch, commandPage, GBrainIndex, parseGBrainHits, slugToName } from "../src/search.ts";

const rec = (over: Partial<CommandRecord> = {}): CommandRecord => ({
  name: "gtm",
  title: "GTM launch emails",
  description: "Send the launch emails",
  emoji: ":rocket:",
  steps: ["Open the deliverables", "Queue for review"],
  author: "UMARK",
  authorName: "Mark Ellis",
  visibility: "everyone",
  channelId: null,
  uses: 12,
  lastUsed: null,
  createdAt: new Date("2026-09-20T00:00:00Z"),
  registered: "slash",
  startUrl: null,
  ...over,
});
const text = (x: unknown) => JSON.stringify(x);

describe("manifest update payload", () => {
  const manifest: Manifest = {
    display_information: { name: "Over the Shoulder" },
    features: { slash_commands: [{ command: "/teach", description: "Teach", should_escape: false }] },
  };

  it("appends a new slash command and keeps everything else", () => {
    const out = withSlashCommand(manifest, slashEntry("standup", "Post the standup summary"));
    expect(out.ok && out.changed).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.display_information).toEqual({ name: "Over the Shoulder" });
    expect(out.manifest.features?.slash_commands?.map((c) => c.command)).toEqual(["/teach", "/standup"]);
    expect(out.manifest.features?.slash_commands?.[1]).toEqual({
      command: "/standup",
      description: "Post the standup summary",
      usage_hint: "",
      should_escape: false,
    });
    expect(manifest.features?.slash_commands).toHaveLength(1); // input untouched
  });

  it("is a no-op when already registered with the same description", () => {
    const once = withSlashCommand(manifest, slashEntry("standup", "x"));
    if (!once.ok) throw new Error("unexpected");
    const twice = withSlashCommand(once.manifest, slashEntry("standup", "x"));
    expect(twice.ok && twice.changed).toBe(false);
  });

  it("refuses reserved, invalid and over-limit names", () => {
    expect(withSlashCommand(manifest, slashEntry("remind", "x")).ok).toBe(false);
    expect(withSlashCommand(manifest, slashEntry("teach", "x")).ok).toBe(false);
    expect(withSlashCommand(manifest, slashEntry("Bad Name", "x")).ok).toBe(false);
    const full: Manifest = {
      features: {
        slash_commands: Array.from({ length: 50 }, (_, i) => ({
          command: `/c${i}`,
          description: "d",
          should_escape: false,
        })),
      },
    };
    expect(withSlashCommand(full, slashEntry("one-more", "x")).ok).toBe(false);
  });

  it("truncates long descriptions for Slack", () => {
    expect(slashEntry("x", "a".repeat(300)).description.length).toBeLessThanOrEqual(100);
  });

  it("registrar exports, updates and falls back to the router", async () => {
    const calls: string[] = [];
    let stored: Manifest = manifest;
    const api: ManifestApi = {
      exportManifest: async () => {
        calls.push("export");
        return stored;
      },
      updateManifest: async (_id, m) => {
        calls.push("update");
        stored = m;
      },
    };
    const reg = new CommandRegistrar(api, "A123");
    expect(await reg.register("standup", "Post it")).toEqual({ registered: "slash" });
    expect(calls).toEqual(["export", "update"]);
    expect((await reg.register("remind", "x")).registered).toBe("router");
    expect((await new CommandRegistrar(null, undefined).register("x", "y")).registered).toBe("router");
    const broken = new CommandRegistrar(
      {
        exportManifest: async () => {
          throw Object.assign(new Error("boom"), { data: { error: "invalid_auth" } });
        },
        updateManifest: async () => {},
      },
      "A1",
    );
    expect(await broken.register("x", "y")).toEqual({ registered: "router", reason: "invalid_auth" });
  });
});

describe("modals", () => {
  const draft = {
    name: "gtm",
    title: "GTM launch emails",
    description: "Send them",
    emoji: ":rocket:",
    steps: ["A", "B"],
  };

  it("publish sheet has one Publish button, the teach title and smart defaults", () => {
    const v = publishModal(draft, { mode: "teach", channel: "C1", frames: 24 });
    expect(v.title.text).toBe("Here's what I learned");
    expect(v.submit?.text).toBe("Publish");
    expect(v.blocks.filter((b) => b.type === "input")).toHaveLength(5);
    expect(text(v)).toContain('"initial_value":"gtm"');
    expect(text(v)).toContain('"initial_value":"A\\nB"');
    expect(text(v)).toContain("This channel");
    expect(text(v)).toContain("2 steps from 1 demonstration, 24 frames");
    expect(v.title.text.length).toBeLessThanOrEqual(24);
  });

  it("omits This channel when there is no channel", () => {
    expect(text(publishModal(draft, { mode: "new" }))).not.toContain("This channel");
  });

  it("describe and loading modals are minimal", () => {
    const d = describeModal({ mode: "new" });
    expect(d.submit?.text).toBe("Draft it");
    expect(d.blocks.filter((b) => b.type === "input")).toHaveLength(1);
    expect(
      loadingModal("A very long title that overflows Slack", "Working").title.text.length,
    ).toBeLessThanOrEqual(24);
  });

  const state = (o: Record<string, string>) => ({
    name: { v: { value: o.name ?? "" } },
    description: { v: { value: o.description ?? "" } },
    emoji: { v: { selected_option: { value: o.emoji ?? ":rocket:" } } },
    steps: { v: { value: o.steps ?? "" } },
    visibility: { v: { selected_option: { value: o.visibility ?? "everyone" } } },
  });

  it("parses a valid submission and strips list markers", () => {
    const out = parsePublish(
      state({
        name: "/Standup",
        description: "Post it",
        steps: "1. Read threads\n- Draft summary\n\n",
        visibility: "channel",
      }),
      JSON.stringify({ mode: "new", title: "Daily standup" }),
    );
    expect(out).toEqual({
      ok: true,
      data: {
        name: "standup",
        title: "Daily standup",
        description: "Post it",
        emoji: ":rocket:",
        steps: ["Read threads", "Draft summary"],
        visibility: "channel",
      },
    });
  });

  it("returns block errors for bad input", () => {
    const out = parsePublish(state({ name: "remind", description: "", steps: "" }), "{}");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(Object.keys(out.errors).sort()).toEqual(["description", "name", "steps"]);
  });
});

describe("drafts", () => {
  it("suggests names and emoji", () => {
    expect(suggestName("GTM launch emails", "gtm")).toBe("gtm");
    expect(suggestName("Weekly metrics digest")).toBe("weekly-metrics-digest");
    expect(suggestName("Remind", "remind")).not.toBe("remind");
    expect(suggestEmoji("launch emails")).toBe(":rocket:");
    expect(suggestEmoji("nothing matches here")).toBe(":sparkles:");
  });

  it("normalises a model draft", () => {
    const d = normalizeDraft({
      name: "Weekly Metrics",
      title: "weekly metrics digest",
      description: "Post the digest.",
      emoji: ":bar_chart:",
      steps: ["1. Open the dashboard.", "Post the digest"],
    });
    expect(d).toEqual({
      name: "weekly-metrics",
      title: "Weekly metrics digest",
      description: "Post the digest",
      emoji: ":bar_chart:",
      steps: ["Open the dashboard", "Post the digest"],
    });
  });
});

describe("App Home and /commands", () => {
  it("renders search, the three groups and empty states", () => {
    const v = homeView({ query: "", results: null, popular: [rec()], teammates: [], yours: [] });
    const t = text(v);
    expect(v.type).toBe("home");
    expect(t).toContain("Popular on your team");
    expect(t).toContain("New to you");
    expect(t).toContain("*Yours*");
    expect(t).toContain("dispatch_action");
    expect(t).toContain("*/gtm*");
    expect(t).toContain("Mark Ellis  ·  12 runs");
    expect(v.blocks.length).toBeLessThanOrEqual(100);
  });

  it("shows results with the query kept in the box", () => {
    const t = text(homeView({ query: "launch", results: [rec()], popular: [], teammates: [], yours: [] }));
    expect(t).toContain('Results for \\"launch\\"');
    expect(t).toContain('"initial_value":"launch"');
  });

  it("uses the router when not registered", () => {
    expect(text(commandRow(rec({ registered: "router" })))).toContain("/do gtm");
  });

  it("confirms a publish", () => {
    const m = publishedMessage(rec(), { memorable: true, gbrain: false });
    expect(m.text).toBe("Published /gtm. Anyone can run it now.");
    expect(text(m.blocks)).toContain("saved to Library, Memorable");
  });
});

describe("search", () => {
  const lib = new MemoryLibrary();
  const ready = (async () => {
    await lib.upsert({ ...rec(), name: "gtm" });
    await lib.upsert({
      ...rec(),
      name: "standup",
      title: "Daily standup",
      description: "Post the standup summary",
    });
    await lib.upsert({ ...rec(), name: "hidden", title: "Hidden", visibility: "me", author: "UX" });
  })();

  it("parses GBrain JSON hits into command names", () => {
    const out =
      'warning line\n[{"slug":"gtm","title":"GTM","score":1.2},{"slug":"commands/standup"},{"slug":"gtm"}]';
    expect(parseGBrainHits(out)).toEqual(["gtm", "standup"]);
    expect(slugToName("commands/gtm.md")).toBe("gtm");
    expect(parseGBrainHits("no json")).toEqual([]);
  });

  it("writes a GBrain page per command", () => {
    const page = commandPage(rec());
    expect(page.startsWith("---\ntitle: ")).toBe(true);
    expect(page).toContain("Slash command: /gtm");
    expect(page).toContain("1. Open the deliverables");
  });

  it("uses GBrain when it answers, filtered by visibility", async () => {
    await ready;
    const gb = new GBrainIndex(["gbrain"], "/tmp/unused", async (argv) =>
      argv[1] === "search"
        ? { code: 0, stdout: '[{"slug":"hidden"},{"slug":"gtm"}]', stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const out = await new CommandSearch(lib, gb).search({ userId: "UNEW" }, "send launch emails");
    expect(out).toEqual({ results: [expect.objectContaining({ name: "gtm" })], engine: "gbrain" });
  });

  it("falls back to the library when GBrain is down", async () => {
    await ready;
    const gb = new GBrainIndex(["gbrain"], "/tmp/unused", async () => ({
      code: 127,
      stdout: "",
      stderr: "not found",
    }));
    const out = await new CommandSearch(lib, gb).search({ userId: "UNEW" }, "standup summary");
    expect(out.engine).toBe("memory");
    expect(out.results[0]?.name).toBe("standup");
    const none = await new CommandSearch(lib, null).search({ userId: "UNEW" }, "send launch emails");
    expect(none.results[0]?.name).toBe("gtm");
  });
});

describe("ResilientExecutor (stage safety)", () => {
  const task: RunTask = {
    procedure: {
      name: "ship",
      title: "Ship",
      description: "d",
      steps: ["a", "b"],
      teacher: "Mark Ellis",
      demonstrations: 1,
    },
    userId: "U1",
    threadRef: "t",
    extra: "",
  };
  const scripted = new ScriptedExecutor(async () => {});
  const primary = (healthy: boolean, run: () => Promise<RunResult>): CheckedExecutor => ({
    name: "bsk",
    healthy: async () => healthy,
    run,
  });
  const ok: RunResult = { elapsedMs: 1, drafts: [], executedBy: "bsk" };

  it("uses the primary when healthy", async () => {
    expect(
      (
        await new ResilientExecutor(
          primary(true, async () => ok),
          scripted,
          () => false,
        ).run(task, () => {})
      ).executedBy,
    ).toBe("bsk");
  });

  it("silently uses scripted when red, forced, or failing mid-run", async () => {
    const red = new ResilientExecutor(
      primary(false, async () => ok),
      scripted,
      () => false,
    );
    expect((await red.run(task, () => {})).executedBy).toBe("scripted");
    const forced = new ResilientExecutor(
      primary(true, async () => ok),
      scripted,
      () => true,
    );
    expect((await forced.run(task, () => {})).executedBy).toBe("scripted");
    const boom = new ResilientExecutor(
      primary(true, async () => {
        throw new Error("sandbox died");
      }),
      scripted,
      () => false,
    );
    const res = await boom.run(task, () => {});
    expect(res.executedBy).toBe("scripted");
    expect(res.drafts).toEqual([]); // non-gtm procedures finish with a summary, not fake emails
  });

  it("does not fall back when the run needs a human", async () => {
    const needs = new ResilientExecutor(
      primary(true, async () => ({ ...ok, needsYou: "Needs you: sign in" })),
      scripted,
      () => false,
    );
    expect((await needs.run(task, () => {})).needsYou).toBe("Needs you: sign in");
  });
});

describe("misc", () => {
  it("routes only published commands to the dynamic handler", () => {
    expect(DYNAMIC_COMMAND.test("/gtm")).toBe(true);
    expect(DYNAMIC_COMMAND.test("/weekly-metrics")).toBe(true);
    for (const fixed of ["/teach", "/new", "/do", "/ots", "/commands"])
      expect(DYNAMIC_COMMAND.test(fixed)).toBe(false);
    expect(DYNAMIC_COMMAND.test("/teacher")).toBe(true);
  });

  it("extracts the file id from files.uploadV2 responses", () => {
    expect(firstUploadedFileId({ files: [{ ok: true, files: [{ id: "F123" }] }] })).toBe("F123");
    expect(firstUploadedFileId({ files: [{ id: "F9" }] })).toBe("F9");
    expect(firstUploadedFileId({})).toBeUndefined();
  });

  it("public API shape has no Slack ids", () => {
    const p = publicCommand(rec());
    expect(p).toMatchObject({ name: "gtm", invoke: "/gtm", author: "Mark Ellis", uses: 12 });
    expect(JSON.stringify(p)).not.toContain("UMARK");
  });
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  App,
  type BlockAction,
  type ButtonAction,
  LogLevel,
  type MessageShortcut,
  type PlainTextInputAction,
  type RespondFn,
  type SlashCommand,
} from "@slack/bolt";
import {
  ACTIONS,
  type Card,
  firstName,
  notFoundCard,
  procedureBlocks,
  type RunView,
  reviewAllBlocks,
  runCard,
  sentLine,
  sentThreadReply,
  teachFailedCard,
  teachLearnedCard,
  teachLearningCard,
  teachRecordingCard,
  teachReviewCard,
} from "./blocks.ts";
import { ScreenRecorder } from "./capture.ts";
import type { Config } from "./config.ts";
import { type CommandDrafter, type Draft, suggestEmoji, suggestName } from "./draft.ts";
import type { Executor } from "./executor/types.ts";
import type { StepExtractor } from "./extract.ts";
import { MAX_FRAMES, subsample } from "./extract.ts";
import type { GmailSender } from "./gmail-send.ts";
import { commandsMessage, HOME_SEARCH, homeView, publishedMessage } from "./home.ts";
import { type CommandLibrary, type CommandRecord, canSee, invocation } from "./library/types.ts";
import { log } from "./log.ts";
import {
  CALLBACKS,
  describeModal,
  errorModal,
  loadingModal,
  MetaSchema,
  parsePublish,
  parseSentence,
  publishModal,
  type SheetMeta,
} from "./modals.ts";
import { loadSkill, type Procedure, skillPath, toSkillName } from "./procedure.ts";
import type { Publisher } from "./publish.ts";
import type { CommandSearch } from "./search.ts";

type WebClient = App["client"];

export interface Deps {
  config: Config;
  executor: Executor;
  extractor: StepExtractor | null;
  drafter: CommandDrafter | null;
  library: CommandLibrary;
  search: CommandSearch;
  publisher: Publisher;
  /** Optional link to watch the run live, shown on browser runs. */
  liveUrl?: string;
  /** Real Gmail sends to test plus-addresses. Absent = Send is demo-only. */
  sender?: GmailSender;
  /** Turn a run's screenshots into the command's library video (background, best effort). */
  publishVideo?: (command: string, framesDir: string) => Promise<void>;
}

/** Commands this app handles itself. Everything else that reaches us is a published command. */
export const FIXED_COMMANDS = ["teach", "new", "do", "ots", "commands"] as const;
export const DYNAMIC_COMMAND = new RegExp(`^/(?!(?:${FIXED_COMMANDS.join("|")})$)[a-z0-9][a-z0-9_-]*$`);
const OPEN_SHEET = "ots_open_sheet";

/** Serialises chat.update calls for one message so ticks never land out of order. */
class LiveCard {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: WebClient,
    readonly channel: string,
    readonly ts: string,
  ) {}

  update(card: Card): Promise<void> {
    this.chain = this.chain
      .then(() => this.send(card.blocks, card.text))
      .catch(async (err: unknown) => {
        // A just-uploaded screenshot is not usable until Slack finishes processing it, and Slack then rejects
        // the whole card (invalid_blocks). The step ticks matter more: resend without the image; the next
        // update shows it once it is ready.
        const withoutImage = card.blocks.filter((b) => b.type !== "image");
        if (withoutImage.length !== card.blocks.length && /invalid_blocks/.test(String(err))) {
          await this.send(withoutImage, card.text).catch((e: unknown) =>
            log.warn("chat.update failed", e instanceof Error ? e.message : e),
          );
          return;
        }
        log.warn("chat.update failed", err instanceof Error ? err.message : err);
      });
    return this.chain;
  }

  private async send(blocks: Card["blocks"], text: string): Promise<void> {
    await this.client.chat.update({ channel: this.channel, ts: this.ts, text, blocks });
  }
}

async function postCard(
  client: WebClient,
  channel: string,
  card: Card,
  respond: RespondFn,
): Promise<LiveCard | null> {
  try {
    const res = await client.chat.postMessage({ channel, text: card.text, blocks: card.blocks });
    if (!res.ts || !res.channel) throw new Error("postMessage returned no ts");
    return new LiveCard(client, res.channel, res.ts);
  } catch (err) {
    log.warn("could not post card", err instanceof Error ? err.message : String(err));
    await respond({
      response_type: "ephemeral",
      text: "I can't post here. Invite me to this channel, or use a public channel.",
    });
    return null;
  }
}

/** "mark.ellis" -> "Mark Ellis". Slash payloads carry the handle, and we avoid the users:read scope. */
export function displayNameFromHandle(handle: string): string {
  return handle
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function toProcedure(c: CommandRecord): Procedure {
  return {
    name: c.name,
    title: c.title,
    description: c.description,
    steps: c.steps,
    teacher: c.authorName,
    demonstrations: 1,
  };
}

/** files.uploadV2 nests the uploaded file ids; dig the first one out without trusting the shape. */
export function firstUploadedFileId(res: unknown): string | undefined {
  const outer = (res as { files?: Array<{ files?: Array<{ id?: string }>; id?: string }> }).files ?? [];
  for (const f of outer) {
    if (typeof f.id === "string") return f.id;
    const inner = f.files?.find((x) => typeof x.id === "string");
    if (inner?.id) return inner.id;
  }
  return undefined;
}

interface TeachSession {
  id: string;
  skill: string | null;
  hint: string;
  userId: string;
  teacher: string;
  channel: string;
  card: LiveCard;
  recorder: ScreenRecorder;
  startedAt: number;
  ticker: NodeJS.Timeout;
}

export interface AppState {
  started: boolean;
}

export function createApp(deps: Deps): { app: App; state: AppState } {
  const { config, library } = deps;
  const state: AppState = { started: false };
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
    // On stage Wi-Fi, fail fast: the default policy retries for ~30 minutes and freezes whatever awaits it.
    clientOptions: {
      retryConfig: { retries: 2, factor: 1.5, minTimeout: 500, maxTimeout: 2_000 },
      timeout: 10_000,
    },
  });

  const teaching = new Map<string, TeachSession>();
  const pendingDrafts = new Map<string, { draft: Draft; meta: SheetMeta }>();
  const cards = new Map<string, LiveCard>();
  const runs = new Map<
    string,
    { view: RunView; card: LiveCard; skillFile: string; busy: boolean; framesDir?: string }
  >();

  // ================================================================ /teach [name]
  app.command("/teach", async ({ command, ack, respond, client }) => {
    await ack();
    const hint = command.text.trim();
    let skill: string | null = null;
    if (hint) {
      try {
        skill = toSkillName(hint);
      } catch (err) {
        await respond({ response_type: "ephemeral", text: err instanceof Error ? err.message : "Bad name" });
        return;
      }
    }
    if (teaching.size > 0) {
      await respond({
        response_type: "ephemeral",
        text: "Already watching one demonstration. Stop it first.",
      });
      return;
    }
    if (process.platform !== "darwin") {
      await respond({ response_type: "ephemeral", text: "Teaching needs the bot running on a Mac." });
      return;
    }
    const id = randomUUID();
    const label = skill ?? "new command";
    const card = await postCard(
      client,
      command.channel_id,
      teachRecordingCard({ skill: label, sessionId: id, elapsedMs: 0, frames: 0 }),
      respond,
    );
    if (!card) return;
    const recorder = new ScreenRecorder();
    const startedAt = Date.now();
    const session: TeachSession = {
      id,
      skill,
      hint,
      userId: command.user_id,
      teacher: displayNameFromHandle(command.user_name),
      channel: command.channel_id,
      card,
      recorder,
      startedAt,
      ticker: setInterval(() => {
        void card.update(
          teachRecordingCard({
            skill: label,
            sessionId: id,
            elapsedMs: Date.now() - startedAt,
            frames: recorder.frameCount,
          }),
        );
      }, 5_000),
    };
    teaching.set(id, session);
    try {
      await recorder.start();
      log.info(`teach ${label}: recording started by ${command.user_id}`);
    } catch (err) {
      clearInterval(session.ticker);
      teaching.delete(id);
      await card.update(
        teachFailedCard({ skill: label, reason: err instanceof Error ? err.message : "capture failed" }),
      );
    }
  });

  app.action<BlockAction<ButtonAction>>(ACTIONS.teachStop, async ({ ack, action, body, client }) => {
    await ack();
    const s = teaching.get(action.value ?? "");
    if (!s) return;
    if (body.user.id !== s.userId) {
      if (body.channel?.id)
        await client.chat.postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: "Only the person teaching can stop this recording.",
        });
      return;
    }
    teaching.delete(s.id);
    clearInterval(s.ticker);
    // Open the sheet right away (trigger ids expire in 3 s) and fill it when the steps are ready.
    const opened = await client.views
      .open({
        trigger_id: body.trigger_id,
        view: loadingModal("Here's what I learned", "Learning from your demonstration"),
      })
      .catch(() => null);
    await finishTeaching(s, client, opened?.view?.id);
  });

  async function finishTeaching(
    s: TeachSession,
    client: WebClient,
    viewId: string | undefined,
  ): Promise<void> {
    const label = s.skill ?? "new command";
    const frames = await s.recorder.stop();
    await s.card.update(teachLearningCard({ skill: label, frames: frames.length }));
    try {
      if (frames.length < 2) throw new Error("too few frames; record for a few seconds at least");
      if (!deps.extractor)
        throw new Error("no LLM key: add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to Keychain");
      const picked = subsample(frames, MAX_FRAMES);
      await ScreenRecorder.shrink(picked);
      const x = await deps.extractor.extract(picked, s.hint || "a task");
      const draft: Draft = {
        name: s.skill ?? suggestName(x.title),
        title: x.title,
        description: x.description,
        emoji: suggestEmoji(`${s.hint} ${x.title} ${x.description}`),
        steps: x.steps,
      };
      const meta: SheetMeta = { mode: "teach", channel: s.channel, cardTs: s.card.ts, frames: frames.length };
      const draftId = randomUUID();
      pendingDrafts.set(draftId, { draft, meta });
      cards.set(s.card.ts, s.card);
      await s.card.update(
        teachReviewCard({ title: x.title, steps: x.steps.length, draftId, actionId: OPEN_SHEET }),
      );
      if (viewId)
        await client.views
          .update({ view_id: viewId, view: publishModal(draft, meta) })
          .catch(() => undefined);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`teach ${label} failed:`, reason);
      await s.card.update(teachFailedCard({ skill: label, reason }));
      if (viewId)
        await client.views
          .update({ view_id: viewId, view: errorModal("Could not learn that", reason) })
          .catch(() => undefined);
    } finally {
      await s.recorder.dispose();
    }
  }

  app.action<BlockAction<ButtonAction>>(OPEN_SHEET, async ({ ack, action, body, client }) => {
    await ack();
    const pending = pendingDrafts.get(action.value ?? "");
    if (!pending) return;
    await client.views.open({ trigger_id: body.trigger_id, view: publishModal(pending.draft, pending.meta) });
  });

  // ================================================================ /new [sentence]
  async function draftInto(
    client: WebClient,
    viewId: string,
    meta: SheetMeta,
    make: (d: CommandDrafter) => Promise<Draft>,
  ) {
    try {
      if (!deps.drafter) throw new Error("no LLM key: add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to Keychain");
      const draft = await make(deps.drafter);
      await client.views.update({ view_id: viewId, view: publishModal(draft, meta) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("drafting failed:", reason);
      await client.views
        .update({ view_id: viewId, view: errorModal("Could not draft it", reason) })
        .catch(() => undefined);
    }
  }

  app.command("/new", async ({ command, ack, client }) => {
    await ack();
    const meta: SheetMeta = { mode: "new", channel: command.channel_id };
    const sentence = command.text.trim();
    if (!sentence) {
      await client.views.open({ trigger_id: command.trigger_id, view: describeModal(meta) });
      return;
    }
    const opened = await client.views.open({
      trigger_id: command.trigger_id,
      view: loadingModal("New command", "Drafting the steps"),
    });
    if (opened.view?.id) await draftInto(client, opened.view.id, meta, (d) => d.fromSentence(sentence));
  });

  app.view(CALLBACKS.describe, async ({ ack, body, view, client }) => {
    const sentence = parseSentence(view.state.values);
    if (!sentence) {
      await ack({ response_action: "errors", errors: { sentence: "Describe it in a sentence." } });
      return;
    }
    await ack({ response_action: "update", view: loadingModal("New command", "Drafting the steps") });
    const meta = MetaSchema.parse(JSON.parse(view.private_metadata || "{}"));
    await draftInto(client, body.view.id, meta, (d) => d.fromSentence(sentence));
  });

  // ================================================================ "Save as command" message shortcut
  app.shortcut<MessageShortcut>(CALLBACKS.saveShortcut, async ({ ack, shortcut, client }) => {
    await ack();
    const text = shortcut.message.text ?? "";
    const opened = await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: loadingModal("Save as command", "Turning this run into steps"),
    });
    const meta: SheetMeta = { mode: "save", channel: shortcut.channel.id };
    if (opened.view?.id) await draftInto(client, opened.view.id, meta, (d) => d.fromThread(text));
  });

  // ================================================================ Publish
  app.view(CALLBACKS.publish, async ({ ack, body, view, client }) => {
    const parsed = parsePublish(view.state.values, view.private_metadata);
    if (!parsed.ok) {
      await ack({ response_action: "errors", errors: parsed.errors });
      return;
    }
    const existing = await library.get(parsed.data.name).catch(() => null);
    if (existing && existing.author !== body.user.id) {
      await ack({
        response_action: "errors",
        errors: { name: `/${parsed.data.name} already belongs to ${existing.authorName}.` },
      });
      return;
    }
    await ack({ response_action: "clear" });
    const metaParsed = MetaSchema.safeParse(JSON.parse(view.private_metadata || "{}"));
    const m: SheetMeta = metaParsed.success ? metaParsed.data : { mode: "new" };
    const author = { id: body.user.id, name: displayNameFromHandle(body.user.name || body.user.id) };
    try {
      const out = await deps.publisher.publish({ ...parsed.data, channelId: m.channel ?? null, author });
      const msg = publishedMessage(out.command, out);
      if (m.channel)
        await client.chat
          .postEphemeral({ channel: m.channel, user: body.user.id, ...msg })
          .catch(() => undefined);
      else await client.chat.postMessage({ channel: body.user.id, ...msg });
      const card = m.cardTs ? cards.get(m.cardTs) : undefined;
      if (m.mode === "teach" && card) {
        await card.update(
          teachLearnedCard({
            procedure: toProcedure(out.command),
            memorableSaved: out.memorable,
            invoke: invocation(out.command),
          }),
        );
      }
    } catch (err) {
      log.error("publish failed:", err instanceof Error ? err.message : err);
      if (m.channel)
        await client.chat
          .postEphemeral({
            channel: m.channel,
            user: body.user.id,
            text: "Publishing failed. Check the bot log.",
          })
          .catch(() => undefined);
    }
  });

  // ================================================================ running a command
  async function resolveCommand(
    name: string,
    userId: string,
    channelId: string,
  ): Promise<{ procedure: Procedure; record: CommandRecord | null } | null> {
    const record = await library.get(name).catch(() => null);
    if (record && canSee(record, { userId, channelId })) return { procedure: toProcedure(record), record };
    const skill = await loadSkill(config.skillsDir, name).catch(() => null);
    return skill ? { procedure: skill, record: null } : null;
  }

  async function startRun(
    command: SlashCommand,
    respond: RespondFn,
    client: WebClient,
    skillRaw: string,
    extra: string,
  ) {
    let skill: string;
    try {
      skill = toSkillName(skillRaw);
    } catch {
      await respond({ response_type: "ephemeral", text: "Usage: `/do <command>`" });
      return;
    }
    const found = await resolveCommand(skill, command.user_id, command.channel_id);
    if (!found) {
      await respond({ response_type: "ephemeral", ...notFoundCard(skill) });
      return;
    }
    const { procedure, record } = found;
    const view: RunView = {
      runId: "",
      procedure,
      steps: procedure.steps.map(() => "pending"),
      notes: [],
      elapsedMs: 0,
      phase: "running",
      drafts: [],
      invoke: record ? invocation(record) : `/do ${procedure.name}`,
    };
    const card = await postCard(client, command.channel_id, runCard(view), respond);
    if (!card) return;
    view.runId = `${card.channel}:${card.ts}`;
    runs.set(view.runId, { view, card, skillFile: skillPath(config.skillsDir, skill), busy: false });

    const started = Date.now();
    let lastUpload = 0;
    let uploading = false;
    let executedBy: string = deps.executor.name;
    try {
      const result = await deps.executor.run(
        {
          procedure,
          userId: command.user_id,
          threadRef: view.runId,
          extra,
          startUrl: record?.startUrl ?? null,
        },
        async (ev) => {
          if (ev.kind === "step") {
            view.steps[ev.index] = ev.state;
            if (ev.note) view.notes[ev.index] = ev.note;
          } else if (ev.kind === "needs_you") {
            view.needsYou = ev.message;
          } else if (ev.kind === "screenshot") {
            if (deps.liveUrl) view.liveUrl = deps.liveUrl;
            // Throttle: one upload in flight, at most every 4 s.
            if (uploading || Date.now() - lastUpload < 4_000) return;
            uploading = true;
            lastUpload = Date.now();
            void (async () => {
              try {
                const up = await client.files.uploadV2({
                  file: await readFile(ev.path),
                  filename: basename(ev.path),
                  title: "Live view",
                });
                const id = firstUploadedFileId(up);
                if (id) view.liveImageFileId = id;
                view.elapsedMs = Date.now() - started;
                void card.update(runCard(view));
              } catch (err) {
                log.warn("screenshot upload failed", err instanceof Error ? err.message : err);
              } finally {
                uploading = false;
              }
            })();
            return;
          } else return;
          view.elapsedMs = Date.now() - started;
          void card.update(runCard(view));
        },
      );
      executedBy = result.executedBy;
      if (result.framesDir) {
        const entry = runs.get(view.runId);
        if (entry) entry.framesDir = result.framesDir;
        if (deps.publishVideo) void deps.publishVideo(skill, result.framesDir);
      }
      view.elapsedMs = result.elapsedMs;
      view.drafts = result.drafts;
      if (result.summary && result.drafts.length === 0) view.summary = result.summary;
      if (result.needsYou) view.needsYou = result.needsYou;
      view.phase = result.needsYou ? "needs_you" : result.drafts.length > 0 ? "review" : "done";
      log.info(
        `run ${skill}: ${view.phase} via ${result.executedBy} in ${Math.round(result.elapsedMs / 1000)} s`,
      );
    } catch (err) {
      view.phase = "failed";
      view.error = err instanceof Error ? err.message : String(err);
      view.steps = view.steps.map((s) => (s === "running" ? "failed" : s));
      log.error(`run ${skill} failed:`, view.error);
    }
    await card.update(runCard(view));
    if (record)
      await library
        .recordRun({
          command: record.name,
          userId: command.user_id,
          channelId: command.channel_id,
          executor: executedBy,
          status: view.phase === "failed" ? "failed" : "ok",
          elapsedMs: view.elapsedMs,
        })
        .catch((err: unknown) => log.warn("recordRun failed", err instanceof Error ? err.message : err));
  }

  const routerCommand =
    (usage: string) =>
    async ({
      command,
      ack,
      respond,
      client,
    }: {
      command: SlashCommand;
      ack: () => Promise<void>;
      respond: RespondFn;
      client: WebClient;
    }) => {
      await ack();
      const [skill = "", ...rest] = command.text.trim().split(/\s+/);
      if (!skill) {
        await respond({ response_type: "ephemeral", text: usage });
        return;
      }
      await startRun(command, respond, client, skill.replace(/^\//, ""), rest.join(" "));
    };
  app.command("/do", routerCommand("Usage: `/do <command>`, for example `/do gtm`"));
  app.command("/ots", routerCommand("Usage: `/ots <command>`"));

  // Every published command (/gtm, /ship, and whatever apps.manifest.update added) lands here.
  app.command(DYNAMIC_COMMAND, async ({ command, ack, respond, client }) => {
    await ack();
    await startRun(command, respond, client, command.command.slice(1), command.text.trim());
  });

  // ================================================================ /commands and App Home
  app.command("/commands", async ({ command, ack, respond }) => {
    await ack();
    const q = command.text.trim();
    const viewer = { userId: command.user_id, channelId: command.channel_id };
    const results = q ? (await deps.search.search(viewer, q, 8)).results : await library.popular(viewer, 8);
    await respond({ response_type: "ephemeral", ...commandsMessage(q, results) });
  });

  async function publishHome(client: WebClient, userId: string, query: string): Promise<void> {
    const viewer = { userId };
    const [results, popular, teammates, yours] = await Promise.all([
      query ? deps.search.search(viewer, query, 8).then((r) => r.results) : Promise.resolve(null),
      library.popular(viewer, 5),
      library.teammatesUseNotTried(viewer, 5),
      library.yours(viewer),
    ]);
    await client.views.publish({
      user_id: userId,
      view: homeView({ query, results, popular, teammates, yours }),
    });
  }

  app.event("app_home_opened", async ({ event, client }) => {
    if (event.tab !== "home") return;
    await publishHome(client, event.user, "").catch((err: unknown) =>
      log.warn("home publish failed", err instanceof Error ? err.message : err),
    );
  });

  app.action<BlockAction<PlainTextInputAction>>(HOME_SEARCH.action, async ({ ack, action, body, client }) => {
    await ack();
    await publishHome(client, body.user.id, (action.value ?? "").trim().slice(0, 200));
  });

  // ================================================================ final card buttons
  app.action<BlockAction<ButtonAction>>(ACTIONS.send, async ({ ack, action, client }) => {
    await ack();
    const run = runs.get(action.value ?? "");
    if (!run || run.busy || run.view.phase !== "review") return;
    run.busy = true;
    const reply = (text: string) =>
      client.chat
        .postMessage({ channel: run.card.channel, thread_ts: run.card.ts, text })
        .catch(() => undefined);
    if (!deps.sender) {
      // Demo only: nothing is sent. The card moves to its done state and we reply in thread.
      run.view.phase = "sent";
      await run.card.update(runCard(run.view));
      await reply(sentThreadReply(run.view.drafts.length, firstName(config.OTS_REQUESTER)));
      log.info(`run ${run.view.procedure.name}: Send pressed (demo, no email sent)`);
      return;
    }
    const total = run.view.drafts.length;
    await reply(`Sending ${total} through Gmail. Test addresses only.`);
    try {
      const res = await deps.sender.send(run.view.drafts, () => undefined, run.framesDir);
      // The clip now shows the whole job: drafting in the browser, then the real sends in Gmail.
      if (run.framesDir && deps.publishVideo) void deps.publishVideo(run.view.procedure.name, run.framesDir);
      run.view.phase = "sent";
      void run.card.update(runCard(run.view));
      await reply(
        res.failed.length
          ? `${sentLine(res.sent.length)} ${res.failed.length} did not go out: ${res.failed.map((f) => f.reason).join(", ")}.`
          : sentThreadReply(res.sent.length, firstName(config.OTS_REQUESTER)),
      );
    } catch (err) {
      run.busy = false;
      await reply(`Stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  app.action<BlockAction<ButtonAction>>(ACTIONS.reviewAll, async ({ ack, action, client }) => {
    await ack();
    const run = runs.get(action.value ?? "");
    if (!run) return;
    await client.chat.postMessage({
      channel: run.card.channel,
      thread_ts: run.card.ts,
      ...reviewAllBlocks(run.view.drafts),
    });
  });

  app.action<BlockAction<ButtonAction>>(ACTIONS.editProcedure, async ({ ack, action, body, client }) => {
    await ack();
    const run = runs.get(action.value ?? "");
    if (!run) return;
    await client.chat.postEphemeral({
      channel: run.card.channel,
      user: body.user.id,
      ...procedureBlocks(run.view.procedure, run.skillFile),
    });
  });

  app.error(async (err) => {
    log.error("bolt error", err.message);
  });

  return { app, state };
}

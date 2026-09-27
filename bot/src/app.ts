import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  type AgentId,
  type AgentMemory,
  agentName,
  lessonFrom,
  ownerOf,
  roster,
  route,
} from "./agents/team.ts";
import {
  ACTIONS,
  type Card,
  currentStep,
  firstName,
  formatClock,
  LEARN_THUMBS,
  learnedCard,
  learnWatchingCard,
  notFoundCard,
  procedureBlocks,
  type RunView,
  resultLines,
  reviewAllBlocks,
  runCard,
  sentLine,
  sentThreadReply,
  slackSummary,
  teachFailedCard,
  teachLearnedCard,
  teachLearningCard,
  teachRecordingCard,
  teachReviewCard,
  teamPlanBlocks,
  verbTitle,
} from "./blocks.ts";
import { ScreenRecorder } from "./capture.ts";
import type { Config } from "./config.ts";
import { type CommandDrafter, type Draft, suggestEmoji, suggestName } from "./draft.ts";
import type { Executor } from "./executor/types.ts";
import type { StepExtractor } from "./extract.ts";
import { MAX_FRAMES, subsample } from "./extract.ts";
import type { GmailSender } from "./gmail-send.ts";
import { commandsMessage, HOME_SEARCH, homeView, publishedMessage } from "./home.ts";
import { cleanStartUrl, parseVideoUrl, type VideoLearner } from "./learn.ts";
import { type CommandLibrary, type CommandRecord, canSee, invocation } from "./library/types.ts";
import { FramePump, type LiveRelay, newLiveRunId } from "./live.ts";
import type { LlmProvider } from "./llm.ts";
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
import { metered, totalTokens } from "./usage.ts";

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
  /** /learn: video link to command. Null when no LLM key is configured. */
  learner?: VideoLearner | null;
  /**
   * Turn a run's screenshots into its replay (a ~15 s mp4) and, when Blob is configured, the command's library
   * video. Resolves with the local mp4 (for the "Replay" thread reply) and its public URL. Best effort.
   */
  publishVideo?: (command: string, framesDir: string) => Promise<PublishedVideo | null>;
  /** Live video relay on the site. Absent: the card shows the screenshot image instead. */
  live?: LiveRelay | null;
  /** Memory scoped per worker agent (team mode). */
  memory?: AgentMemory | null;
  /** Model for the team router (cheap, structured). */
  routerLlm?: LlmProvider | null;
}

export interface PublishedVideo {
  mp4: string;
  videoUrl?: string;
  /** The run's last frame (JPEG): the replay tile's thumbnail. */
  posterUrl?: string;
  /** Length of the replay clip. */
  durationMs?: number;
}

/** Live view as a Slack image: one upload at a time, every 1.2 s, slower after a rate limit. */
export const LIVE_IMAGE_EVERY_MS = 1_200;
const LIVE_IMAGE_MAX_MS = 8_000;

/** Commands this app handles itself. Everything else that reaches us is a published command. */
export const FIXED_COMMANDS = ["teach", "new", "do", "ots", "commands", "learn"] as const;
export const DYNAMIC_COMMAND = new RegExp(`^/(?!(?:${FIXED_COMMANDS.join("|")})$)[a-z0-9][a-z0-9_-]*$`);
const OPEN_SHEET = "ots_open_sheet";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** chat.update is Tier 3 (about 50 a minute per workspace): keep one card at or under one update per 1.2 s. */
export const CARD_MIN_GAP_MS = 1_200;

const isMedia = (b: Card["blocks"][number]) =>
  b.type === "image" ||
  b.type === "video" ||
  (b.type === "context" && b.elements.some((e) => e.type === "image"));

/** Slack's rate-limit error from @slack/web-api, with the Retry-After seconds when it carries them. */
export function retryAfterMs(err: unknown): number | null {
  const e = err as { code?: string; retryAfter?: number; data?: { error?: string } };
  if (e?.code === "slack_webapi_rate_limited_error" || e?.data?.error === "ratelimited")
    return Math.max(1, e.retryAfter ?? 5) * 1_000;
  return null;
}

/**
 * One live message. Updates are coalesced (only the newest card is ever sent), spaced at least
 * CARD_MIN_GAP_MS apart, and paused for Retry-After on a 429. If Slack rejects the media (a just-uploaded
 * image that is still processing, or a video block the app is not allowed to post), the card goes out without
 * it and `onMediaRejected` hears why, so the caller can fall back.
 */
export class LiveCard {
  private pending: Card | null = null;
  private waiters: Array<() => void> = [];
  private running = false;
  private nextAt = 0;
  onMediaRejected?: (reason: string, hadVideo: boolean) => void;

  constructor(
    private readonly client: WebClient,
    readonly channel: string,
    readonly ts: string,
    private readonly minGapMs = CARD_MIN_GAP_MS,
  ) {}

  update(card: Card): Promise<void> {
    this.pending = card;
    const done = new Promise<void>((r) => this.waiters.push(r));
    if (!this.running) {
      this.running = true;
      void this.drain();
    }
    return done;
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      const card = this.pending;
      const waiters = this.waiters;
      this.pending = null;
      this.waiters = [];
      if (!card) break;
      const requeue = await this.sendSafely(card);
      if (requeue && !this.pending) {
        this.pending = card;
        this.waiters.push(...waiters);
        continue;
      }
      for (const w of waiters) w();
    }
    // No await between the loop check and this line, so an update() can never be stranded.
    this.running = false;
  }

  /** Returns true when the card should be retried after a rate-limit pause. */
  private async sendSafely(card: Card): Promise<boolean> {
    this.nextAt = Date.now() + this.minGapMs;
    try {
      await this.send(card.blocks, card.text);
      return false;
    } catch (err: unknown) {
      const retry = retryAfterMs(err);
      if (retry !== null) {
        this.nextAt = Date.now() + retry;
        log.warn(`chat.update rate limited; pausing ${Math.round(retry / 1000)} s`);
        return true;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const withoutMedia = card.blocks.filter((b) => !isMedia(b));
      if (withoutMedia.length !== card.blocks.length && /invalid_blocks|invalid_arguments|embed/i.test(msg)) {
        const hadVideo = card.blocks.some((b) => b.type === "video");
        this.onMediaRejected?.(msg, hadVideo);
        await this.send(withoutMedia, card.text).catch((e: unknown) =>
          log.warn("chat.update failed", e instanceof Error ? e.message : e),
        );
        return false;
      }
      log.warn("chat.update failed", msg);
      return false;
    }
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

  // ================================================================ /learn <video url> [on <site url>]
  app.command("/learn", async ({ command, ack, respond, client }) => {
    await ack();
    // "on <url>": the video teaches the task, this is where yours runs (a tutorial usually shows someone else's repo).
    const [videoText = "", target] = command.text.trim().split(/\s+on\s+/i);
    const targetUrl = target ? cleanStartUrl(target) : null;
    const check = parseVideoUrl(videoText);
    if (!check.ok) {
      await respond({ response_type: "ephemeral", text: check.reason });
      return;
    }
    if (!deps.learner) {
      await respond({
        response_type: "ephemeral",
        text: "No LLM key: add OPENAI_API_KEY (or ANTHROPIC_API_KEY) to Keychain.",
      });
      return;
    }
    const url = check.url.toString();
    const t0 = Date.now();
    const state = {
      url,
      phase: "downloading" as Parameters<typeof learnWatchingCard>[0]["phase"],
      frames: 0,
      thumbFileIds: [] as string[],
    };
    const card = await postCard(client, command.channel_id, learnWatchingCard(state), respond);
    if (!card) return;
    const show = () => card.update(learnWatchingCard(state));
    let dir: string | undefined;
    try {
      const out = await deps.learner.learn(
        check.url,
        (p) => {
          if (p.phase === "done") return;
          state.phase = p.phase;
          if (p.frames) state.frames = p.frames.length;
          void show();
          if (p.phase === "reading" && p.frames) {
            // Filmstrip: uploaded in parallel while the model reads, never in its way.
            const picks = subsample(p.frames, LEARN_THUMBS);
            void Promise.all(
              picks.map((f) =>
                readFile(f)
                  .then((file) => client.files.uploadV2({ file, filename: basename(f), title: "Frame" }))
                  .then(firstUploadedFileId)
                  .catch(() => undefined),
              ),
            ).then((ids) => {
              state.thumbFileIds = ids.filter((id): id is string => !!id);
              void show();
            });
          }
        },
        targetUrl ?? undefined,
      );
      dir = out.dir;
      const x = out.learned;
      const draft: Draft = {
        name: x.name,
        title: x.title,
        description: x.description,
        emoji: suggestEmoji(`${x.title} ${x.description}`),
        steps: x.steps,
      };
      const meta: SheetMeta = {
        mode: "learn",
        channel: command.channel_id,
        cardTs: card.ts,
        frames: out.frames.length,
        ...((targetUrl ?? x.startUrl) ? { startUrl: targetUrl ?? x.startUrl ?? undefined } : {}),
      };
      const draftId = randomUUID();
      pendingDrafts.set(draftId, { draft, meta });
      cards.set(card.ts, card);
      await card.update(learnedCard({ name: x.name, steps: x.steps.length, draftId, actionId: OPEN_SHEET }));
      log.info(
        `learn: ${x.name} from ${url} (${x.steps.length} steps, start ${targetUrl ?? x.startUrl ?? "none"}) in ${Math.round((Date.now() - t0) / 1000)} s`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`learn from ${url} failed:`, reason);
      await card.update(teachFailedCard({ skill: "learn", reason }));
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
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
      const out = await deps.publisher.publish({
        ...parsed.data,
        channelId: m.channel ?? null,
        author,
        ...(m.startUrl ? { startUrl: m.startUrl } : {}),
      });
      const msg = publishedMessage(out.command, out);
      if (m.channel)
        await client.chat
          .postEphemeral({ channel: m.channel, user: body.user.id, ...msg })
          .catch(() => undefined);
      else await client.chat.postMessage({ channel: body.user.id, ...msg });
      const card = m.cardTs ? cards.get(m.cardTs) : undefined;
      if ((m.mode === "teach" || m.mode === "learn") && card) {
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
  ): Promise<RunView | null> {
    let skill: string;
    try {
      skill = toSkillName(skillRaw);
    } catch {
      await respond({ response_type: "ephemeral", text: "Usage: `/do <command>`" });
      return null;
    }
    const found = await resolveCommand(skill, command.user_id, command.channel_id);
    if (!found) {
      await respond({ response_type: "ephemeral", ...notFoundCard(skill) });
      return null;
    }
    const { procedure, record } = found;
    // The worker agent that owns this skill runs it, with only its own memory.
    const owner = record ? ownerOf(record) : null;
    const memory = owner && deps.memory ? await deps.memory.recall(owner).catch(() => undefined) : undefined;
    const view: RunView = {
      runId: "",
      procedure,
      steps: procedure.steps.map(() => "pending"),
      notes: [],
      elapsedMs: 0,
      phase: "running",
      drafts: [],
      invoke: record ? invocation(record) : `/do ${procedure.name}`,
      ...(record?.startUrl ? { startUrl: record.startUrl } : {}),
      ...(owner ? { agent: agentName(owner) } : {}),
    };
    const card = await postCard(client, command.channel_id, runCard(view), respond);
    if (!card) return null;
    view.runId = `${card.channel}:${card.ts}`;
    runs.set(view.runId, { view, card, skillFile: skillPath(config.skillsDir, skill), busy: false });

    const started = Date.now();
    // Once the live video is on the card, the card holds still until the run ends: Slack resets an inline
    // player that is playing whenever its message is updated. Progress travels with the frames instead.
    let still = false;
    const refresh = () => {
      view.elapsedMs = Date.now() - started;
      if (still && view.phase === "running") return Promise.resolve();
      return card.update(runCard(view));
    };

    // Live view, two ways. Video: frames go to the site relay and the card embeds the player (Block Kit video).
    // Image: a private files.uploadV2 every 1.2 s (no channel_id, so the file is never shared to the channel;
    // the bot owns it, which is what an image block's slack_file needs). Video falls back to image if Slack
    // rejects the video block.
    const title = verbTitle(procedure);
    const live = deps.live ?? null;
    const liveId = live ? newLiveRunId() : "";
    let mode: "video" | "image" = live ? "video" : "image";
    card.onMediaRejected = (reason, hadVideo) => {
      if (!hadVideo) return;
      log.warn(`video block rejected by Slack (${reason}); live view falls back to images`);
      mode = "image";
      still = false;
      delete view.liveVideo;
    };
    const pump =
      live &&
      new FramePump(
        (png) =>
          live.pushFrame(
            liveId,
            png,
            title,
            `Step ${currentStep(view.steps)} of ${procedure.steps.length}  ·  ${formatClock(Date.now() - started)}`,
          ),
        () => {
          if (mode !== "video" || view.phase !== "running") return;
          view.liveVideo = { url: live.playerUrl(liveId), thumbnailUrl: live.frameUrl(liveId) };
          void refresh();
          still = true;
        },
      );
    let imageEvery = LIVE_IMAGE_EVERY_MS;
    let lastUpload = 0;
    let uploading = false;
    const uploadImage = async (path: string) => {
      uploading = true;
      lastUpload = Date.now();
      try {
        const up = await client.files.uploadV2({
          file: await readFile(path),
          filename: basename(path),
          title: "Live view",
        });
        const id = firstUploadedFileId(up);
        if (id && view.phase === "running") {
          view.liveImageFileId = id;
          void refresh();
        }
        imageEvery = Math.max(LIVE_IMAGE_EVERY_MS, imageEvery * 0.9);
      } catch (err) {
        const retry = retryAfterMs(err);
        imageEvery = Math.min(LIVE_IMAGE_MAX_MS, retry ?? imageEvery * 2);
        log.warn("screenshot upload failed", err instanceof Error ? err.message : err);
      } finally {
        uploading = false;
      }
    };

    let executedBy: string = deps.executor.name;
    let framesDir: string | undefined;
    try {
      const { result, usage } = await metered(() =>
        deps.executor.run(
          {
            procedure,
            userId: command.user_id,
            threadRef: view.runId,
            extra,
            startUrl: record?.startUrl ?? null,
            ...(owner ? { agent: agentName(owner) } : {}),
            ...(memory ? { memory } : {}),
          },
          async (ev) => {
            if (ev.kind === "step") {
              view.steps[ev.index] = ev.state;
              if (ev.note) view.notes[ev.index] = ev.note;
              void refresh();
            } else if (ev.kind === "needs_you") {
              view.needsYou = ev.message;
            } else if (ev.kind === "screenshot") {
              if (pump && mode === "video") pump.offer(ev.path);
              else if (!uploading && Date.now() - lastUpload >= imageEvery) void uploadImage(ev.path);
            }
          },
        ),
      );
      view.usage = usage;
      executedBy = result.executedBy;
      framesDir = result.framesDir;
      if (framesDir) {
        const entry = runs.get(view.runId);
        if (entry) entry.framesDir = framesDir;
      }
      view.elapsedMs = result.elapsedMs;
      view.drafts = result.drafts;
      if (result.summary && result.drafts.length === 0) view.summary = result.summary;
      if (result.needsYou) view.needsYou = result.needsYou;
      view.phase = result.needsYou ? "needs_you" : result.drafts.length > 0 ? "review" : "done";
      log.info(
        `run ${skill}: ${view.phase} via ${result.executedBy} in ${Math.round(result.elapsedMs / 1000)} s, ${usage.calls} model calls, ${totalTokens(usage)} tokens`,
      );
      // The worker remembers what this run found, for next time.
      const lesson =
        owner && view.phase !== "needs_you"
          ? lessonFrom(
              skill,
              result.summary ?? (result.drafts.length ? `${result.drafts.length} drafts queued` : ""),
            )
          : null;
      if (owner && lesson && deps.memory) void deps.memory.learn(owner, lesson).catch(() => undefined);
    } catch (err) {
      view.phase = "failed";
      view.error = err instanceof Error ? err.message : String(err);
      view.steps = view.steps.map((s) => (s === "running" ? "failed" : s));
      log.error(`run ${skill} failed:`, view.error);
    }
    delete view.liveVideo;
    delete view.liveImageFileId;
    // Live video: the player shows "Done" on the last frame at once; the card changes once, when the replay is
    // ready, into the same tile playing the replay (final frame as its thumbnail).
    const streamed = !!(live && pump && pump.seq > 0 && mode === "video");
    const finalState = view.phase === "failed" ? ("failed" as const) : ("done" as const);
    let video: Awaited<ReturnType<NonNullable<typeof deps.publishVideo>>> = null;
    if (streamed && live) {
      await live.finish(liveId, { state: finalState });
      video = framesDir && deps.publishVideo ? await deps.publishVideo(skill, framesDir) : null;
      if (video?.videoUrl) {
        await live.finish(liveId, { state: finalState, replayUrl: video.videoUrl });
        if ((view.phase === "done" || view.phase === "review") && video.posterUrl)
          view.replay = { url: live.playerUrl(liveId), thumbnailUrl: video.posterUrl };
        // Someone watching sees the stream fade into the replay; let it play once before the card update
        // (which resets Slack's player) turns the tile into the replay with the final frame.
        await new Promise((r) => setTimeout(r, Math.min(13_000, (video?.durationMs ?? 8_000) + 1_000)));
      }
    }
    await card.update(runCard(view));
    const thread = (text: string) =>
      client.chat.postMessage({ channel: card.channel, thread_ts: card.ts, text }).catch(() => undefined);
    // The card shows two result lines; when the agent said more (a standup, a list), the rest goes in the thread.
    if (view.phase === "done" && view.summary && resultLines(view.summary, 99).length > 2)
      await thread(slackSummary(view.summary));
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

    // Without the live video, the replay goes in the thread as an mp4 (Slack plays it inline).
    if (!streamed) {
      video = framesDir && deps.publishVideo ? await deps.publishVideo(skill, framesDir) : null;
      // A GTM review run gets its replay after Send, when the clip also shows the real sends.
      if (video && !(view.phase === "review" && deps.sender)) await postReplay(client, card, video.mp4);
    }
    return view;
  }

  async function postReplay(client: WebClient, card: LiveCard, mp4: string): Promise<void> {
    const upload = async () =>
      client.files.uploadV2({
        channel_id: card.channel,
        thread_ts: card.ts,
        file: await readFile(mp4),
        filename: "replay.mp4",
        title: "Replay",
      });
    try {
      await upload();
    } catch (err) {
      // The card posts via chat:write.public, but sharing a file needs membership: join the public channel once.
      const code = (err as { data?: { error?: string } }).data?.error;
      try {
        if (code !== "not_in_channel") throw err;
        await client.conversations.join({ channel: card.channel });
        await upload();
      } catch (err2) {
        log.warn("replay upload failed", err2 instanceof Error ? err2.message : err2);
      }
    }
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

  // ================================================================ /team <request>: a team of agents
  // The router reads one line per skill and plans; each step runs on the worker agent that owns the skill, with
  // only that worker's memory; a worker's result is handed to the next worker (posted in the plan's thread).
  app.command("/team", async ({ command, ack, respond, client }) => {
    await ack();
    const request = command.text.trim();
    if (!request) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/team ship v1.3 and tell the launch list`",
      });
      return;
    }
    const llm = deps.routerLlm;
    if (!llm) {
      await respond({ response_type: "ephemeral", text: "No LLM key: add OPENAI_API_KEY to Keychain." });
      return;
    }
    const team = roster(await library.publicList("", 500));
    const planned = await metered(() => route(llm, team, request)).catch((err: unknown) => {
      log.error("router failed:", err instanceof Error ? err.message : err);
      return null;
    });
    if (!planned) {
      await respond({ response_type: "ephemeral", text: "The router could not plan that one." });
      return;
    }
    const { result: plan, usage: routerUsage } = planned;
    const lines = plan.steps.map((st, i) => `${i + 1}.  ${agentName(st.agent)}  →  \`/${st.skill}\``);
    const posted = await client.chat.postMessage({
      channel: command.channel_id,
      text: plan.reply,
      blocks: teamPlanBlocks(plan.reply, lines, routerUsage),
    });
    log.info(
      `team: "${request}" -> ${plan.steps.map((st) => `${st.agent}/${st.skill}`).join(" > ") || "no steps"} (router ${totalTokens(routerUsage)} tokens)`,
    );
    const say = (text: string) =>
      client.chat
        .postMessage({ channel: command.channel_id, thread_ts: posted.ts, text })
        .catch(() => undefined);
    let prev: { agent: AgentId; summary: string } | null = null;
    for (const st of plan.steps) {
      if (prev)
        await say(`*${agentName(prev.agent)} → ${agentName(st.agent)}:* ${prev.summary.split("\n")[0]}`);
      const extra = [st.note, prev ? `From the ${agentName(prev.agent)}: ${prev.summary}` : ""]
        .filter(Boolean)
        .join("\n");
      const view = await startRun(command, respond, client, st.skill, extra);
      if (!view || view.phase === "failed" || view.phase === "needs_you") {
        await say(`Stopped at ${agentName(st.agent)}.`);
        break;
      }
      prev = {
        agent: st.agent,
        summary:
          view.summary ?? (view.drafts.length ? `${view.drafts.length} drafts ready for review` : "done"),
      };
    }
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
      // Live: the same card streams Gmail doing the sends (compose, Send, "Message sent"). It updates once,
      // when the stream starts, and holds still until the sends are done (an update resets Slack's player).
      const started = Date.now();
      const live = deps.live ?? null;
      const sendId = live ? newLiveRunId() : "";
      let sent = 0;
      const framesDir = run.framesDir ?? (await mkdtemp(join(tmpdir(), "ots-send-")));
      const pump =
        live &&
        new FramePump(
          (png) =>
            live.pushFrame(
              sendId,
              png,
              `Sending ${total} emails`,
              `Email ${Math.min(sent + 1, total)} of ${total}  ·  ${formatClock(Date.now() - started)}`,
            ),
          () => {
            run.view.phase = "sending";
            run.view.liveVideo = { url: live.playerUrl(sendId), thumbnailUrl: live.frameUrl(sendId) };
            delete run.view.replay;
            void run.card.update(runCard(run.view));
          },
        );
      const res = await deps.sender.send(
        run.view.drafts,
        (p) => {
          sent = p.sent;
        },
        framesDir,
        pump ? (png) => pump.offer(png) : undefined,
      );
      log.info(
        `run ${run.view.procedure.name}: sent ${res.sent.length} through Gmail, ${res.failed.length} failed`,
      );
      delete run.view.liveVideo;
      // The replay is the whole job: drafting in the browser, then the real sends in Gmail.
      const video = deps.publishVideo ? await deps.publishVideo(run.view.procedure.name, framesDir) : null;
      if (live && pump && pump.seq > 0) {
        await live.finish(sendId, {
          state: "done",
          ...(video?.videoUrl ? { replayUrl: video.videoUrl } : {}),
        });
        if (video?.posterUrl)
          run.view.replay = { url: live.playerUrl(sendId), thumbnailUrl: video.posterUrl };
      } else if (video) void postReplay(client, run.card, video.mp4);
      run.view.phase = "sent";
      await run.card.update(runCard(run.view));
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

  // Link buttons open in the browser; Slack still sends the click and expects an ack.
  app.action(ACTIONS.openLink, async ({ ack }) => {
    await ack();
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

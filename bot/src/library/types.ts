export type Visibility = "me" | "channel" | "everyone";
export type Registration = "slash" | "router";

/** A published command. Postgres `commands` is the source of truth. */
export interface CommandRecord {
  name: string;
  title: string;
  description: string;
  emoji: string;
  steps: string[];
  /** Slack user id of the author. */
  author: string;
  authorName: string;
  visibility: Visibility;
  /** Channel it was published in, for visibility "channel". */
  channelId: string | null;
  uses: number;
  lastUsed: Date | null;
  createdAt: Date;
  /** Where the computer-use agent starts (e.g. https://github.com). Null = the local smoke-test page. */
  startUrl: string | null;
  /** "slash" once registered as a real /command via apps.manifest.update; "router" means use /do <name>. */
  registered: Registration;
}

export type NewCommand = Omit<CommandRecord, "uses" | "lastUsed" | "createdAt">;

export interface RunRecord {
  command: string;
  userId: string;
  channelId: string | null;
  executor: string;
  status: "ok" | "failed";
  elapsedMs: number | null;
  at?: Date;
}

/** Who is looking, for visibility filtering and "you haven't tried these". */
export interface Viewer {
  userId: string;
  channelId?: string;
}

export interface CommandLibrary {
  readonly kind: "postgres" | "memory";
  upsert(cmd: NewCommand): Promise<CommandRecord>;
  setRegistration(name: string, registered: Registration): Promise<void>;
  get(name: string): Promise<CommandRecord | null>;
  /** Most used first. */
  popular(viewer: Viewer, limit: number): Promise<CommandRecord[]>;
  /** Used by at least one teammate, never by the viewer, not authored by the viewer. Most teammates first. */
  teammatesUseNotTried(viewer: Viewer, limit: number): Promise<CommandRecord[]>;
  /** Authored by the viewer, newest first. */
  yours(viewer: Viewer): Promise<CommandRecord[]>;
  /** Full-text + trigram search (the fallback when GBrain is not up). */
  search(viewer: Viewer, query: string, limit: number): Promise<CommandRecord[]>;
  /** Only "everyone" commands; what the public JSON API serves. */
  publicList(query: string, limit: number): Promise<CommandRecord[]>;
  recordRun(run: RunRecord): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}

export function canSee(cmd: Pick<CommandRecord, "visibility" | "author" | "channelId">, v: Viewer): boolean {
  if (cmd.visibility === "everyone") return true;
  if (cmd.author === v.userId) return true;
  return cmd.visibility === "channel" && !!v.channelId && cmd.channelId === v.channelId;
}

/** How to invoke it: the real slash command when registered, else the router. */
export function invocation(cmd: Pick<CommandRecord, "name" | "registered">): string {
  return cmd.registered === "slash" ? `/${cmd.name}` : `/do ${cmd.name}`;
}

import { webApi } from "@slack/bolt";
import type { Registration } from "./library/types.ts";
import { log } from "./log.ts";

/**
 * Publishing turns a command into a REAL slash command by editing this app's manifest:
 *   apps.manifest.export { app_id }            -> current manifest
 *   apps.manifest.update { app_id, manifest }  -> same manifest plus the new features.slash_commands entry
 * Both need an app configuration token (xoxe.xoxp-..., from api.slack.com/apps > "Your App Configuration Tokens"),
 * which expires every 12 h; with a refresh token we rotate it via tooling.tokens.rotate.
 * In Socket Mode slash commands need no request URL, and adding one needs no new scope (we already have
 * `commands`), so no reinstall. Without a config token, publishing falls back to the `/do <name>` router.
 */

export interface SlashCommandEntry {
  command: string;
  description: string;
  usage_hint?: string;
  should_escape: boolean;
}

export interface Manifest {
  features?: { slash_commands?: SlashCommandEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

/** Slack's built-in commands plus our own fixed ones; a published command may not shadow these. */
export const RESERVED = new Set([
  "remind",
  "invite",
  "msg",
  "dm",
  "status",
  "away",
  "feed",
  "leave",
  "join",
  "mute",
  "topic",
  "who",
  "shrug",
  "me",
  "open",
  "search",
  "apps",
  "collapse",
  "expand",
  "active",
  "archive",
  "kick",
  "remove",
  "rename",
  "shortcuts",
  "prefs",
  "dnd",
  "call",
  "giphy",
  "poll",
  "help",
  "teach",
  "learn",
  "new",
  "do",
  "ots",
  "commands",
]);
export const MAX_SLASH_COMMANDS = 50;

export function slashEntry(name: string, description: string): SlashCommandEntry {
  const d = description.replace(/\s+/g, " ").trim();
  return {
    command: `/${name}`,
    description: d.length > 100 ? `${d.slice(0, 99)}…` : d,
    usage_hint: "",
    should_escape: false,
  };
}

export type AddResult = { ok: true; manifest: Manifest; changed: boolean } | { ok: false; reason: string };

/** Pure: return the manifest with the command added (or updated). */
export function withSlashCommand(manifest: Manifest, entry: SlashCommandEntry): AddResult {
  const name = entry.command.replace(/^\//, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name))
    return { ok: false, reason: `"/${name}" is not a valid slash command` };
  if (RESERVED.has(name)) return { ok: false, reason: `/${name} is reserved` };
  const existing = manifest.features?.slash_commands ?? [];
  const at = existing.findIndex((c) => c.command === entry.command);
  if (at < 0 && existing.length >= MAX_SLASH_COMMANDS)
    return { ok: false, reason: `this app already has ${MAX_SLASH_COMMANDS} slash commands` };
  if (at >= 0 && existing[at]?.description === entry.description)
    return { ok: true, manifest, changed: false };
  const next = at >= 0 ? existing.map((c, i) => (i === at ? { ...c, ...entry } : c)) : [...existing, entry];
  return {
    ok: true,
    manifest: { ...manifest, features: { ...manifest.features, slash_commands: next } },
    changed: true,
  };
}

export interface ManifestApi {
  exportManifest(appId: string): Promise<Manifest>;
  updateManifest(appId: string, manifest: Manifest): Promise<void>;
}

export class SlackManifestApi implements ManifestApi {
  private token: string;

  constructor(
    token: string,
    private refreshToken: string | undefined,
    private readonly onRotate: (token: string, refresh: string) => Promise<void>,
  ) {
    this.token = token;
  }

  private async call<T>(fn: (c: InstanceType<typeof webApi.WebClient>) => Promise<T>): Promise<T> {
    try {
      return await fn(new webApi.WebClient(this.token));
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error;
      if ((code === "token_expired" || code === "invalid_auth") && this.refreshToken) {
        const rotated = await new webApi.WebClient().tooling.tokens.rotate({
          refresh_token: this.refreshToken,
        });
        if (!rotated.token || !rotated.refresh_token) throw err;
        this.token = rotated.token;
        this.refreshToken = rotated.refresh_token;
        await this.onRotate(rotated.token, rotated.refresh_token);
        return fn(new webApi.WebClient(this.token));
      }
      throw err;
    }
  }

  async exportManifest(appId: string): Promise<Manifest> {
    const res = await this.call((c) => c.apps.manifest.export({ app_id: appId }));
    return (res.manifest ?? {}) as Manifest;
  }

  async updateManifest(appId: string, manifest: Manifest): Promise<void> {
    await this.call((c) =>
      c.apps.manifest.update({
        app_id: appId,
        manifest: manifest as Parameters<typeof c.apps.manifest.update>[0]["manifest"],
      }),
    );
  }
}

export class CommandRegistrar {
  constructor(
    private readonly api: ManifestApi | null,
    private readonly appId: string | undefined,
  ) {}

  get enabled(): boolean {
    return !!this.api && !!this.appId;
  }

  /** Register /name for real, or return "router" so the caller tells people to use /do name. */
  async register(name: string, description: string): Promise<{ registered: Registration; reason?: string }> {
    if (!this.api || !this.appId)
      return { registered: "router", reason: "no SLACK_CONFIG_TOKEN / SLACK_APP_ID" };
    try {
      const current = await this.api.exportManifest(this.appId);
      const next = withSlashCommand(current, slashEntry(name, description));
      if (!next.ok) return { registered: "router", reason: next.reason };
      if (next.changed) await this.api.updateManifest(this.appId, next.manifest);
      return { registered: "slash" };
    } catch (err) {
      const reason =
        (err as { data?: { error?: string } }).data?.error ??
        (err instanceof Error ? err.message : String(err));
      log.warn(`manifest update for /${name} failed: ${reason}`);
      return { registered: "router", reason };
    }
  }
}

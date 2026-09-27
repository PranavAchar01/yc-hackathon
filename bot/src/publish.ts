import type { CommandLibrary, CommandRecord, Visibility } from "./library/types.ts";
import { log } from "./log.ts";
import type { MemorableClient } from "./memorable.ts";
import { type Procedure, saveSkill } from "./procedure.ts";
import type { CommandRegistrar } from "./registrar.ts";
import type { GBrainIndex } from "./search.ts";

export interface PublishRequest {
  name: string;
  title: string;
  description: string;
  emoji: string;
  steps: string[];
  visibility: Visibility;
  channelId: string | null;
  startUrl?: string | null;
  author: { id: string; name: string };
}

export interface PublishOutcome {
  command: CommandRecord;
  memorable: boolean;
  gbrain: boolean;
  reason?: string;
}

/**
 * Publish = library row + QM skill file + GBrain page + Memorable procedure + a real slash command.
 * Only the library row is required; every other part degrades to a log line.
 */
export class Publisher {
  constructor(
    private readonly deps: {
      library: CommandLibrary;
      skillsDir: string;
      gbrain: GBrainIndex | null;
      memorable: MemorableClient | null;
      registrar: CommandRegistrar;
      memorableScope: string;
    },
  ) {}

  async publish(r: PublishRequest): Promise<PublishOutcome> {
    const d = this.deps;
    const existing = await d.library.get(r.name);
    let command = await d.library.upsert({
      name: r.name,
      title: r.title,
      description: r.description,
      emoji: r.emoji,
      steps: r.steps,
      author: r.author.id,
      authorName: r.author.name,
      visibility: r.visibility,
      channelId: r.visibility === "channel" ? r.channelId : null,
      registered: existing?.registered ?? "router",
      startUrl: r.startUrl ?? existing?.startUrl ?? null,
    });

    const procedure: Procedure = {
      name: r.name,
      title: r.title,
      description: r.description,
      steps: r.steps,
      teacher: r.author.name,
      demonstrations: 1,
    };
    const skillFile = await saveSkill(d.skillsDir, procedure);

    const reg =
      command.registered === "slash"
        ? { registered: "slash" as const }
        : await d.registrar.register(r.name, r.description);
    if (reg.registered !== command.registered) {
      await d.library.setRegistration(r.name, reg.registered);
      command = { ...command, registered: reg.registered };
    }
    const [gbrain, memorable] = await Promise.all([
      d.gbrain ? d.gbrain.put(command).catch(() => false) : Promise.resolve(false),
      d.memorable
        ? d.memorable
            .save(procedure, skillFile, d.memorableScope)
            .then((m) => {
              log.info(`publish /${r.name}: ${m.detail}`);
              return m.saved;
            })
            .catch(() => false)
        : Promise.resolve(false),
    ]);
    const reason = "reason" in reg ? reg.reason : undefined;
    log.info(
      `published /${r.name} (${command.registered}${reason ? `: ${reason}` : ""}), gbrain=${gbrain}, memorable=${memorable}`,
    );
    return { command, memorable, gbrain, ...(reason ? { reason } : {}) };
  }
}

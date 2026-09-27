import type { types } from "@slack/bolt";
import { esc } from "./blocks.ts";
import { type CommandRecord, invocation } from "./library/types.ts";
import { teamCoverUrl, teamOf } from "./teams.ts";

type KnownBlock = types.KnownBlock;
type HomeView = types.HomeView;

export const HOME_SEARCH = { block: "home_search", action: "ots_home_search" } as const;
const SECTION_LIMIT = 4;

const md = (text: string) => ({ type: "mrkdwn" as const, text });

export function runsLabel(n: number): string {
  return n === 1 ? "1 run" : `${n} runs`;
}

/** Where App Home thumbnails come from: the public site (the same covers as the web library). */
export const COVERS_BASE = process.env.OTS_LIVE_BASE ?? "https://over-the-shoulder-brown.vercel.app";

/** The tile picture: the latest real run's poster, else the team's generated cover. */
export function thumbnailUrl(c: CommandRecord, base = COVERS_BASE): string {
  return c.posterUrl?.startsWith("https://") ? c.posterUrl : teamCoverUrl(base, teamOf(c));
}

/** One command, two quiet lines and a thumbnail: the command and its name, then what it does and how often it runs. */
export function commandRow(c: CommandRecord): KnownBlock[] {
  return [
    {
      type: "section",
      text: md(`*${esc(invocation(c))}*   ${esc(c.title)}`),
      accessory: { type: "image", image_url: thumbnailUrl(c), alt_text: c.title.slice(0, 200) || c.name },
    },
    {
      type: "context",
      elements: [md(`${esc(c.description)}  ·  ${esc(c.authorName)}  ·  ${runsLabel(c.uses)}`)],
    },
  ];
}

function group(title: string, list: CommandRecord[], empty: string): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: "section", text: md(`*${title}*`) }];
  if (list.length === 0) blocks.push({ type: "context", elements: [md(empty)] });
  for (const c of list.slice(0, SECTION_LIMIT)) blocks.push(...commandRow(c));
  return blocks;
}

export interface HomeData {
  query: string;
  results: CommandRecord[] | null;
  popular: CommandRecord[];
  teammates: CommandRecord[];
  yours: CommandRecord[];
}

export function homeView(d: HomeData): HomeView {
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Commands" } },
    {
      type: "context",
      elements: [md("Things your team showed once. Show one with `/teach`, or describe one with `/new`.")],
    },
    {
      type: "input",
      block_id: HOME_SEARCH.block,
      dispatch_action: true,
      label: { type: "plain_text", text: "Search" },
      element: {
        type: "plain_text_input",
        action_id: HOME_SEARCH.action,
        ...(d.query ? { initial_value: d.query } : {}),
        placeholder: { type: "plain_text", text: "send launch emails" },
        dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] },
      },
    },
  ];
  if (d.results) {
    blocks.push(
      ...group(
        `Results for "${esc(d.query)}"`,
        d.results,
        "Nothing matches yet. Teach it once with `/teach`.",
      ),
      { type: "divider" },
    );
  }
  const shown = new Set(d.popular.slice(0, SECTION_LIMIT).map((c) => c.name));
  const teammates = d.teammates.filter((c) => !shown.has(c.name));
  blocks.push(
    ...group("Popular on your team", d.popular, "No runs yet."),
    { type: "divider" },
    ...group("New to you", teammates, "You've tried everything your team uses."),
    { type: "divider" },
    ...group("Yours", d.yours, "Nothing yet. Run `/teach` and do a task once."),
  );
  return { type: "home", blocks };
}

/** /commands <query>: an ephemeral list. */
export function commandsMessage(
  query: string,
  results: CommandRecord[],
): { text: string; blocks: KnownBlock[] } {
  const title = query ? `Commands matching "${esc(query)}"` : "Popular commands";
  const blocks: KnownBlock[] = [{ type: "section", text: md(`*${title}*`) }];
  if (results.length === 0)
    blocks.push({ type: "context", elements: [md("Nothing yet. Teach it once with `/teach`.")] });
  for (const c of results.slice(0, 8)) blocks.push(...commandRow(c));
  return { text: title, blocks };
}

/** Confirmation after Publish. */
export function publishedMessage(
  c: CommandRecord,
  parts: { memorable: boolean; gbrain: boolean; reason?: string },
): { text: string; blocks: KnownBlock[] } {
  const how = invocation(c);
  const who = c.visibility === "everyone" ? "Anyone" : c.visibility === "channel" ? "This channel" : "You";
  const text = `Published ${how}. ${who} can run it now.`;
  const saved = ["Library", parts.gbrain ? "GBrain" : null, parts.memorable ? "Memorable" : null].filter(
    Boolean,
  );
  return {
    text,
    blocks: [
      { type: "section", text: md(`✓  *${esc(text)}*`) },
      {
        type: "context",
        elements: [
          md(`${c.emoji}  ${esc(c.title)}  ·  ${c.steps.length} steps  ·  saved to ${saved.join(", ")}`),
        ],
      },
    ],
  };
}

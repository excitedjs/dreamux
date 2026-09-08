import { basename } from 'node:path';

import type { FeishuBindingView } from './routing/index.js';

export interface RunningTeamRow {
  readonly team_name: string;
  readonly status: string;
  readonly intent: string | null;
  readonly source_repo: string | null;
  readonly leader_agent_runtime: string;
}

// Only colours with a validated `-100` border token, because a repository's
// colour is used both as a text colour and as its cards' border.
const REPOSITORY_COLORS = ['blue', 'turquoise', 'green', 'orange', 'purple'];
const RUNTIME_COLORS = ['purple', 'indigo', 'blue', 'turquoise', 'orange'];
const INTENT_LIMIT = 96;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stablePaletteColor(
  value: string,
  palette: readonly string[],
): string {
  return palette[stableHash(value) % palette.length]!;
}

function shortIntent(intent: string | null): string {
  if (intent === null) return 'No intent';
  const characters = [...intent.replace(/\s+/g, ' ').trim()];
  return characters.length <= INTENT_LIMIT
    ? characters.join('')
    : `${characters.slice(0, INTENT_LIMIT - 1).join('')}…`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function repoName(team: RunningTeamRow): string {
  return team.source_repo === null ? 'No repository' : basename(team.source_repo);
}

function chatLink(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\[\]()<>*_]/g, '\\$&');
}

/**
 * One Team, as a bordered tile half the card's width.
 *
 * Three elements rather than one block of markdown, so the two columns can size
 * the name, the intent, and the bindings independently. A tile is free to be as
 * tall as its data: Feishu lays a two-column `column_set` out as a waterfall, so
 * a tall tile lengthens its own column and never stretches the one beside it.
 * Operator, 2026-09-07, on a draft that truncated the intent and counted all but
 * the first binding to keep tiles the same height: 「你不用担心，飞书这个两栏做了瀑布
 * 布局。这些截断都是无意义的」.
 */
function teamItem(input: {
  team: RunningTeamRow;
  bindings: readonly (FeishuBindingView & { chatName: string })[];
  borderColor: string;
}): Record<string, unknown> {
  const runtimeColor = stablePaletteColor(
    input.team.leader_agent_runtime,
    RUNTIME_COLORS,
  );
  const bindingText = input.bindings.length === 0
    ? '<font color=\'grey\'>No Feishu bindings</font>'
    : input.bindings.map((binding) => {
        const suffix = binding.target_kind === 'topic' && binding.thread_id !== null
          ? ` <font color='grey'>· ${escapeMarkdown(binding.thread_id)}</font>`
          : '';
        return `[📍 ${escapeMarkdown(binding.chatName)}](${chatLink(binding.chat_id)})${suffix}`;
      }).join('  \n');
  return {
    tag: 'interactive_container',
    width: 'fill',
    has_border: true,
    border_color: input.borderColor,
    corner_radius: '8px',
    padding: '8px 10px 8px 10px',
    margin: '0px 0px 8px 0px',
    vertical_spacing: '4px',
    elements: [
      {
        tag: 'markdown',
        content:
          `<text_tag color='${runtimeColor}'>${escapeMarkdown(input.team.leader_agent_runtime)}</text_tag>  ` +
          `**${escapeMarkdown(input.team.team_name)}**`,
      },
      {
        tag: 'markdown',
        text_size: 'notation',
        content: `<font color='grey'>${escapeMarkdown(shortIntent(input.team.intent))}</font>`,
      },
      { tag: 'markdown', text_size: 'notation', content: bindingText },
    ],
  };
}

/**
 * Deal tiles left, right, left … into a two-column grid.
 *
 * Column-major would put the second Team at the bottom of the left column; a
 * reader scanning a name list reads across. An odd count leaves the last right
 * cell empty rather than letting the final tile stretch to full width, which
 * would read as a different kind of row.
 */
function teamGrid(tiles: readonly Record<string, unknown>[]): Record<string, unknown> {
  const columns: Record<string, unknown>[][] = [[], []];
  tiles.forEach((tile, index) => columns[index % 2]!.push(tile));
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: '8px',
    columns: columns.map((elements) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements,
    })),
  };
}

export async function buildRunningTeamsCard(input: {
  teams: readonly RunningTeamRow[];
  bindings: readonly FeishuBindingView[];
  resolveChatName: (chatId: string) => Promise<string | undefined>;
}): Promise<unknown> {
  const runningTeamNames = new Set(input.teams.map((team) => team.team_name));
  const relevantBindings = input.bindings.filter(
    (binding) =>
      runningTeamNames.has(binding.team_name) &&
      (binding.target_kind === 'group' || binding.target_kind === 'topic'),
  );
  const chatNames = new Map<string, string>();
  await Promise.all(
    [...new Set(relevantBindings.map((binding) => binding.chat_id))].map(
      async (chatId) => {
        let name: string | undefined;
        try {
          name = await input.resolveChatName(chatId);
        } catch {
          name = undefined;
        }
        chatNames.set(chatId, name ?? chatId);
      },
    ),
  );
  const groups = new Map<string, RunningTeamRow[]>();
  for (const team of input.teams) {
    const name = repoName(team);
    const rows = groups.get(name) ?? [];
    rows.push(team);
    groups.set(name, rows);
  }
  const bindingsByTeam = new Map<
    string,
    (FeishuBindingView & { chatName: string })[]
  >();
  for (const binding of relevantBindings) {
    const named = { ...binding, chatName: chatNames.get(binding.chat_id)! };
    bindingsByTeam.set(binding.team_name, [
      ...(bindingsByTeam.get(binding.team_name) ?? []),
      named,
    ]);
  }
  const bindingsFor = (team: RunningTeamRow) =>
    bindingsByTeam.get(team.team_name) ?? [];
  // The repository colour is the panel's whole identity — its name and the
  // border of every tile under it — so one hash serves both.
  const panels = [...groups].sort(([left], [right]) => left.localeCompare(right))
    .map(([repository, teams]) => {
      const color = stablePaletteColor(repository, REPOSITORY_COLORS);
      const sorted = [...teams].sort(
        (left, right) => left.team_name.localeCompare(right.team_name),
      );
      const chats = new Set(
        sorted.flatMap((team) => bindingsFor(team).map((b) => b.chat_id)),
      );
      return {
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'markdown',
            content:
              `**<font color='${color}'>${escapeMarkdown(repository)}</font>** ` +
              `<font color='grey'>· ${plural(sorted.length, 'Team')}` +
              ` · ${plural(chats.size, 'chat')}</font>`,
          },
        },
        elements: [
          teamGrid(sorted.map((team) => teamItem({
            team,
            bindings: bindingsFor(team),
            borderColor: `${color}-100`,
          }))),
        ],
      };
    });
  const chatCount = new Set(relevantBindings.map((b) => b.chat_id)).size;
  return {
    schema: '2.0',
    config: {
      width_mode: 'default',
      summary: { content: `${input.teams.length} running Teams` },
    },
    header: {
      title: { tag: 'plain_text', content: 'Running Teams' },
      subtitle: {
        tag: 'plain_text',
        content:
          `${plural(input.teams.length, 'Team')} · ${plural(chatCount, 'chat')}`,
      },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'myai_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '8px',
      elements: panels.length > 0
        ? panels
        : [{ tag: 'markdown', content: 'No Teams are running.' }],
    },
  };
}

import { basename } from 'node:path';

import type { FeishuBindingView } from './routing/index.js';

export interface RunningTeamRow {
  readonly team_name: string;
  readonly status: string;
  readonly intent: string | null;
  readonly source_repo: string | null;
  readonly leader_agent_runtime: string;
}

const REPOSITORY_COLORS = ['blue', 'wathet', 'turquoise', 'green', 'yellow'];
const RUNTIME_COLORS = ['purple', 'indigo', 'blue', 'cyan', 'green'];
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

function repoName(team: RunningTeamRow): string {
  return team.source_repo === null ? 'No repository' : basename(team.source_repo);
}

function chatLink(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\[\]()<>*_]/g, '\\$&');
}

function teamItem(input: {
  team: RunningTeamRow;
  bindings: readonly (FeishuBindingView & { chatName: string })[];
}): Record<string, unknown> {
  const runtimeColor = stablePaletteColor(
    input.team.leader_agent_runtime,
    RUNTIME_COLORS,
  );
  const bindingText = input.bindings.length === 0
    ? '<font color="grey">No Feishu bindings</font>'
    : input.bindings.map((binding) => {
        const kind = binding.target_kind === 'topic' ? 'Topic' : 'Group';
        const suffix = binding.target_kind === 'topic' && binding.thread_id !== null
          ? ` · ${escapeMarkdown(binding.thread_id)}`
          : '';
        return `${kind}: [${escapeMarkdown(binding.chatName)}](${chatLink(binding.chat_id)})${suffix}`;
      }).join('\n');
  return {
    tag: 'interactive_container',
    width: 'fill',
    has_border: true,
    border_color: 'grey-300',
    corner_radius: '8px',
    padding: '8px 12px 8px 12px',
    elements: [
      {
        tag: 'markdown',
        content:
          `<text_tag color='${runtimeColor}'>${escapeMarkdown(input.team.leader_agent_runtime)}</text_tag> ` +
          `**${escapeMarkdown(input.team.team_name)}**\n` +
          `${escapeMarkdown(shortIntent(input.team.intent))}\n${bindingText}`,
      },
    ],
  };
}

export async function buildRunningTeamsCard(input: {
  teams: readonly RunningTeamRow[];
  bindings: readonly FeishuBindingView[];
  resolveChatName?: (chatId: string) => Promise<string | undefined>;
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
          name = await input.resolveChatName?.(chatId);
        } catch {
          name = undefined;
        }
        chatNames.set(chatId, name === undefined || name === '' ? chatId : name);
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
  const panels = [...groups].sort(([left], [right]) => left.localeCompare(right))
    .map(([repository, teams]) => ({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: `<text_tag color='${stablePaletteColor(repository, REPOSITORY_COLORS)}'>Repository</text_tag> **${escapeMarkdown(repository)}** · ${teams.length}`,
        },
      },
      elements: teams.sort((left, right) => left.team_name.localeCompare(right.team_name))
        .map((team) => teamItem({
          team,
          bindings: relevantBindings
            .filter((binding) => binding.team_name === team.team_name)
            .map((binding) => ({
              ...binding,
              chatName: chatNames.get(binding.chat_id)!,
            })),
        })),
    }));
  return {
    schema: '2.0',
    config: {
      width_mode: 'default',
      summary: { content: `${input.teams.length} running Teams` },
    },
    header: {
      title: { tag: 'plain_text', content: 'Running Teams' },
      template: 'blue',
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '12px',
      elements: panels.length > 0
        ? panels
        : [{ tag: 'markdown', content: 'No Teams are running.' }],
    },
  };
}

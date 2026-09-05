import type { JsonValue } from '@excitedjs/dreamux-types';
import type { Mention } from '@excitedjs/feishu-transport';

import { errorMessage } from './feishu-submit.js';
import { leadingTextAfterMentions } from './introduce.js';
import {
  buildRunningTeamsCard,
  type RunningTeamRow,
} from './feishu-running-teams-card.js';
import type {
  FeishuBindingView,
  FeishuRoutingPlan,
} from './routing/index.js';

export type FeishuSlashCommand = 'stop' | 'teams' | 'dissolve';

export type FeishuSlashCommandReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'card'; readonly card: unknown };

interface CommandContext {
  readonly plan: FeishuRoutingPlan;
  readonly invoke: (command: string, payload: JsonValue) => Promise<JsonValue>;
  readonly bindings: readonly FeishuBindingView[];
  readonly resolveChatName?: (chatId: string) => Promise<string | undefined>;
}

interface CommandDefinition {
  readonly name: FeishuSlashCommand;
  readonly token: string;
  execute(context: CommandContext): Promise<FeishuSlashCommandReply>;
}

function defineCommand(
  name: FeishuSlashCommand,
  failureLabel: string,
  execute: (context: CommandContext) => Promise<FeishuSlashCommandReply>,
): CommandDefinition {
  return {
    name,
    token: `/${name}`,
    async execute(context) {
      try {
        return await execute(context);
      } catch (error) {
        return {
          kind: 'text',
          text: `${failureLabel}: ${errorMessage(error)}`,
        };
      }
    },
  };
}

const COMMANDS: Readonly<Record<FeishuSlashCommand, CommandDefinition>> = {
  stop: defineCommand('stop', 'Command /stop failed', async (context) => {
    if (context.plan.kind === 'provision') {
      return { kind: 'text', text: 'This conversation has no bound Team.' };
    }
    const raw = await context.invoke('team.interrupt', context.plan.kind === 'bound'
      ? { team_name: context.plan.teamName }
      : {});
    const result = raw as { status: 'interrupted' | 'idle' };
    return {
      kind: 'text',
      text: result.status === 'interrupted'
        ? 'Current turn interrupted.'
        : 'No turn is running.',
    };
  }),
  teams: defineCommand('teams', 'Command /teams failed', async (context) => {
    const raw = await context.invoke('team.list', {});
    const rows = (raw as unknown as { teams: RunningTeamRow[] }).teams
      .filter((team) => team.status === 'running');
    return {
      kind: 'card',
      card: await buildRunningTeamsCard({
        teams: rows,
        bindings: context.bindings,
        ...(context.resolveChatName !== undefined
          ? { resolveChatName: context.resolveChatName }
          : {}),
      }),
    };
  }),
  dissolve: defineCommand('dissolve', 'Team dissolve refused', async (context) => {
    if (context.plan.kind !== 'bound') {
      return { kind: 'text', text: 'This conversation has no bound Team.' };
    }
    await context.invoke('team.dissolve', {
      team_name: context.plan.teamName,
      note: 'Dissolved from the bound Feishu conversation.',
    });
    return {
      kind: 'text',
      text: `Dissolving Team ${JSON.stringify(context.plan.teamName)}.`,
    };
  }),
};

export function detectFeishuSlashCommand(input: {
  messageType: string;
  rawContent: string;
  mentions: readonly Mention[];
  chatType: 'p2p' | 'group';
  botMentioned: boolean;
  senderKind: 'human' | 'bot';
}): FeishuSlashCommand | null {
  if (input.senderKind !== 'human') return null;
  if (input.chatType === 'group' && !input.botMentioned) return null;
  const text = leadingTextAfterMentions(
    input.messageType,
    input.rawContent,
    input.mentions,
  );
  if (text === null) return null;
  const lower = text.toLocaleLowerCase('en-US');
  return Object.values(COMMANDS).find(
    (command) => lower.startsWith(command.token) &&
      (lower.length === command.token.length || /^\s/u.test(lower.slice(command.token.length))),
  )?.name ?? null;
}

export function dispatchFeishuSlashCommand(
  command: FeishuSlashCommand,
  context: CommandContext,
): Promise<FeishuSlashCommandReply> {
  return COMMANDS[command].execute(context);
}

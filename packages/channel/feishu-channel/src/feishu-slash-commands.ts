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

/**
 * What a command answers with, including answering with nothing.
 *
 * `silent` is a reply, not the absence of one: the command ran and succeeded,
 * and saying so would be the second message about one event. It stays inside
 * this union rather than becoming a nullable return so the render site keeps
 * one exhaustive decision instead of two.
 */
export type FeishuSlashCommandReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'card'; readonly card: unknown }
  | { readonly kind: 'silent' };

interface CommandContext {
  readonly plan: FeishuRoutingPlan;
  readonly invoke: (command: string, payload: JsonValue) => Promise<JsonValue>;
  readonly bindings: readonly FeishuBindingView[];
  readonly resolveChatName: (chatId: string) => Promise<string | undefined>;
}

interface CommandDefinition {
  execute(context: CommandContext): Promise<FeishuSlashCommandReply>;
}

function defineCommand(
  failureLabel: string,
  execute: (context: CommandContext) => Promise<FeishuSlashCommandReply>,
): CommandDefinition {
  return {
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
  stop: defineCommand('Command /stop failed', async (context) => {
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
  teams: defineCommand('Command /teams failed', async (context) => {
    const raw = await context.invoke('team.list', {});
    const rows = (raw as unknown as { teams: RunningTeamRow[] }).teams
      .filter((team) => team.status === 'running');
    return {
      kind: 'card',
      card: await buildRunningTeamsCard({
        teams: rows,
        bindings: context.bindings,
        resolveChatName: context.resolveChatName,
      }),
    };
  }),
  dissolve: defineCommand('Command /dissolve failed', async (context) => {
    if (context.plan.kind !== 'bound') {
      return { kind: 'text', text: 'This conversation has no bound Team.' };
    }
    await context.invoke('team.dissolve', {
      team_name: context.plan.teamName,
      note: 'Dissolved from the bound Feishu conversation.',
    });
    // An accepted dissolve is the one command that already announces itself:
    // the Team's close reaches this Channel as a `team.state` closed event,
    // which removes the routes and announces that to the conversation. A
    // receipt here would be the second message about the same event, which is
    // what the operator saw and ruled out on 2026-09-07. Only the accepted case
    // is silent — a refusal is news the conversation cannot get anywhere else,
    // and still answers.
    return { kind: 'silent' };
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
  // The table's keys are the command names, so there is nothing to keep in
  // agreement: `Object.keys` only loses the key type, which the table's own
  // `Record<FeishuSlashCommand, …>` already proved.
  const names = Object.keys(COMMANDS) as FeishuSlashCommand[];
  return names.find((name) => {
    const token = `/${name}`;
    return lower.startsWith(token) &&
      (lower.length === token.length || /^\s/u.test(lower.slice(token.length)));
  }) ?? null;
}

export function dispatchFeishuSlashCommand(
  command: FeishuSlashCommand,
  context: CommandContext,
): Promise<FeishuSlashCommandReply> {
  return COMMANDS[command].execute(context);
}

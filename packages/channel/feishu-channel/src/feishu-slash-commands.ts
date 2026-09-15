import type { JsonValue } from '@excitedjs/dreamux-types';
import type { Mention } from '@excitedjs/feishu-transport';
import parser from 'yargs-parser';

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
import { containingChat, type FeishuTarget } from './routing/target.js';
import type { FeishuBindingOperations } from './feishu-session-bindings.js';

export type FeishuSlashCommandName = 'bind' | 'dissolve' | 'help' | 'stop' | 'teams';

export interface FeishuSlashCommandInvocation {
  readonly name: FeishuSlashCommandName;
  /**
   * The positional arguments, in order.
   *
   * The parser's own result type is `{ _: Array<string | number>; [flag: string]: any }`,
   * and this seam is crossed by `FeishuInboundDelivery`, a pinned public export.
   * Narrowing here keeps the `any` and the library's type out of both, and the
   * narrowing is honest: `parse-positional-numbers` is off, so every positional
   * is already a string. A row that wants a named flag adds a typed field.
   */
  readonly args: readonly string[];
}

const PARSER_CONFIG = {
  configuration: { 'parse-positional-numbers': false },
} as const;

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
  readonly args: readonly string[];
  readonly target: FeishuTarget;
  readonly bindChannel: FeishuBindingOperations['bindChannel'];
  readonly plan: FeishuRoutingPlan;
  readonly invoke: (command: string, payload: JsonValue) => Promise<JsonValue>;
  readonly bindings: readonly FeishuBindingView[];
  readonly resolveChatName: (chatId: string) => Promise<string | undefined>;
}

interface CommandDefinition {
  readonly usage: string;
  readonly summary: string;
  execute(context: CommandContext): Promise<FeishuSlashCommandReply>;
}

const COMMANDS: Readonly<Record<FeishuSlashCommandName, CommandDefinition>> = {
  bind: {
    usage: '/bind <team_name>',
    summary: 'Route this group to a Team.',
    async execute(context) {
      const [teamName] = context.args;
      if (teamName === undefined) {
        return { kind: 'text', text: `Usage: ${COMMANDS.bind.usage}` };
      }
      // Every way this bind can be refused — a direct chat, a missing or
      // closed Team, the chat a Collaboration Space is registered on — is
      // stated by the layer that owns the fact and arrives here as a thrown
      // failure. This row adds no precondition of its own.
      await context.bindChannel({
        target: containingChat(context.target),
        teamName,
        display: null,
        announceIn: context.target,
      });
      return { kind: 'silent' };
    },
  },
  dissolve: {
    usage: '/dissolve',
    summary: 'Dissolve this conversation\'s bound Team.',
    async execute(context) {
      if (context.plan.kind !== 'bound') {
        return { kind: 'text', text: 'This conversation has no bound Team.' };
      }
      await context.invoke('team.dissolve', {
        team_name: context.plan.teamName,
        note: 'Dissolved from the bound Feishu conversation.',
      });
      // The Team's close reaches this Channel as a `team.state` closed event,
      // which removes the routes and announces that to the conversation. A
      // receipt here would be the second message about the same event. Only
      // the accepted case is silent; a refusal still answers.
      return { kind: 'silent' };
    },
  },
  help: {
    usage: '/help',
    summary: 'Show this list.',
    execute: async () => ({
      kind: 'text',
      text: [
        '**Dreamux commands**',
        ...Object.values(COMMANDS).map((command) => `- \`${command.usage}\` — ${command.summary}`),
      ].join('\n'),
    }),
  },
  stop: {
    usage: '/stop',
    summary: 'Interrupt the current turn in this conversation.',
    async execute(context) {
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
    },
  },
  teams: {
    usage: '/teams',
    summary: 'List running Teams.',
    async execute(context) {
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
    },
  },
};

export function detectFeishuSlashCommand(input: {
  messageType: string;
  rawContent: string;
  mentions: readonly Mention[];
  chatType: 'p2p' | 'group';
  botMentioned: boolean;
  senderKind: 'human' | 'bot';
}): FeishuSlashCommandInvocation | null {
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
  // `Record<FeishuSlashCommandName, …>` already proved.
  const names = Object.keys(COMMANDS) as FeishuSlashCommandName[];
  const name = names.find((name) => {
    const token = `/${name}`;
    return lower.startsWith(token) &&
      (lower.length === token.length || /^\s/u.test(lower.slice(token.length)));
  });
  return name === undefined ? null : {
    name,
    args: parser(text.slice(name.length + 1), PARSER_CONFIG)._
      .map((value) => String(value)),
  };
}

export async function dispatchFeishuSlashCommand(
  invocation: FeishuSlashCommandInvocation,
  context: Omit<CommandContext, 'args'>,
): Promise<FeishuSlashCommandReply> {
  try {
    return await COMMANDS[invocation.name].execute({ ...context, args: invocation.args });
  } catch (error) {
    return {
      kind: 'text',
      text: `Command /${invocation.name} failed: ${errorMessage(error)}`,
    };
  }
}

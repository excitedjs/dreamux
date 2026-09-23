/**
 * The Feishu extension registry and its per-instance host.
 *
 * `FeishuExtensionRegistry` is one per Feishu plugin object and is filled while
 * plugins load, before any channel instance exists. `FeishuSessionExtensions`
 * is one per `FeishuChannelSession`: it runs every registered extension's
 * lifecycle for that instance and holds the state each one returned, which is
 * what tool calls and card actions on that instance receive.
 */
import { join } from 'node:path';

import type {
  ChannelMcpCaller,
  ChannelMcpToolRegistration,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { FeishuOperationError } from './feishu-bounded-operation.js';
import { DREAMUX_ASK_ACTIONS } from './feishu-ask-user-card.js';
import { DREAMUX_PAIRING_CARD_ACTION } from './feishu-pairing-card.js';
import type { FeishuBindingOperations } from './feishu-session-bindings.js';
import {
  readMessageRoute,
  sendCard,
  type SessionHandle,
} from './feishu-session-ops.js';
import type {
  FeishuChatSubmission,
  FeishuSubmitOutcome,
} from './feishu-submit.js';
import type {
  FeishuExtension,
  FeishuExtensionTool,
  FeishuInstanceApi,
} from './extension.js';
import type { FeishuCardActionEvent } from './bot.js';
import type { FeishuRouting } from './routing/index.js';
import { channelPathSegment } from './routing/store.js';
import { findFeishuTool, toolRegistration } from './tools/registry.js';
import type { FeishuToolResult } from './tools/types.js';

type AnyExtension = FeishuExtension<unknown>;

export class FeishuExtensionRegistry {
  private readonly extensions: AnyExtension[] = [];

  register<S>(extension: FeishuExtension<S>): void {
    const ext = extension as unknown as AnyExtension;
    if (this.extensions.some((other) => other.name === ext.name)) {
      throw new Error(`Feishu extension "${ext.name}" is registered twice`);
    }
    for (const tool of ext.tools) {
      for (const kind of tool.callers) {
        const other = findFeishuTool(tool.name, kind) !== undefined
          ? 'built-in Feishu tool'
          : this.toolOwner(tool.name, kind);
        if (other !== undefined) {
          throw new Error(
            `Feishu extension "${ext.name}" tool "${tool.name}" ` +
              `(caller ${kind}) conflicts with ${other}`,
          );
        }
      }
    }
    for (const action of ext.cardActions) {
      const other =
        action.key === DREAMUX_PAIRING_CARD_ACTION ||
        DREAMUX_ASK_ACTIONS.has(action.key)
          ? 'built-in Feishu card action'
          : this.actionOwner(action.key);
      if (other !== undefined) {
        throw new Error(
          `Feishu extension "${ext.name}" card action "${action.key}" ` +
            `conflicts with ${other}`,
        );
      }
    }
    this.extensions.push(ext);
  }

  registrationsFor(caller: ChannelMcpCaller): ChannelMcpToolRegistration[] {
    return this.extensions.flatMap((ext) =>
      ext.tools
        .filter((tool) => tool.callers.includes(caller.kind))
        .map(toolRegistration),
    );
  }

  list(): readonly AnyExtension[] {
    return this.extensions;
  }

  private toolOwner(
    name: string,
    kind: ChannelMcpCaller['kind'],
  ): string | undefined {
    const owner = this.extensions.find((ext) =>
      ext.tools.some((tool) => tool.name === name && tool.callers.includes(kind)),
    );
    return owner === undefined ? undefined : `extension "${owner.name}"`;
  }

  private actionOwner(key: string): string | undefined {
    const owner = this.extensions.find((ext) =>
      ext.cardActions.some((action) => action.key === key),
    );
    return owner === undefined ? undefined : `extension "${owner.name}"`;
  }
}

export interface FeishuExtensionInitializeInput {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly stateDir: string;
  readonly signal: AbortSignal;
  readonly log: DreamuxLogger;
  readonly api: FeishuInstanceApi;
}

/** One Feishu channel instance's running extensions and their states. */
export class FeishuSessionExtensions {
  private readonly states = new Map<AnyExtension, unknown>();

  constructor(private readonly registry: FeishuExtensionRegistry) {}

  /** In registration order; a throw propagates and fails the instance. */
  async initialize(input: FeishuExtensionInitializeInput): Promise<void> {
    for (const ext of this.registry.list()) {
      const state = await ext.initialize({
        dispatcherId: input.dispatcherId,
        channelId: input.channelId,
        stateRoot: join(
          input.stateDir,
          'feishu-extensions',
          ext.name,
          channelPathSegment(input.channelId),
        ),
        signal: input.signal,
        log: input.log.child?.({ feishu_extension: ext.name }) ?? input.log,
        api: input.api,
      });
      this.states.set(ext, state);
    }
  }

  /** In registration order; a throw propagates and fails the instance. */
  async start(): Promise<void> {
    for (const [ext, state] of this.states) await ext.start(state);
  }

  /**
   * In reverse order. A failure is logged and the rest still close, because
   * the session teardown that calls this must go on to drain its own store.
   */
  async close(log: DreamuxLogger): Promise<void> {
    const running = [...this.states].reverse();
    this.states.clear();
    for (const [ext, state] of running) {
      try {
        await ext.close(state);
      } catch (err) {
        log.error(
          {
            feishu_extension: ext.name,
            err: { message: err instanceof Error ? err.message : String(err) },
          },
          'Feishu extension close failed',
        );
      }
    }
  }

  /** The extension tool this caller kind means by `name`, over its state. */
  tool(
    name: string,
    kind: ChannelMcpCaller['kind'],
  ): FeishuBoundExtensionTool | undefined {
    for (const ext of this.registry.list()) {
      const def = ext.tools.find(
        (tool) => tool.name === name && tool.callers.includes(kind),
      );
      if (def === undefined) continue;
      return {
        def,
        invoke: async (caller, raw) =>
          def.handle({ caller, state: this.states.get(ext) }, def.parse(raw)),
      };
    }
    return undefined;
  }

  /** The extension card action claiming `key`, over its state. */
  action(
    key: string,
  ): ((event: FeishuCardActionEvent) => Promise<unknown>) | undefined {
    for (const ext of this.registry.list()) {
      const def = ext.cardActions.find((action) => action.key === key);
      if (def !== undefined) {
        return (event) => def.handle(this.states.get(ext), event);
      }
    }
    return undefined;
  }
}

export interface FeishuBoundExtensionTool {
  readonly def: FeishuExtensionTool<unknown>;
  invoke(caller: ChannelMcpCaller, raw: unknown): Promise<FeishuToolResult>;
}

/**
 * The instance api for one session lifecycle. `handle` carries that
 * lifecycle's fence, so every outbound call made after the instance began
 * closing rejects as `aborted`.
 */
export function buildInstanceApi(input: {
  handle: SessionHandle;
  routing: FeishuRouting;
  bindings: FeishuBindingOperations;
  submit(
    teamName: string,
    submission: FeishuChatSubmission,
  ): Promise<FeishuSubmitOutcome>;
}): FeishuInstanceApi {
  const { handle, routing, bindings } = input;
  const assertCurrent = (): void => {
    if (!handle.sessionFence.isCurrent()) {
      throw new FeishuOperationError('aborted');
    }
  };
  return {
    owner(target) {
      const plan = routing.plan(target, null);
      return plan.kind === 'bound' ? plan.teamName : null;
    },
    async readMessageRoute(messageId) {
      assertCurrent();
      const route = await readMessageRoute(handle, messageId);
      return { target: route.target };
    },
    async bindTeam({ target, teamName, display }) {
      assertCurrent();
      await bindings.bindChannel({ target, teamName, display });
    },
    async sendCard({ chatId, replyTo, card, mode }) {
      const sent = await sendCard(handle, {
        target: {
          conversationId: chatId,
          ...(replyTo !== undefined ? { replyTo } : {}),
        },
        card,
        mode,
      });
      const messageId = sent.messageIds[0];
      if (messageId === undefined) {
        throw new Error('Feishu returned no message id for the sent card');
      }
      // A card sent as a reply lands in the replied-to message's topic, which
      // only Feishu can report. Observing it lets a later reply to this card
      // resolve to the same target.
      const { target } = await readMessageRoute(handle, messageId);
      handle.targetRouter.observe(messageId, target);
      return { messageId, target };
    },
    async editCard(messageId, card) {
      assertCurrent();
      await handle.bot.editCard(messageId, card);
    },
    submitToTeam: (teamName, submission) => input.submit(teamName, submission),
  };
}

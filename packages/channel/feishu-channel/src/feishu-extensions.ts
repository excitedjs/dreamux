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
import type { FeishuCardActionEvent } from '@excitedjs/feishu-transport';

import type { FeishuBot } from './bot.js';
import { builtinCardAction } from './card-actions.js';
import type {
  FeishuExtension,
  FeishuExtensionActionResult,
  FeishuExtensionTool,
  FeishuInstanceApi,
} from './extension.js';
import type { FeishuCoreCommands } from './feishu-core-commands.js';
import {
  CHANNEL_REMINDER,
  type FeishuSubmissionPayload,
} from './feishu-submit.js';
import type { FeishuInboundTargeting } from './inbound/target.js';
import { agentSender, type FeishuOutbound } from './outbound/index.js';
import type { FeishuRouting } from './routing/index.js';
import type { FeishuBindingOperations } from './routing/operations.js';
import { channelPathSegment } from './routing/store.js';
import type { FeishuTarget } from './routing/target.js';
import type { FeishuLifecycle } from './session/lifecycle.js';
import { findFeishuTool, toolRegistration } from './tools/registry.js';
import type { FeishuToolResult } from './tools/types.js';

type AnyExtension = FeishuExtension<unknown>;

export class FeishuExtensionRegistry {
  private readonly extensions: AnyExtension[] = [];
  // Bound by the plugin's server hook before any extension session is initialized.
  private stateDir!: string;

  initialize(stateDir: string): void {
    this.stateDir = stateDir;
  }

  stateRoot(
    dispatcherId: string,
    extensionName: string,
    channelId: string,
  ): string {
    return join(
      this.stateDir,
      dispatcherId,
      'feishu-extensions',
      extensionName,
      channelPathSegment(channelId),
    );
  }

  register<S>(extension: FeishuExtension<S>): void {
    const ext = extension as unknown as AnyExtension;
    if (ext.name.trim() === '') {
      throw new Error('A Feishu extension name must not be blank');
    }
    if (this.extensions.some((other) => other.name === ext.name)) {
      throw new Error(`Feishu extension "${ext.name}" is registered twice`);
    }
    ext.tools.forEach((tool, index) => {
      if (tool.name.trim() === '') {
        throw new Error(
          `Feishu extension "${ext.name}" tool at index ${index} has a blank name`,
        );
      }
      for (const kind of tool.callers) {
        const other =
          findFeishuTool(tool.name, kind) !== undefined
            ? 'built-in Feishu tool'
            : (this.toolOwner(tool.name, kind) ??
              (offersTool(ext.tools.slice(0, index), tool.name, kind)
                ? 'another tool of the same extension'
                : undefined));
        if (other !== undefined) {
          throw new Error(
            `Feishu extension "${ext.name}" tool "${tool.name}" ` +
              `(caller ${kind}) conflicts with ${other}`,
          );
        }
      }
    });
    ext.cardActions.forEach((action, index) => {
      // A blank key would claim every click whose card value carries no
      // `dreamux_action`, because the dispatcher reads a missing key as ''.
      if (action.key.trim() === '') {
        throw new Error(
          `Feishu extension "${ext.name}" card action at index ${index} has a blank key`,
        );
      }
      const other =
        builtinCardAction(action.key) !== undefined
          ? 'built-in Feishu card action'
          : (this.actionOwner(action.key) ??
            (ext.cardActions.slice(0, index).some((a) => a.key === action.key)
              ? 'another card action of the same extension'
              : undefined));
      if (other !== undefined) {
        throw new Error(
          `Feishu extension "${ext.name}" card action "${action.key}" ` +
            `conflicts with ${other}`,
        );
      }
    });
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
      offersTool(ext.tools, name, kind),
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

function offersTool(
  tools: readonly FeishuExtensionTool<unknown>[],
  name: string,
  kind: ChannelMcpCaller['kind'],
): boolean {
  return tools.some(
    (tool) => tool.name === name && tool.callers.includes(kind),
  );
}

/**
 * What a resolved extension card action gives the session's card-action
 * dispatch: enough to run it and to name it in a forward's delivery logs.
 */
export interface FeishuExtensionActionHandler {
  readonly extensionName: string;
  invoke(event: FeishuCardActionEvent): Promise<FeishuExtensionActionResult>;
}

export interface FeishuExtensionInitializeInput {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly signal: AbortSignal;
  readonly api: FeishuInstanceApi;
}

/** One Feishu channel instance's running extensions and their states. */
export class FeishuSessionExtensions {
  private readonly registry: FeishuExtensionRegistry;
  private readonly states = new Map<AnyExtension, unknown>();

  constructor(
    registry: FeishuExtensionRegistry | undefined,
    private readonly log: DreamuxLogger,
  ) {
    this.registry = registry ?? new FeishuExtensionRegistry();
  }

  /**
   * In registration order; a throw is logged naming the extension, then
   * propagates and fails the instance.
   */
  async initialize(input: FeishuExtensionInitializeInput): Promise<void> {
    for (const ext of this.registry.list()) {
      const state = await this.attributed(ext, 'initialize', () =>
        ext.initialize({
          dispatcherId: input.dispatcherId,
          channelId: input.channelId,
          stateRoot: this.registry.stateRoot(
            input.dispatcherId,
            ext.name,
            input.channelId,
          ),
          signal: input.signal,
          log: this.log.child({ feishu_extension: ext.name }),
          api: input.api,
        }),
      );
      this.states.set(ext, state);
    }
  }

  /**
   * In registration order; a throw is logged naming the extension, then
   * propagates and fails the instance.
   */
  async start(): Promise<void> {
    for (const [ext, state] of this.states) {
      await this.attributed(ext, 'start', () => ext.start(state));
    }
  }

  /**
   * In reverse order. A failure is logged and the rest still close, because
   * the session teardown that calls this must go on to drain its own store.
   */
  async close(): Promise<void> {
    const running = [...this.states].reverse();
    this.states.clear();
    for (const [ext, state] of running) {
      await this.attributed(ext, 'close', () => ext.close(state)).catch(
        () => undefined,
      );
    }
  }

  /**
   * The extension tool this caller kind means by `name`, over its state.
   * Unavailable until this instance's `initialize` has filled that
   * extension's state — the same "no such tool" refusal a caller sees for a
   * name nothing registered.
   */
  tool(
    name: string,
    kind: ChannelMcpCaller['kind'],
  ): FeishuBoundExtensionTool | undefined {
    for (const ext of this.registry.list()) {
      const def = ext.tools.find(
        (tool) => tool.name === name && tool.callers.includes(kind),
      );
      if (def === undefined || !this.states.has(ext)) continue;
      return {
        def,
        invoke: async (caller, raw) =>
          def.handle({ caller, state: this.states.get(ext) }, def.parse(raw)),
      };
    }
    return undefined;
  }

  /**
   * The extension card action claiming `key`, over its state. Unavailable
   * until this instance's `initialize` has filled that extension's state,
   * the same as `tool` above.
   */
  action(key: string): FeishuExtensionActionHandler | undefined {
    for (const ext of this.registry.list()) {
      const def = ext.cardActions.find((action) => action.key === key);
      if (def === undefined || !this.states.has(ext)) continue;
      return {
        extensionName: ext.name,
        // The Lark SDK logs a rejected callback without knowing its owner.
        invoke: (event) =>
          this.attributed(ext, 'card action', () =>
            def.handle(this.states.get(ext), event),
          ),
      };
    }
    return undefined;
  }

  /** Run one extension step; a rejection is logged naming the extension and rethrown. */
  private async attributed<T>(
    ext: AnyExtension,
    step: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      this.log.error(
        {
          feishu_extension: ext.name,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        `Feishu extension ${step} failed`,
      );
      throw err;
    }
  }
}

export interface FeishuBoundExtensionTool {
  readonly def: FeishuExtensionTool<unknown>;
  invoke(caller: ChannelMcpCaller, raw: unknown): Promise<FeishuToolResult>;
}

/**
 * Where one extension delivery says its input came from: the checked target's
 * own address, with the caller's metadata underneath it.
 *
 * A caller supplies identity and business fields, but not these three — the
 * operation already holds the conversation it verified, and a caller that
 * overrode `chat_id` or invented a `thread_id` for a conversation that has
 * none would state provenance the Channel knows to be false.
 *
 * The result is built with `Object.fromEntries`, never by assigning onto a
 * plain object: attribute names are an open caller-chosen string set, so an
 * own `__proto__` key is ordinary metadata — the same shape and the same
 * construction Core's own `channel-submission.ts` reader keeps, and one that
 * `canonicalJsonValue` carries across the Command boundary as data.
 */
function deliveryAttrs(
  target: FeishuTarget,
  attrs: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const fields: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (name !== 'source' && name !== 'chat_id' && name !== 'thread_id') {
      fields.push([name, value]);
    }
  }
  fields.push(['source', 'feishu'], ['chat_id', target.chatId]);
  if (target.threadId !== undefined) {
    fields.push(['thread_id', target.threadId]);
  }
  return Object.fromEntries(fields) as Record<string, string>;
}

/**
 * The instance api for one session lifecycle. `lifecycle` is that session's
 * one liveness value, so every outbound call made after the instance began
 * closing rejects as `aborted` — `assertLive()` is `FeishuLifecycle`'s own
 * check, not a second one re-derived here.
 */
export function buildInstanceApi(input: {
  lifecycle: FeishuLifecycle;
  outbound: FeishuOutbound;
  /** Card repaint (`editCard`) reaches the bot directly; see `outbound/index.ts`'s header. */
  bot: Pick<FeishuBot, 'editCard'>;
  targetRouter: Pick<FeishuInboundTargeting, 'project'>;
  routing: FeishuRouting;
  bindings: FeishuBindingOperations;
  commands: FeishuCoreCommands;
}): FeishuInstanceApi {
  const {
    lifecycle,
    outbound,
    bot,
    targetRouter,
    routing,
    bindings,
    commands,
  } = input;
  return {
    owner(target) {
      const plan = routing.plan(target, null);
      return plan.kind === 'bound' ? plan.teamName : null;
    },
    async readMessageRoute(messageId) {
      lifecycle.assertLive();
      const route = await outbound.locate(messageId);
      return { target: route.target };
    },
    async bindTeam({ target, teamName, display }) {
      lifecycle.assertLive();
      // Tracked: the bind writes routing after an awaited Core status read,
      // which must not land after the instance closed its routing store.
      await lifecycle.track(
        bindings.bindChannel({ target, teamName, display }),
      );
    },
    submitToBoundTeam({
      target,
      expectedTeamName,
      text,
      sourceId,
      attrs,
      reminder,
    }) {
      // Checked, captured and invoked in one synchronous turn: nothing between
      // the plan and the Command can run, so the Team the call reaches is the
      // Team this check saw. A binding committed afterwards retargets the next
      // call, never this one.
      if (!lifecycle.isLive()) {
        return Promise.resolve({ status: 'refused', reason: 'closed' });
      }
      const plan = routing.plan(target, null);
      if (plan.kind !== 'bound' || plan.teamName !== expectedTeamName) {
        return Promise.resolve({
          status: 'refused',
          reason: 'binding_changed',
        });
      }
      const submission: FeishuSubmissionPayload = {
        attrs: deliveryAttrs(target, attrs),
        text,
        reminder: reminder ?? CHANNEL_REMINDER,
        sourceId,
      };
      return lifecycle.track(commands.teamSubmit(plan.teamName, submission));
    },
    async sendCard({ chatId, replyTo, card, caller }) {
      const sent = await outbound.sendCard({
        target: {
          chatId,
          ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}),
        },
        sender: agentSender(caller),
        card,
      });
      const sentMessage = sent.messages[0];
      if (sentMessage === undefined) {
        throw new Error('Feishu returned no message id for the sent card');
      }
      // Where the card landed, from Feishu's own send response: a chat-mode
      // lookup only for a chat this session has not already resolved, no
      // second `readMessage` round trip.
      const { target } = await targetRouter.project({
        chatId: sentMessage.chatId,
        threadId: sentMessage.threadId,
      });
      return { messageId: sentMessage.messageId, target };
    },
    async editCard(messageId, card) {
      lifecycle.assertLive();
      await bot.editCard(messageId, card);
    },
  };
}

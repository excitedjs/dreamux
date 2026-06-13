/**
 * The built-in Feishu `ChannelProvider` (issue #209 slice 5).
 *
 * Implements the neutral `@excitedjs/dreamux-types` `ChannelProvider` /
 * `ChannelSession` contract on top of the package's own {@link FeishuChannelSession}
 * (the platform-I/O + access/trust + inbound-normalization + tool-backing engine).
 *
 * Production note: Dreamux core does NOT drive this neutral path today. Core's
 * dispatcher wiring still uses the package's richer host-shaped session API (a
 * result-returning inbound submitter that the reaction ledger keys off, the
 * core-owned MCP server descriptor, and admin-routed tool dispatch). Converging
 * core onto `start(routes)` / `tools()` / `handleTool()` is the deferred Channel
 * MCP migration. This neutral facade is genuine and self-contained — `reply`,
 * `react`, `resolveTarget`, `tools`, `handleTool`, and `messageBelongsToTarget`
 * are wired to the real session logic; only `start(routes)` is real-but-not-the-
 * production-path (its `routes.deliver` is void, so it cannot carry the submit
 * delivery result the production reaction ledger needs). It keeps the package a
 * first-class, loader-real `ChannelProvider` for the generic channel loader and
 * for external embedders.
 */
import type {
  ChannelInboundEnvelope,
  ChannelProvider,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelSession,
  ChannelSessionCreateContext,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolDescriptor,
  DreamuxLogger,
  ProviderDescriptor,
} from '@excitedjs/dreamux-types';
import {
  FeishuChannelSession,
  type FeishuChannelLogger,
  type FeishuInboundEnvelope,
} from './feishu-channel.js';
import { feishuMcpTools } from './feishu-mcp-tools.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';

/** Validated Feishu channel config the neutral session is constructed from. */
export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
}

const DEFAULT_FEISHU_DESCRIPTOR: ProviderDescriptor & { kind: 'channel' } = {
  id: 'feishu',
  kind: 'channel',
  ref: { source: 'builtin', id: 'feishu', raw: BUILTIN_FEISHU_PROVIDER_REF },
};

/** Adapt the neutral message-first logger to the session's fields-first logger. */
function channelLoggerFromNeutral(
  logger: DreamuxLogger | undefined,
): FeishuChannelLogger {
  const sink =
    (level: 'error' | 'warn' | 'info' | 'debug' | 'trace') =>
    (fields: Record<string, unknown>, message: string): void => {
      logger?.[level](message, fields);
    };
  return {
    error: sink('error'),
    warn: sink('warn'),
    info: sink('info'),
    debug: sink('debug'),
    trace: sink('trace'),
  };
}

function targetChatId(target: ChannelTarget): string {
  const fromMeta = target.meta?.['chat_id'];
  return typeof fromMeta === 'string' && fromMeta !== ''
    ? fromMeta
    : target.target_key;
}

function inboundEnvelopeToNeutral(
  channelId: string,
  envelope: FeishuInboundEnvelope,
): ChannelInboundEnvelope {
  return {
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    channel_id: channelId,
    target: {
      target_type: envelope.chatType,
      target_key: envelope.chatId,
      bindable: envelope.chatType === 'group',
      meta: { chat_id: envelope.chatId, chat_type: envelope.chatType },
    },
    message_id: envelope.messageId,
  };
}

/** The neutral `ChannelSession` wrapper over the package's Feishu session. */
class NeutralFeishuChannelSession implements ChannelSession {
  readonly provider = BUILTIN_FEISHU_PROVIDER_REF;

  constructor(
    readonly channel_id: string,
    private readonly session: FeishuChannelSession,
  ) {}

  async start(routes: ChannelRoutes): Promise<void> {
    await this.session.start({
      submitTurn: async (_input, envelope) => {
        await routes.deliver(inboundEnvelopeToNeutral(this.channel_id, envelope));
        return { status: 'submitted', turnId: envelope.messageId };
      },
    });
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async resolveTarget(meta: unknown): Promise<ChannelTarget> {
    const obj = (meta ?? {}) as Record<string, unknown>;
    const chatId = obj['chat_id'];
    const chatType = obj['chat_type'];
    if (typeof chatId !== 'string' || chatId === '') {
      throw new Error('feishu resolveTarget requires a non-empty chat_id');
    }
    const type = chatType === 'p2p' ? 'p2p' : 'group';
    return {
      target_type: type,
      target_key: chatId,
      bindable: type === 'group',
      meta: { chat_id: chatId, chat_type: type },
    };
  }

  async reply(input: ChannelReplyInput): Promise<unknown> {
    const messageId = input.meta?.['message_id'];
    return this.session.handleMcpTool('reply', {
      chat_id: targetChatId(input.target),
      text: input.text,
      ...(typeof messageId === 'string' ? { message_id: messageId } : {}),
    });
  }

  async react(input: ChannelReactInput): Promise<unknown> {
    return this.session.handleMcpTool('react', {
      chat_id: targetChatId(input.target),
      message_id: input.message_id,
      emoji: input.reaction,
    });
  }

  tools(): readonly ChannelToolDescriptor[] {
    return feishuMcpTools().map((tool) => ({
      name: tool['name'] as string,
      description: tool['description'] as string,
      inputSchema: tool['inputSchema'],
    }));
  }

  async handleTool(call: ChannelToolCall): Promise<unknown> {
    return this.session.handleMcpTool(
      call.name as 'reply' | 'react' | 'list_chat_bots',
      call.arguments,
    );
  }

  messageBelongsToTarget(input: {
    target: ChannelTarget;
    message_id: string;
  }): boolean {
    return this.session.messageBelongsToChat(
      input.message_id,
      targetChatId(input.target),
    );
  }
}

/**
 * Create the built-in Feishu `ChannelProvider`. `readConfig` validates the
 * `{ app_id, app_secret }` block; `createSession` builds the package's Feishu
 * session from the neutral create context (state/cache roots, logger) and wraps
 * it in the neutral `ChannelSession` adapter.
 */
export function createFeishuChannelProvider(): ChannelProvider<FeishuChannelConfig> {
  return {
    ref: BUILTIN_FEISHU_PROVIDER_REF,
    descriptor: DEFAULT_FEISHU_DESCRIPTOR,
    readConfig(raw): FeishuChannelConfig {
      const obj = (raw ?? {}) as Record<string, unknown>;
      // The Feishu channel owns its config validation (issue #209 multi-channel
      // slice): the host no longer pre-validates Feishu app credentials. The bot
      // secret is config-sourced, so a non-empty app_secret is required at
      // config-load time to preserve fail-loud — not deferred to session start.
      const unknown = Object.keys(obj).filter(
        (key) => key !== 'app_id' && key !== 'app_secret',
      );
      if (unknown.length > 0) {
        throw new Error(
          `feishu channel config has unknown key(s): ${unknown
            .map((key) => `'${key}'`)
            .join(', ')}. Allowed: app_id, app_secret.`,
        );
      }
      const appId = obj['app_id'];
      const appSecret = obj['app_secret'];
      if (typeof appId !== 'string' || appId.trim() === '') {
        throw new Error('feishu channel config requires a non-empty app_id');
      }
      if (typeof appSecret !== 'string' || appSecret.trim() === '') {
        throw new Error('feishu channel config requires a non-empty app_secret');
      }
      return { appId, appSecret };
    },
    createSession(
      context: ChannelSessionCreateContext<FeishuChannelConfig>,
    ): ChannelSession {
      const stateDir = context.state_root ?? '.';
      const cacheRoot = context.cache_root ?? stateDir;
      const session = new FeishuChannelSession({
        dispatcherId: context.dispatcher_id,
        appId: context.config.appId,
        appSecret: context.config.appSecret,
        stateDir,
        attachmentCacheDir: cacheRoot,
        log: channelLoggerFromNeutral(context.logger),
      });
      return new NeutralFeishuChannelSession(context.channel_id, session);
    },
  };
}

/**
 * Default export — the factory Dreamux core's generic channel package-loader
 * selects for the `builtin:feishu` ref (it imports this package and calls the
 * default export with `{ ref, descriptor }`). Production wires Feishu through the
 * core-owned adapter instead (see the module doc); this keeps the package a
 * loader-real `ChannelProvider`.
 */
export default function feishuChannelProviderFactory(_context: {
  ref: string;
  descriptor: ProviderDescriptor;
}): ChannelProvider<FeishuChannelConfig> {
  return createFeishuChannelProvider();
}

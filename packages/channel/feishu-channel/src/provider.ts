/**
 * The built-in Feishu `ChannelProvider` (issue #209 slice 5).
 *
 * Implements the neutral `@excitedjs/dreamux-types` `ChannelProvider` /
 * `ChannelSession` contract on top of the package's own {@link FeishuChannelSession}
 * (the platform-I/O + access/trust + inbound-normalization + tool-backing engine).
 *
 * The neutral seam is now fully load-bearing (issue #209 cleanup): `start(routes)`
 * forwards the normalized turn input + routing envelope to `routes.deliver` and
 * returns core's REAL `InboundDeliveryResult` (status + turnId), which the
 * session's reaction ledger keys off; `mcpServerDescriptor`, `handleSessionlessTool`,
 * `getIdentity`, `reply`, `react`, `resolveTarget`, `tools`, `handleTool`, and
 * `messageBelongsToTarget` are all wired to the real session logic. Core converges
 * its dispatcher wiring onto this neutral `ChannelSession` in the same cleanup; the
 * package never imports `@excitedjs/dreamux` and stays a first-class, loader-real
 * `ChannelProvider` for the generic channel loader and external embedders.
 */
import { join } from 'node:path';

import type {
  AgentRuntimeMcpServer,
  ChannelInboundEnvelope,
  ChannelMcpDescriptorContext,
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelProviderFactory,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelSession,
  ChannelSessionCreateContext,
  ChannelSessionlessToolContext,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolDescriptor,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import {
  DEFAULT_FEISHU_TOPIC_CONTEXT_POLICY,
  FeishuChannelSession,
  toWireChatBot,
  type FeishuInboundEnvelope,
  type FeishuTopicContextPolicy,
} from './feishu-channel.js';
import type { FeishuBot } from './bot.js';
import { listChatBots } from './chat-bots-store.js';
import { buildToolCatalog, parseFeishuMcpToolInput } from './feishu-mcp-tools.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from './provider-ref.js';

/**
 * The Feishu MCP server name (this channel's MCP tool namespace). Core ships a
 * generic `channel-mcp` stdio shim and neutral admin-method routing; the package
 * only needs the server name to shape the descriptor it returns from
 * `mcpServerDescriptor` below.
 */
const FEISHU_MCP_SERVER_NAME = 'feishu';

/** Validated Feishu channel config the neutral session is constructed from. */
export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  topicContext?: FeishuTopicContextPolicy;
}

const DEFAULT_FEISHU_DESCRIPTOR: ChannelProviderDescriptor = {
  id: 'feishu',
  kind: 'channel',
  ref: { source: 'builtin', id: 'feishu', raw: BUILTIN_FEISHU_PROVIDER_REF },
};

/**
 * Minimal `console.error`-backed logger the channel falls back to when the host
 * injects none (the standalone / generic-loader path; core always injects its
 * pino logger). Pino-shaped (fields-first) like the neutral `DreamuxLogger`, so
 * the session and transport consume it with no adapter. Owned here as
 * implementation code — never in the declaration-only `@excitedjs/dreamux-types`.
 */
function consoleFallbackLogger(dispatcherId: string): DreamuxLogger {
  const sink =
    (level: string) =>
    (fields: Record<string, unknown> | string, message?: string): void => {
      const prefix = `[feishu ${dispatcherId}] ${level}`;
      if (typeof fields === 'string') {
        console.error(prefix, fields);
        return;
      }
      // Never dump the whole fields bag — it can carry credentials and this
      // fallback has no `redact` policy (core's injected pino does). Surface
      // only `err`, matching the runtime packages' console fallbacks.
      const err = fields['err'];
      if (err !== undefined) console.error(prefix, message ?? '', err);
      else console.error(prefix, message ?? '');
    };
  return {
    error: sink('error'),
    warn: sink('warn'),
    info: sink('info'),
    debug: () => {},
    trace: () => {},
  };
}

function targetChatId(target: ChannelTarget): string {
  const fromMeta = target.meta?.['chat_id'];
  return typeof fromMeta === 'string' && fromMeta !== ''
    ? fromMeta
    : target.target_key;
}

function inboundEnvelopeToChannelEnvelope(
  channelId: string,
  envelope: FeishuInboundEnvelope,
): ChannelInboundEnvelope {
  const meta = {
    chat_id: envelope.chatId,
    chat_type: envelope.chatType,
    ...(envelope.chatMode !== undefined ? { chat_mode: envelope.chatMode } : {}),
    ...(envelope.threadId !== undefined ? { thread_id: envelope.threadId } : {}),
    ...(envelope.rootId !== undefined ? { root_id: envelope.rootId } : {}),
    ...(envelope.parentId !== undefined ? { parent_id: envelope.parentId } : {}),
  };
  return {
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    channel_id: channelId,
    target: {
      target_type: envelope.chatType,
      target_key: envelope.targetKey,
      bindable: envelope.chatType === 'group',
      meta,
    },
    message_id: envelope.messageId,
    metadata: meta,
  };
}

/** The `ChannelSession` adapter over the package's Feishu session. */
class FeishuChannelSessionAdapter implements ChannelSession {
  readonly provider = BUILTIN_FEISHU_PROVIDER_REF;

  constructor(
    readonly channel_id: string,
    private readonly session: FeishuChannelSession,
  ) {}

  async start(routes: ChannelRoutes): Promise<void> {
    await this.session.start({
      // The session normalized the turn into `input`; forward it plus the
      // channel routing envelope and the accept hooks to core, and return core's
      // REAL delivery result (status + turnId) so the session's reaction ledger
      // keys off the actually-submitted turn — not a fabricated id.
      submitTurn: (input, envelope, hooks) =>
        routes.deliver(
          input,
          inboundEnvelopeToChannelEnvelope(this.channel_id, envelope),
          hooks,
        ),
    });
  }

  mcpServerDescriptor(
    context: ChannelMcpDescriptorContext,
  ): AgentRuntimeMcpServer | null {
    // Build the generic `channel-mcp` stdio descriptor from the host bin command
    // + admin socket. Feishu always exposes its MCP surface, so this
    // never returns null. Core owns the bin path and the generic shim; the
    // package only shapes args. The provider + channel id are routed back through
    // the shim so a multi-channel dispatcher reaches the same live session whose
    // descriptor was injected. The tool LIST is static provider metadata, so it
    // travels with the descriptor (base64 JSON — robust through the runtime's arg
    // layer) and the generic shim serves `tools/list` from it WITHOUT an admin
    // round-trip; only `tools/call` reaches the live session.
    const toolsB64 = Buffer.from(JSON.stringify(buildToolCatalog()), 'utf8').toString(
      'base64',
    );
    return {
      name: FEISHU_MCP_SERVER_NAME,
      command: context.command,
      args: [
        'channel-mcp',
        '--provider',
        context.provider,
        '--channel-id',
        context.channel_id,
        '--dispatcher',
        context.dispatcher_id,
        ...(context.callerKind !== undefined
          ? ['--caller', context.callerKind]
          : []),
        ...(context.team_id !== undefined ? ['--team-id', context.team_id] : []),
        ...(context.leader_name !== undefined
          ? ['--leader-name', context.leader_name]
          : []),
        '--channel-tools-b64',
        toolsB64,
        '--admin-socket',
        context.adminSocketPath,
      ],
    };
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async resolveTarget(meta: unknown): Promise<ChannelTarget> {
    // Provider-owned target resolution lives on the raw session so both the
    // neutral wrapper and the core live path share one implementation (#209
    // binding store v2).
    return this.session.resolveTarget(meta);
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
    return buildToolCatalog().map((tool) => ({
      name: tool.name as string,
      description: tool.description as string,
      inputSchema: tool.inputSchema,
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
    return this.session.messageBelongsToTargetKey(
      input.message_id,
      input.target.target_key,
    );
  }
}

/** Options for {@link createFeishuChannelProvider}. */
export interface CreateFeishuChannelProviderOptions {
  /**
   * Test seam: build the underlying `FeishuBot` instead of opening a real Lark
   * connection. Mirrors the agent-runtime provider factories' process/session
   * seams. Receives the validated channel config so a test can key a bot by its
   * app identity (e.g. per-channel multi-bot routing). Omitted in production.
   */
  botFactory?: (config: FeishuChannelConfig) => FeishuBot;
}

/**
 * Create the built-in Feishu `ChannelProvider`. `readConfig` validates the
 * `{ app_id, app_secret, topicContext? }` block; `createSession` builds the
 * package's Feishu session from the neutral create context (state/cache roots,
 * logger) and wraps it in the neutral `ChannelSession` adapter.
 */
export function createFeishuChannelProvider(
  options: CreateFeishuChannelProviderOptions = {},
): ChannelProvider<FeishuChannelConfig> {
  return {
    ref: BUILTIN_FEISHU_PROVIDER_REF,
    descriptor: DEFAULT_FEISHU_DESCRIPTOR,
    getIdentity(config: FeishuChannelConfig): string {
      // Self-report the opaque channel identity (the bot app id). Core stores
      // and displays it without ever naming a Feishu config field.
      return config.appId;
    },
    onboard: {
      async collect(_context, prompts): Promise<Record<string, unknown>> {
        const appId = await prompts.text({
          message: 'Feishu bot app id',
          required: true,
        });
        const appSecret = await prompts.secret({
          message: 'Feishu bot app secret',
          required: true,
        });
        return {
          app_id: appId,
          app_secret: appSecret,
        };
      },
    },
    diagnostic: {
      binChecks() {
        return [];
      },
      async runDiagnostic() {
        return {
          ok: true,
          detail: 'Feishu channel has no host-managed diagnostics',
          errors: [],
        };
      },
    },
    async handleSessionlessTool(
      name: string,
      args: Record<string, unknown>,
      context: ChannelSessionlessToolContext,
    ): Promise<unknown> {
      // The only sessionless Feishu tool: list the bots in a chat before any
      // live session/binding exists. Reads the per-dispatcher state root.
      if (name !== 'list_chat_bots') {
        throw new Error(
          `${BUILTIN_FEISHU_PROVIDER_REF} has no sessionless tool ${JSON.stringify(name)}`,
        );
      }
      const parsed = parseFeishuMcpToolInput('list_chat_bots', args);
      if (parsed.toolName !== 'list_chat_bots') {
        throw new Error('feishu sessionless tool parse mismatch');
      }
      // Project to the same wire shape the live `handleTool` path returns
      // (`{ chat_id, known, trusted }` with `WireChatBot` open_ids), so a
      // sessionless `list_chat_bots` (no live session) is byte-identical to the
      // live one — core routes either way by session presence.
      const listInput = parsed.input as { chatId: string };
      const listing = await listChatBots(context.state_root ?? '.', listInput.chatId);
      return {
        chat_id: listInput.chatId,
        known: listing.known.map(toWireChatBot),
        trusted: listing.trusted.map(toWireChatBot),
      };
    },
    readConfig(raw): FeishuChannelConfig {
      const obj = (raw ?? {}) as Record<string, unknown>;
      // The Feishu channel owns its config validation (issue #209 multi-channel
      // slice): the host no longer pre-validates Feishu app credentials. The bot
      // secret is config-sourced, so a non-empty app_secret is required at
      // config-load time to preserve fail-loud — not deferred to session start.
      const unknown = Object.keys(obj).filter(
        (key) =>
          key !== 'app_id' &&
          key !== 'app_secret' &&
          key !== 'topicContext',
      );
      if (unknown.length > 0) {
        throw new Error(
          `feishu channel config has unknown key(s): ${unknown
            .map((key) => `'${key}'`)
            .join(', ')}. Allowed: app_id, app_secret, topicContext.`,
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
      return {
        appId,
        appSecret,
        topicContext: readTopicContextConfig(obj['topicContext']),
      };
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
        topicContext:
          context.config.topicContext ?? DEFAULT_FEISHU_TOPIC_CONTEXT_POLICY,
        // The channel owns its cache-subdir layout; core supplies only a
        // per-dispatcher cache root (issue #209 de-leak — core no longer names a
        // `feishu-attachments` dir). Effective path is unchanged.
        attachmentCacheDir: join(cacheRoot, 'feishu-attachments'),
        log: context.logger ?? consoleFallbackLogger(context.dispatcher_id),
        ...(options.botFactory !== undefined
          ? { botFactory: (): FeishuBot => options.botFactory!(context.config) }
          : {}),
      });
      return new FeishuChannelSessionAdapter(context.channel_id, session);
    },
  };
}

function readTopicContextConfig(raw: unknown): FeishuTopicContextPolicy {
  if (raw === undefined) return DEFAULT_FEISHU_TOPIC_CONTEXT_POLICY;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('feishu channel config topicContext must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter(
    (key) =>
      key !== 'enabled' &&
      key !== 'allowChatIds' &&
      key !== 'denyChatIds',
  );
  if (unknown.length > 0) {
    throw new Error(
      `feishu channel config topicContext has unknown key(s): ${unknown
        .map((key) => `'${key}'`)
        .join(', ')}. Allowed: enabled, allowChatIds, denyChatIds.`,
    );
  }
  const enabledRaw = obj['enabled'];
  if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') {
    throw new Error('feishu channel config topicContext.enabled must be boolean');
  }
  return {
    enabled: enabledRaw ?? DEFAULT_FEISHU_TOPIC_CONTEXT_POLICY.enabled,
    allowChatIds: readChatIdList(
      'topicContext.allowChatIds',
      obj['allowChatIds'],
    ),
    denyChatIds: readChatIdList(
      'topicContext.denyChatIds',
      obj['denyChatIds'],
    ),
  };
}

function readChatIdList(field: string, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`feishu channel config ${field} must be an array`);
  }
  const ids = new Set<string>();
  for (const [index, value] of raw.entries()) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `feishu channel config ${field}[${index}] must be a non-empty string`,
      );
    }
    ids.add(value.trim());
  }
  return [...ids];
}

/**
 * Default export — the factory Dreamux core's generic channel package-loader
 * selects for the `builtin:feishu` ref (it imports this package and calls the
 * default export with `{ ref, descriptor }`). Production wires Feishu through the
 * core-owned adapter instead (see the module doc); this keeps the package a
 * loader-real `ChannelProvider`.
 */
const feishuChannelProviderFactory: ChannelProviderFactory<FeishuChannelConfig> =
  () => createFeishuChannelProvider();

export default feishuChannelProviderFactory;

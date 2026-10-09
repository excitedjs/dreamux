/** Real Codex app-server and MCP, with Feishu platform IO replaced locally. */
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAgentRuntimeProvider } from '@excitedjs/agent-runtime-codex';
// Test-only internal coupling: native RPC ordering/types/version and the Feishu
// bot IO interception have no public seam. They retain real Codex/MCP evidence
// while preventing platform sends; provider construction uses public entries.
import { CodexWsClient } from '../../agent-runtime/codex/dist/rpc.js';
import { codexVersionSatisfies } from '../../agent-runtime/codex/dist/version.js';
import type {
  ServerNotification,
  ItemStartedNotification,
  ItemCompletedNotification,
  TurnStartResponse,
  InitializeResponse,
  ThreadStartResponse,
} from '../../agent-runtime/codex/dist/types.js';
import * as botModule from '../../channel/feishu-channel/dist/bot.js';
import type {
  FeishuBot,
  FeishuInboundRoutes,
} from '../../channel/feishu-channel/dist/bot.js';
import {
  createFeishuChannelProvider,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';
import type { ChannelInstance } from '@excitedjs/dreamux-types';
import { Server } from '../src/server.js';
import { ConfigService } from '../src/config/service.js';
import { globalConfigFile } from '../src/config/config.js';
import { dispatcherDir } from '../src/platform/paths.js';
import { dreamuxBinPath } from '../src/platform/package-bin.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { registerBuiltinProvider } from '../src/registry/builtins.js';
import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';

const capture = promisify(execFile);
const bin = process.env['CODEX_HOST_CODEX_BIN']?.trim() || 'codex';
const skip =
  process.env['DREAMUX_SKIP_LIVE_CODEX'] === '1' ||
  process.env['DREAMUX_RUN_LIVE_MODEL_GATE'] !== '1';
if (skip)
  console.warn(
    '[codex-live] Real #63 model gate excluded; set DREAMUX_RUN_LIVE_MODEL_GATE=1 with usable auth. This run does not certify folding.',
  );
async function waitFor(predicate: () => boolean, label: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function inbound(text: string, messageId: string): FeishuInboundEvent {
  return {
    messageId,
    chatId: 'chat-live',
    chatType: 'group',
    senderId: 'sender-live',
    senderType: 'user',
    senderName: 'Live tester',
    messageType: 'text',
    rawContent: JSON.stringify({ text }),
    text,
    resources: [],
    mentions: [
      { key: '@_user_1', id: { open_id: 'fake-bot' }, name: 'Dispatcher' },
    ],
    createTime: String(Date.now()),
    raw: {},
  };
}

describe('real Codex #63 inbound gate', () => {
  it.skipIf(skip)(
    'folds mid-operation Feishu input into one real turn and keeps reactions explicit',
    async () => {
      const { stdout } = await capture(bin, ['--version']);
      expect(codexVersionSatisfies(stdout)).toBe(true);
      const dir = await mkdtemp(join(tmpdir(), 'dreamux-r63-'));
      const oldRoot = process.env['DREAMUX_ROOT'];
      const oldBin = process.env['DREAMUX_BIN'];
      const authHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
      const codexHome = join(dir, 'codex');
      const cwd = join(dir, 'cwd');
      const root = join(dir, 'root');
      let server: Server | undefined;
      let routes: FeishuInboundRoutes | undefined;
      let instance: ChannelInstance | undefined;
      let liveClient: CodexWsClient | undefined;
      let sequence = 0;
      const requests: Array<{
        method: string;
        sent: number;
        ack?: number;
        result?: unknown;
      }> = [];
      const events: Array<{ order: number; notification: ServerNotification }> =
        [];
      const messages: Array<{
        order: number;
        target: Parameters<FeishuBot['send']>[0];
        text: string;
      }> = [];
      const reactions: Array<{ messageId: string; emoji: string }> = [];
      const unsupported = async (): Promise<never> => {
        throw new Error('No platform fixture for this operation');
      };
      const bot: FeishuBot = {
        appId: 'app-live',
        botOpenId: 'fake-bot',
        botDisplayName: 'Dispatcher',
        async start(next) {
          routes = next;
        },
        async close() {
          routes = undefined;
        },
        async getChatMode() {
          return 'group';
        },
        async send(target, text) {
          messages.push({ order: ++sequence, target, text });
          return {
            messages: [
              {
                messageId: `sent-${messages.length}`,
                chatId: target.chatId,
                threadId: undefined,
              },
            ],
          };
        },
        async sendCard() {
          return {
            messages: [
              {
                messageId: 'card-live',
                chatId: 'chat-live',
                threadId: undefined,
              },
            ],
          };
        },
        async editCard() {},
        async addReaction(messageId, emoji) {
          reactions.push({ messageId, emoji });
          return 'reaction-live';
        },
        async resolveAppOwner() {
          return {};
        },
        fetchDocMeta: unsupported,
        fetchDocCommentText: unsupported,
        resolveWikiNode: unsupported,
        fetchMessageResource: unsupported,
      };
      const realRequest = CodexWsClient.prototype.request;
      const observed = new WeakSet<CodexWsClient>();
      const requestSpy = vi
        .spyOn(CodexWsClient.prototype, 'request')
        .mockImplementation(async function <R = unknown>(
          this: CodexWsClient,
          method: string,
          params: unknown,
        ): Promise<R> {
          if (!observed.has(this)) {
            liveClient = this;
            observed.add(this);
            this.onNotification((notification) =>
              events.push({ order: ++sequence, notification }),
            );
          }
          const row: (typeof requests)[number] = { method, sent: ++sequence };
          requests.push(row);
          const result = await realRequest.call(this, method, params);
          row.result = result;
          row.ack = ++sequence;
          return result as R;
        });
      const botSpy = vi
        .spyOn(botModule, 'createFeishuBot')
        .mockReturnValue(bot);
      const channel = createFeishuChannelProvider();
      const realCreateSession = channel.createSession.bind(channel);
      const sessionSpy = vi
        .spyOn(channel, 'createSession')
        .mockImplementation(async (context) => {
          instance = await realCreateSession(context);
          return instance;
        });
      const notifications = (method: string) =>
        events.filter((event) => event.notification.method === method);
      const turns = () =>
        requests.filter((request) => request.method === 'turn/start');
      const blockingStart = () =>
        notifications('item/started').find((event) => {
          const { item } = event.notification.params as ItemStartedNotification;
          return (
            item.type === 'commandExecution' &&
            typeof item.command === 'string' &&
            item.command.includes('issue63-sleep-done')
          );
        });
      try {
        await Promise.all([mkdir(codexHome), mkdir(cwd), mkdir(root)]);
        // Keep the operator's actual model provider/auth configuration, in a disposable home.
        for (const file of ['auth.json', 'config.toml']) {
          try {
            await copyFile(join(authHome, file), join(codexHome, file));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        process.env['DREAMUX_ROOT'] = root;
        process.env['DREAMUX_BIN'] = dreamuxBinPath({});
        await writeFile(
          globalConfigFile(),
          JSON.stringify({
            agents: [
              {
                id: 'live',
                provider: 'builtin:codex',
                config: {
                  bin,
                  sandbox_mode: 'danger-full-access',
                  extra_env: { CODEX_HOME: codexHome },
                  initialize_timeout_ms: 15_000,
                },
              },
            ],
            dispatchers: [
              {
                id: 'live',
                enabled: true,
                cwd,
                agentRuntime: 'live',
                channels: [
                  {
                    id: 'primary',
                    provider: 'builtin:feishu',
                    config: { app_id: 'app-live', app_secret: 'fake-secret' },
                  },
                ],
              },
            ],
          }),
          { mode: 0o600 },
        );
        await mkdir(dispatcherDir('live'), { recursive: true });
        await writeFile(
          join(dispatcherDir('live'), 'access.json'),
          JSON.stringify({
            version: 3,
            dm_policy: 'pairing',
            allow_users: ['sender-live'],
            group: {
              policy: 'follow-user',
              allow_chats: [],
              require_mention: true,
            },
            pending: {},
          }),
          { mode: 0o600 },
        );
        const config = await ConfigService.open({
          providerRegistry: new ProviderRegistry(),
        });
        const registry = new ProviderRegistry();
        registerBuiltinProvider(
          registry,
          { id: 'codex', kind: 'agentRuntime' },
          createCodexAgentRuntimeProvider(),
        );
        registerBuiltinProvider(
          registry,
          { id: 'feishu', kind: 'channel' },
          channel,
        );
        server = new Server({
          config,
          adminSocketPath: join(dir, 'admin.sock'),
          agentRuntimeProviderCatalog: new AgentRuntimeProviderCatalog({
            registry,
          }),
          channelProviderCatalog: new ChannelProviderCatalog({ registry }),
        });
        await server.start();
        const marker = `ISSUE63_LIVE_MARKER_${Date.now()}`;
        await routes!.onMessage(
          inbound(
            [
              'Integration gate. Follow this exact sequence.',
              'First call exec_command with cmd "sleep 6; echo issue63-sleep-done" and wait for completion.',
              'After it returns, inspect later Feishu input folded into this turn.',
              'Reply through the Feishu MCP reply tool to the later marker message, echoing its marker verbatim.',
              'Do not react or send a plain assistant answer before the reply tool call.',
            ].join('\n'),
            'setup-live',
          ),
        );
        await waitFor(
          () => blockingStart() !== undefined,
          'blocking command started',
        );
        // Preserve the former live startup case within this actual app-server run.
        const initialized = requests.find(
          (request) => request.method === 'initialize',
        );
        expect(initialized?.ack).toBeDefined();
        const initializedResult = initialized!.result as InitializeResponse;
        expect(typeof initializedResult.userAgent).toBe('string');
        expect(initializedResult.userAgent.length).toBeGreaterThan(0);
        expect(initializedResult.platformOs).toBeDefined();
        const threadStarted = requests.find(
          (request) => request.method === 'thread/start',
        );
        expect(threadStarted?.ack).toBeDefined();
        const threadStartedResult = threadStarted!
          .result as ThreadStartResponse;
        expect(typeof threadStartedResult.thread.id).toBe('string');
        expect(threadStartedResult.thread.id.length).toBeGreaterThan(0);
        expect(initialized!.ack!).toBeLessThan(threadStarted!.sent);
        const itemId = (
          blockingStart()!.notification.params as ItemStartedNotification
        ).item.id;
        const blockingEnd = () =>
          notifications('item/completed').find(
            (event) =>
              (event.notification.params as ItemCompletedNotification).item
                .id === itemId,
          );
        expect(blockingEnd()).toBeUndefined();
        expect(notifications('turn/completed')).toHaveLength(0);
        await routes!.onMessage(
          inbound(`Please handle this folded marker: ${marker}`, 'marker-live'),
        );
        expect(turns()).toHaveLength(2);
        expect(turns()[1]!.ack).toBeDefined();
        expect(blockingEnd()).toBeUndefined();
        expect(notifications('turn/completed')).toHaveLength(0);
        expect((turns()[1]!.result as TurnStartResponse).turn.id).toBe(
          (turns()[0]!.result as TurnStartResponse).turn.id,
        );
        await waitFor(
          () => messages.some((message) => message.text.includes(marker)),
          'marker replied through real MCP',
          120_000,
        );
        await waitFor(
          () => notifications('turn/completed').length === 1,
          'native completion',
        );
        const reply = messages.find((message) =>
          message.text.includes(marker),
        )!;
        expect(reply.target).toMatchObject({
          chatId: 'chat-live',
          replyToMessageId: 'marker-live',
        });
        expect(blockingEnd()).toBeDefined();
        expect(turns()[1]!.ack!).toBeLessThan(blockingEnd()!.order);
        expect(blockingEnd()!.order).toBeLessThan(reply.order);
        expect(turns()[1]!.ack!).toBeLessThan(
          notifications('turn/completed')[0]!.order,
        );
        expect(turns()).toHaveLength(2);
        expect(reactions).toEqual([]);
        // The real app-server reached the generic MCP shim and its whole
        // Feishu catalog, including tools this turn did not need to call.
        const mcpStatus = await liveClient!.request<{
          data: Array<{
            name: string;
            tools: Record<string, { name: string }>;
          }>;
        }>('mcpServerStatus/list', {});
        const feishu = mcpStatus.data.find(
          (entry) => entry.name === 'channel-feishu',
        );
        expect(feishu).toBeDefined();
        for (const name of ['reply', 'react', 'list_chat_bots']) {
          expect(feishu?.tools[name]?.name).toBe(name);
        }
        expect(
          await instance!.mcp!.invoke(
            {
              name: 'react',
              arguments: {
                message_id: 'marker-live',
                chat_id: 'chat-live',
                emoji: 'THUMBSUP',
              },
            },
            {
              dispatcher_id: 'live',
              channel_id: 'primary',
              caller: { kind: 'dispatcher' },
            },
          ),
        ).toMatchObject({ ok: true, value: { reaction_id: 'reaction-live' } });
        expect(reactions).toEqual([
          { messageId: 'marker-live', emoji: 'THUMBSUP' },
        ]);
      } finally {
        try {
          await server?.shutdown();
        } finally {
          requestSpy.mockRestore();
          botSpy.mockRestore();
          sessionSpy.mockRestore();
          if (oldRoot === undefined) delete process.env['DREAMUX_ROOT'];
          else process.env['DREAMUX_ROOT'] = oldRoot;
          if (oldBin === undefined) delete process.env['DREAMUX_BIN'];
          else process.env['DREAMUX_BIN'] = oldBin;
          await rm(dir, { recursive: true, force: true });
        }
      }
    },
    240_000,
  );
});

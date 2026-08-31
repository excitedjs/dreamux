/**
 * A package-local `FeishuBot` double for the live Codex gate (issue #63
 * restoration, Stage 9 node `live-codex-gate`).
 *
 * Injected through `createFeishuChannelProvider({ botFactory })` (see
 * `./live-catalogs.ts`), so the REAL `@excitedjs/feishu-channel` session,
 * gate, routing, and MCP tool code all run unmodified; only the Lark
 * long-connection + HTTP calls are replaced. This keeps the live gate's
 * network surface to exactly one process: the real `codex` app-server.
 *
 * Every non-`FeishuBot` type here is derived structurally
 * (`Parameters<FeishuBot['x']>` / `Awaited<ReturnType<...>>`) rather than
 * imported by name, because several of them (`FeishuInboundRoutes`,
 * `FeishuSendResult`, ...) are internal to `@excitedjs/feishu-channel` /
 * `@excitedjs/feishu-transport` and not part of either package's public
 * surface — the same idiom the `next`-branch double used.
 *
 * Rebuilt against the CURRENT `FeishuBot` contract in
 * `@excitedjs/feishu-channel`'s `bot.ts` — deliberately NOT a port of the
 * `next`-branch double, which predates issue #63's reaction-lifecycle
 * removal: `removeReaction` no longer exists on `FeishuBot` at all (see
 * `.agents/reference/current-architecture.md` "Automatic received/in-progress
 * reactions are removed; the explicit model-facing `react` tool remains").
 * `reactions` here only records the deliberate `addReaction` calls a model
 * makes through the `react` MCP tool — there is no automatic tri-state left
 * to track, and a live-gate test proves that removal by asserting `reactions`
 * stays empty across ordinary inbound delivery.
 */
import type { FeishuBot, FeishuInboundEvent } from '@excitedjs/feishu-channel';

type FeishuInboundRoutes = Parameters<FeishuBot['start']>[0];
type FeishuOutboundTarget = Parameters<FeishuBot['send']>[0];
type FeishuSendResult = Awaited<ReturnType<FeishuBot['send']>>;
type FeishuInviteMembersInput = Parameters<FeishuBot['inviteMembers']>[0];
type FeishuInviteMembersResult = Awaited<ReturnType<FeishuBot['inviteMembers']>>;
type FeishuMessageResourceRequest = Parameters<
  FeishuBot['fetchMessageResource']
>[0];
type FeishuMessageResourceResponse = Awaited<
  ReturnType<FeishuBot['fetchMessageResource']>
>;
type FeishuAppOwnerIdentity = Awaited<ReturnType<FeishuBot['resolveAppOwner']>>;

export interface FakeFeishuBot extends FeishuBot {
  readonly sentMessages: Array<{
    chatId: string;
    target: FeishuOutboundTarget;
    text: string;
    messageIds: string[];
  }>;
  readonly sentCards: Array<{
    chatId: string;
    target: FeishuOutboundTarget;
    card: unknown;
    messageIds: string[];
  }>;
  /**
   * Every `addReaction` call this bot observed, in order. The removed
   * automatic received/in-progress lifecycle means a live-gate test expects
   * this to stay empty for ordinary inbound delivery; it is populated only by
   * a deliberate model-facing `react` tool call.
   */
  readonly reactions: Array<{ messageId: string; emoji: string; reactionId: string }>;
  inject(event: FeishuInboundEvent): Promise<void>;
}

/** Test-local `FeishuBot` double for the live Codex gate. */
export function createFakeFeishuBot(appId = 'fake-bot'): FakeFeishuBot {
  const sentMessages: FakeFeishuBot['sentMessages'] = [];
  const sentCards: FakeFeishuBot['sentCards'] = [];
  const reactions: FakeFeishuBot['reactions'] = [];
  let routes: FeishuInboundRoutes | null = null;
  let nextMessageId = 1;
  let nextReactionId = 1;

  return {
    appId,
    botOpenId: `fake-open-id-${appId}`,
    botDisplayName: `Fake ${appId}`,

    async start(nextRoutes: FeishuInboundRoutes): Promise<void> {
      routes = nextRoutes;
    },

    async send(
      target: FeishuOutboundTarget,
      text: string,
    ): Promise<FeishuSendResult> {
      const messageId = `message-fake-${nextMessageId++}`;
      const messageIds = [messageId];
      sentMessages.push({ chatId: target.chatId, target, text, messageIds });
      return { messageIds };
    },

    async sendCard(
      target: FeishuOutboundTarget,
      card: unknown,
    ): Promise<FeishuSendResult> {
      const messageIds = [`message-fake-${nextMessageId++}`];
      sentCards.push({ chatId: target.chatId, target, card, messageIds });
      return { messageIds };
    },

    async inviteMembers(
      input: FeishuInviteMembersInput,
    ): Promise<FeishuInviteMembersResult> {
      return { addedOpenIds: input.userOpenIds };
    },

    async addReaction(messageId: string, emoji: string): Promise<string> {
      const reactionId = `reaction-fake-${nextReactionId++}`;
      reactions.push({ messageId, emoji, reactionId });
      return reactionId;
    },

    async fetchMessageResource(
      _request: FeishuMessageResourceRequest,
    ): Promise<FeishuMessageResourceResponse> {
      throw new Error('no fake Feishu message resources configured');
    },

    async resolveAppOwner(): Promise<FeishuAppOwnerIdentity> {
      return {};
    },

    async close(): Promise<void> {
      routes = null;
    },

    get sentMessages() {
      return sentMessages;
    },

    get sentCards() {
      return sentCards;
    },

    get reactions() {
      return reactions;
    },

    async inject(event: FeishuInboundEvent): Promise<void> {
      if (routes === null) throw new Error('fake bot not started');
      await routes.onMessage(event);
    },
  };
}

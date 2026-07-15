import type {
  FeishuBot,
  FeishuInboundEvent,
} from '@excitedjs/feishu-channel';

type FeishuInboundRoutes = Parameters<FeishuBot['start']>[0];
type FeishuOutboundTarget = Parameters<FeishuBot['send']>[0];
type FeishuSendResult = Awaited<ReturnType<FeishuBot['send']>>;
type FeishuInviteMembersInput = Parameters<FeishuBot['inviteMembers']>[0];
type FeishuInviteMembersResult = Awaited<ReturnType<FeishuBot['inviteMembers']>>;
type FeishuChatMode = Awaited<
  ReturnType<NonNullable<FeishuBot['getChatMode']>>
>;
type FeishuMessageResourceRequest = Parameters<FeishuBot['fetchMessageResource']>[0];
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
  readonly reactions: Array<{
    messageId: string;
    emoji: string;
    reactionId: string;
  }>;
  readonly removedReactions: Array<{
    messageId: string;
    reactionId: string;
  }>;
  readonly reactionOps: Array<
    | { op: 'add'; messageId: string; emoji: string; reactionId: string }
    | { op: 'remove'; messageId: string; reactionId: string }
  >;
  inject(event: FeishuInboundEvent): Promise<void>;
  setChatMode(chatId: string, mode: FeishuChatMode | Error): void;
}

/** Test-local FeishuBot double for Dreamux host/provider integration tests. */
export function createFakeFeishuBot(appId: string = 'fake-bot'): FakeFeishuBot {
  const sentMessages: FakeFeishuBot['sentMessages'] = [];
  const reactions: FakeFeishuBot['reactions'] = [];
  const removedReactions: FakeFeishuBot['removedReactions'] = [];
  const reactionOps: FakeFeishuBot['reactionOps'] = [];
  const chatModes = new Map<string, FeishuChatMode | Error>();
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
      sentMessages.push({
        chatId: target.chatId,
        target,
        text,
        messageIds,
      });
      return { messageIds };
    },

    async sendCard(
      _target: FeishuOutboundTarget,
      _card: unknown,
    ): Promise<FeishuSendResult> {
      return { messageIds: [`message-fake-${nextMessageId++}`] };
    },

    async inviteMembers(
      input: FeishuInviteMembersInput,
    ): Promise<FeishuInviteMembersResult> {
      return { addedOpenIds: input.userOpenIds };
    },

    async getChatMode(chatId: string): Promise<FeishuChatMode> {
      const mode = chatModes.get(chatId);
      if (mode instanceof Error) throw mode;
      return mode;
    },

    async addReaction(messageId: string, emoji: string): Promise<string> {
      const reactionId = `reaction-fake-${nextReactionId++}`;
      reactions.push({ messageId, emoji, reactionId });
      reactionOps.push({ op: 'add', messageId, emoji, reactionId });
      return reactionId;
    },

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      removedReactions.push({ messageId, reactionId });
      reactionOps.push({ op: 'remove', messageId, reactionId });
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

    get reactions() {
      return reactions;
    },

    get removedReactions() {
      return removedReactions;
    },

    get reactionOps() {
      return reactionOps;
    },

    async inject(event: FeishuInboundEvent): Promise<void> {
      if (routes === null) throw new Error('fake bot not started');
      await routes.onMessage(event);
    },

    setChatMode(chatId: string, mode: FeishuChatMode | Error): void {
      if (mode === undefined) chatModes.delete(chatId);
      else chatModes.set(chatId, mode);
    },
  };
}

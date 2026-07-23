import type {
  FeishuAppOwnerIdentity,
  FeishuBotMemberAddedEvent,
  FeishuChatMode,
  FeishuInviteMembersInput,
  FeishuInviteMembersResult,
  FeishuMessageResourceRequest,
  FeishuMessageResourceResponse,
  FeishuMessageReadMode,
  FeishuMessageReadRequest,
  FeishuMessageReadResponse,
  FeishuSendOptions,
  OutboundTarget,
} from '@excitedjs/feishu-transport';

import type {
  FeishuBot,
  FeishuCardActionEvent,
  FeishuInboundEvent,
  FeishuInboundRoutes,
  FeishuSendResult,
} from '../../src/bot.js';

export interface FakeFeishuBot extends FeishuBot {
  readonly sentMessages: Array<{
    chatId: string;
    target: OutboundTarget;
    text: string;
    messageIds: string[];
  }>;
  readonly sentCards: Array<{
    chatId: string;
    target: OutboundTarget;
    card: unknown;
    messageIds: string[];
  }>;
  readonly deliveredCards: Array<{
    chatId: string;
    target: OutboundTarget;
    card: unknown;
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
  /** Combined add/remove timeline, in call order (tests assert ordering). */
  readonly reactionOps: Array<
    | { op: 'add'; messageId: string; emoji: string; reactionId: string }
    | { op: 'remove'; messageId: string; reactionId: string }
  >;
  readonly chatModeRequests: string[];
  readonly messageReadRequests: FeishuMessageReadRequest[];
  readonly messageResourceRequests: FeishuMessageResourceRequest[];
  inject(event: FeishuInboundEvent): Promise<void>;
  injectBotMemberAdded(event: FeishuBotMemberAddedEvent): Promise<void>;
  injectCardAction(event: FeishuCardActionEvent): Promise<unknown>;
  setAppOwner(owner: FeishuAppOwnerIdentity): void;
  setChatMode(chatId: string, mode: FeishuChatMode | Error | undefined): void;
  setSendError(err: Error | null): void;
  setSendCardDelay(delay: Promise<void> | null): void;
  setReactionError(err: Error | null): void;
  setRemoveReactionError(err: Error | null): void;
  setReactionDelay(emoji: string, delay: Promise<void> | null): void;
  setMessageResource(
    fileKey: string,
    resource:
      | FeishuMessageResourceResponse
      | Promise<FeishuMessageResourceResponse>
      | Error
      | null,
  ): void;
  setMessageRead(
    messageId: string,
    cardContent: FeishuMessageReadMode,
    response: FeishuMessageReadResponse | Error | Promise<FeishuMessageReadResponse> | null,
  ): void;
}

export function createFakeFeishuBot(appId: string = 'fake-bot'): FakeFeishuBot {
  const sent: FakeFeishuBot['sentMessages'] = [];
  const sentCards: FakeFeishuBot['sentCards'] = [];
  const deliveredCards: FakeFeishuBot['deliveredCards'] = [];
  let routes: FeishuInboundRoutes | null = null;
  let nextMessageId = 1;
  let nextReactionId = 1;
  let sendError: Error | null = null;
  let sendCardDelay: Promise<void> | null = null;
  let reactionError: Error | null = null;
  let removeReactionError: Error | null = null;
  const reactionDelays = new Map<string, Promise<void>>();
  let appOwner: FeishuAppOwnerIdentity = {};
  const messageResources = new Map<
    string,
    FeishuMessageResourceResponse | Promise<FeishuMessageResourceResponse> | Error
  >();
  const messageReads = new Map<
    string,
    FeishuMessageReadResponse | Error | Promise<FeishuMessageReadResponse>
  >();
  const messageReadRequests: FeishuMessageReadRequest[] = [];
  const messageResourceRequests: FeishuMessageResourceRequest[] = [];
  const chatModes = new Map<string, FeishuChatMode | Error>();
  const chatModeRequests: string[] = [];
  const openId: string | undefined = `fake-open-id-${appId}`;
  const displayName = `Fake ${appId}`;
  const reactions: FakeFeishuBot['reactions'] = [];
  const removedReactions: FakeFeishuBot['removedReactions'] = [];
  const reactionOps: FakeFeishuBot['reactionOps'] = [];

  return {
    appId,
    get botOpenId(): string | undefined {
      return openId;
    },
    get botDisplayName(): string | undefined {
      return displayName;
    },
    async start(r: FeishuInboundRoutes): Promise<void> {
      routes = r;
    },
    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      if (sendError !== null) throw sendError;
      const id = `message-fake-${nextMessageId++}`;
      sent.push({ chatId: target.chatId, target, text, messageIds: [id] });
      return { messageIds: [id] };
    },
    async sendCard(
      target: OutboundTarget,
      card: unknown,
      options?: FeishuSendOptions,
    ): Promise<FeishuSendResult> {
      if (sendError !== null) throw sendError;
      const id = `message-fake-${nextMessageId++}`;
      const entry = { chatId: target.chatId, target, card, messageIds: [id] };
      sentCards.push(entry);
      await waitForSendCardDelay(sendCardDelay, options?.signal);
      deliveredCards.push(entry);
      return { messageIds: [id] };
    },
    async inviteMembers(input: FeishuInviteMembersInput): Promise<FeishuInviteMembersResult> {
      return { addedOpenIds: input.userOpenIds };
    },
    async getChatMode(chatId: string): Promise<FeishuChatMode | undefined> {
      chatModeRequests.push(chatId);
      const result = chatModes.get(chatId);
      if (result instanceof Error) throw result;
      return result;
    },
    async addReaction(messageId: string, emoji: string): Promise<string> {
      if (reactionError !== null) throw reactionError;
      const reactionId = `reaction-fake-${nextReactionId++}`;
      reactions.push({ messageId, emoji, reactionId });
      reactionOps.push({ op: 'add', messageId, emoji, reactionId });
      await reactionDelays.get(emoji);
      return reactionId;
    },
    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      if (removeReactionError !== null) throw removeReactionError;
      removedReactions.push({ messageId, reactionId });
      reactionOps.push({ op: 'remove', messageId, reactionId });
    },
    async fetchMessageResource(
      request: FeishuMessageResourceRequest,
    ): Promise<FeishuMessageResourceResponse> {
      messageResourceRequests.push(request);
      const resource = messageResources.get(request.fileKey);
      if (resource === undefined) {
        throw new Error(`no fake Feishu resource for key ${request.fileKey}`);
      }
      if (resource instanceof Error) throw resource;
      return await resource;
    },
    async readMessage(
      request: FeishuMessageReadRequest,
    ): Promise<FeishuMessageReadResponse> {
      messageReadRequests.push(request);
      const mode = request.cardContent ?? 'default';
      const response = messageReads.get(`${mode}:${request.messageId}`);
      if (response === undefined) {
        throw new Error(`no fake Feishu message read for ${mode}:${request.messageId}`);
      }
      if (response instanceof Error) throw response;
      return response;
    },
    async resolveAppOwner(): Promise<FeishuAppOwnerIdentity> {
      return appOwner;
    },
    async close(): Promise<void> {
      routes = null;
    },
    get sentMessages() {
      return sent;
    },
    get sentCards() {
      return sentCards;
    },
    get deliveredCards() {
      return deliveredCards;
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
    get chatModeRequests() {
      return chatModeRequests;
    },
    get messageReadRequests() {
      return messageReadRequests;
    },
    get messageResourceRequests() {
      return messageResourceRequests;
    },
    async inject(event: FeishuInboundEvent): Promise<void> {
      if (routes === null) throw new Error('fake bot not started');
      await routes.onMessage(event);
    },
    async injectBotMemberAdded(event: FeishuBotMemberAddedEvent): Promise<void> {
      if (routes === null) throw new Error('fake bot not started');
      await routes.onBotMemberAdded?.(event);
    },
    async injectCardAction(event: FeishuCardActionEvent): Promise<unknown> {
      if (routes === null) throw new Error('fake bot not started');
      return routes.onCardAction?.(event);
    },
    setAppOwner(owner: FeishuAppOwnerIdentity): void {
      appOwner = owner;
    },
    setChatMode(chatId: string, mode: FeishuChatMode | Error | undefined): void {
      if (mode === undefined) chatModes.delete(chatId);
      else chatModes.set(chatId, mode);
    },
    setSendError(err: Error | null): void {
      sendError = err;
    },
    setSendCardDelay(delay: Promise<void> | null): void {
      sendCardDelay = delay;
    },
    setReactionError(err: Error | null): void {
      reactionError = err;
    },
    setRemoveReactionError(err: Error | null): void {
      removeReactionError = err;
    },
    setReactionDelay(emoji: string, delay: Promise<void> | null): void {
      if (delay === null) reactionDelays.delete(emoji);
      else reactionDelays.set(emoji, delay);
    },
  setMessageResource(
      fileKey: string,
      resource:
        | FeishuMessageResourceResponse
        | Promise<FeishuMessageResourceResponse>
        | Error
        | null,
    ): void {
      if (resource === null) messageResources.delete(fileKey);
      else messageResources.set(fileKey, resource);
    },
    setMessageRead(
      messageId: string,
      cardContent: FeishuMessageReadMode,
      response: FeishuMessageReadResponse | Error | Promise<FeishuMessageReadResponse> | null,
    ): void {
      const key = `${cardContent}:${messageId}`;
      if (response === null) messageReads.delete(key);
      else messageReads.set(key, response);
    },
  };
}

async function waitForSendCardDelay(
  delay: Promise<void> | null,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  if (delay === null || signal === undefined) {
    await delay;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void delay.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

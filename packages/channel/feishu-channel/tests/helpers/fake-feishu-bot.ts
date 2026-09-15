import type {
  FeishuAppOwnerIdentity,
  FeishuBotMemberAddedEvent,
  FeishuChatMode,
  FeishuCommentEvent,
  FeishuCotClient,
  FeishuDocCommentRequest,
  FeishuDocCommentText,
  FeishuDocMetaResult,
  FeishuWikiNode,
  FeishuMessageResourceRequest,
  FeishuMessageResourceResponse,
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
  readonly reactions: Array<{
    messageId: string;
    emoji: string;
    reactionId: string;
  }>;
  readonly reactionOps: Array<{
    op: 'add';
    messageId: string;
    emoji: string;
    reactionId: string;
  }>;
  readonly chatModeRequests: string[];
  readonly editedCards: Array<{ messageId: string; card: unknown }>;
  readonly chatNameRequests: string[];
  readonly messageReadRequests: FeishuMessageReadRequest[];
  readonly messageResourceRequests: FeishuMessageResourceRequest[];
  /** Every comment-text read a delivered event made, in order. */
  readonly commentTextReads: Array<{
    fileToken: string;
    commentId: string;
    replyId: string;
  }>;
  inject(event: FeishuInboundEvent): Promise<void>;
  injectDocComment(event: FeishuCommentEvent): Promise<void>;
  /** Keyed on the reply id an event names, so a thread can hold several. */
  setDocCommentText(
    replyId: string,
    text: FeishuDocCommentText | null | Error,
  ): void;
  injectBotMemberAdded(event: FeishuBotMemberAddedEvent): Promise<void>;
  injectCardAction(event: FeishuCardActionEvent): Promise<unknown>;
  setAppOwner(owner: FeishuAppOwnerIdentity): void;
  setChatMode(chatId: string, mode: FeishuChatMode | Error | undefined): void;
  setChatName(chatId: string, name: string | Error | undefined): void;
  setSendError(err: Error | null): void;
  /**
   * Give this bot a COT surface, or take it away again.
   *
   * `cot` is optional on `FeishuBot` precisely so a bot without it presents no
   * chain-of-thought card; a test that wants cards supplies one here.
   */
  setCot(client: FeishuCotClient | undefined): void;
  setSendReceiptDelay(delay: Promise<void> | null): void;
  setSendCardDelay(delay: Promise<void> | null): void;
  setReactionError(err: Error | null): void;
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
    response: FeishuMessageReadResponse | Error | Promise<FeishuMessageReadResponse> | null,
  ): void;
}

export function createFakeFeishuBot(appId: string = 'fake-bot'): FakeFeishuBot {
  const sent: FakeFeishuBot['sentMessages'] = [];
  const sentCards: FakeFeishuBot['sentCards'] = [];
  let routes: FeishuInboundRoutes | null = null;
  let nextMessageId = 1;
  let nextReactionId = 1;
  let sendError: Error | null = null;
  let sendReceiptDelay: Promise<void> | null = null;
  let sendCardDelay: Promise<void> | null = null;
  let reactionError: Error | null = null;
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
  const chatNames = new Map<string, string | Error>();
  const chatNameRequests: string[] = [];
  const openId: string | undefined = `fake-open-id-${appId}`;
  const displayName = `Fake ${appId}`;
  const editedCards: FakeFeishuBot['editedCards'] = [];
  const commentTextReads: FakeFeishuBot['commentTextReads'] = [];
  const commentTexts = new Map<string, FeishuDocCommentText | null | Error>();
  const reactions: FakeFeishuBot['reactions'] = [];
  const reactionOps: FakeFeishuBot['reactionOps'] = [];
  let cotClient: FeishuCotClient | undefined;

  return {
    appId,
    editedCards,
    async editCard(messageId: string, card: unknown): Promise<void> {
      editedCards.push({ messageId, card });
    },
    get botOpenId(): string | undefined {
      return openId;
    },
    get botDisplayName(): string | undefined {
      return displayName;
    },
    get cot(): FeishuCotClient | undefined {
      return cotClient;
    },
    async start(r: FeishuInboundRoutes): Promise<void> {
      routes = r;
    },
    async send(
      target: OutboundTarget,
      text: string,
      options?: Pick<FeishuSendOptions, 'onMessageCreated'>,
    ): Promise<FeishuSendResult> {
      if (sendError !== null) throw sendError;
      const id = `message-fake-${nextMessageId++}`;
      sent.push({ chatId: target.chatId, target, text, messageIds: [id] });
      if (sendReceiptDelay !== null) await sendReceiptDelay;
      try {
        options?.onMessageCreated?.({ messageId: id, ordinal: 0 });
      } catch {
        // Match the transport's fail-open receipt observer boundary.
      }
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
      return { messageIds: [id] };
    },
    async getChatMode(chatId: string): Promise<FeishuChatMode | undefined> {
      chatModeRequests.push(chatId);
      const result = chatModes.get(chatId);
      if (result instanceof Error) throw result;
      return result;
    },
    async resolveChatName(chatId: string): Promise<string | undefined> {
      chatNameRequests.push(chatId);
      const result = chatNames.get(chatId);
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
      const response = messageReads.get(request.messageId);
      if (response === undefined) {
        throw new Error(`no fake Feishu message read for ${request.messageId}`);
      }
      if (response instanceof Error) throw response;
      return response;
    },
    async fetchDocMeta(): Promise<FeishuDocMetaResult> {
      throw new Error('no fake Feishu document metadata configured');
    },
    async resolveWikiNode(): Promise<FeishuWikiNode | null> {
      throw new Error('no fake Feishu wiki nodes configured');
    },
    async fetchDocCommentText(
      request: FeishuDocCommentRequest,
    ): Promise<FeishuDocCommentText | null> {
      commentTextReads.push({
        fileToken: request.fileToken,
        commentId: request.commentId,
        replyId: request.replyId,
      });
      const text = commentTexts.get(request.replyId);
      if (text instanceof Error) throw text;
      return text ?? null;
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
    get reactions() {
      return reactions;
    },
    get reactionOps() {
      return reactionOps;
    },
    get chatModeRequests() {
      return chatModeRequests;
    },
    get chatNameRequests() {
      return chatNameRequests;
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
    async injectDocComment(event: FeishuCommentEvent): Promise<void> {
      if (routes === null) throw new Error('fake bot not started');
      await routes.onDocComment?.(event);
    },
    get commentTextReads() {
      return commentTextReads;
    },
    setDocCommentText(
      replyId: string,
      text: FeishuDocCommentText | null | Error,
    ): void {
      commentTexts.set(replyId, text);
    },
    setAppOwner(owner: FeishuAppOwnerIdentity): void {
      appOwner = owner;
    },
    setChatMode(chatId: string, mode: FeishuChatMode | Error | undefined): void {
      if (mode === undefined) chatModes.delete(chatId);
      else chatModes.set(chatId, mode);
    },
    setChatName(chatId: string, name: string | Error | undefined): void {
      if (name === undefined) chatNames.delete(chatId);
      else chatNames.set(chatId, name);
    },
    setSendError(err: Error | null): void {
      sendError = err;
    },
    setCot(client: FeishuCotClient | undefined): void {
      cotClient = client;
    },
    setSendReceiptDelay(delay: Promise<void> | null): void {
      sendReceiptDelay = delay;
    },
    setSendCardDelay(delay: Promise<void> | null): void {
      sendCardDelay = delay;
    },
    setReactionError(err: Error | null): void {
      reactionError = err;
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
      response: FeishuMessageReadResponse | Error | Promise<FeishuMessageReadResponse> | null,
    ): void {
      if (response === null) messageReads.delete(messageId);
      else messageReads.set(messageId, response);
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

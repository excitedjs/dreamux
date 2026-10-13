/**
 * Which target an inbound Feishu message sits in, and whether an unbound
 * conversation there may automatically receive a new Team.
 *
 * Identity and permission are different facts. Identity is pure —
 * `messageTarget` in `routing/target.ts` composes it from what the platform
 * reported — and this class adds only the per-projection provisioning
 * eligibility: a topic may be provisioned only while its group's effective
 * message format is the topic format, which is mutable and therefore observed
 * fresh for every projection that could use it (a session-lifetime cache would
 * keep granting permission after an operator switched the group back to chat
 * format). Failures and unknown formats are not remembered either, so the next
 * projection retries; simultaneous lookups for one chat share a single
 * request.
 *
 * Beside that, this class holds stable chat-kind knowledge (direct chat or
 * group) for the card-click access gate: accepted inbound events teach it, and
 * a successful platform lookup establishes it. It never holds the mutable
 * topic-versus-chat message format. This class reads no binding table and owns
 * no routing policy: it does not decide where a message goes — that is
 * `FeishuRouting`'s job, once this has named the target and supplied the
 * eligibility fact. Nothing here leaves the package: Core is told a
 * `team_name` and nothing about chats, threads, or topic mode.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type {
  FeishuChatMode,
  FeishuInboundEvent,
} from '@excitedjs/feishu-transport';

import {
  FeishuOperationError,
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from '../feishu-bounded-operation.js';
import { messageTarget, type FeishuTarget } from '../routing/target.js';

const FEISHU_CHAT_MODE_LOOKUP_TIMEOUT_MS = 2_000;

interface FeishuChatModeReader {
  getChatMode?(chatId: string): Promise<FeishuChatMode | undefined>;
}

export interface FeishuInboundRoute {
  readonly target: FeishuTarget;
  /**
   * Whether this projection observed a topic message format for the target's
   * chat. Only a topic can carry it; it is permission to provision, never
   * identity, and it says nothing about bindings.
   */
  readonly canProvision: boolean;
}

interface FeishuInboundTargetingOptions {
  chatModes: FeishuChatModeReader;
  log: DreamuxLogger;
}

/** Resolves a target's provisioning eligibility, and stable chat kinds. */
export class FeishuInboundTargeting {
  /** Stable kinds (direct chat or group) — never the mutable message format. */
  private readonly chatKinds = new Map<string, 'p2p' | 'group'>();
  private readonly pendingChatModes = new Map<
    string,
    Promise<FeishuChatMode | undefined>
  >();

  constructor(private readonly opts: FeishuInboundTargetingOptions) {}

  async projectInbound(
    event: FeishuInboundEvent,
    signal?: AbortSignal,
  ): Promise<FeishuInboundRoute> {
    assertRoutingActive(signal);
    // An accepted event states its chat's kind exactly, which is all the
    // card-click gate ever needs from it; the message format is not taught.
    if (event.chatType === 'p2p' || event.chatType === 'group') {
      this.chatKinds.set(event.chatId, event.chatType);
    }
    const route = await this.project(
      messageTarget({
        chatId: event.chatId,
        chatType: event.chatType,
        threadId: event.threadId,
      }),
      signal,
    );
    assertRoutingActive(signal);
    return route;
  }

  /**
   * The provisioning eligibility of an already normalized target.
   *
   * Identity is settled before this runs — a thread is a topic whatever the
   * group's message format currently is — so the only question left is
   * permission: whether this chat is in the topic message format right now.
   * Only a topic needs that lookup; a chat or direct-chat target can never
   * provision and costs no request.
   */
  async project(
    target: FeishuTarget,
    signal?: AbortSignal,
  ): Promise<FeishuInboundRoute> {
    if (target.kind !== 'topic') {
      return { target, canProvision: false };
    }
    const mode = await this.chatMode(target.chatId, signal);
    assertRoutingActive(signal);
    return { target, canProvision: mode === 'topic' };
  }

  /**
   * Whether a chat is a direct chat or a group: the kind an accepted inbound
   * event reported, or the same platform lookup eligibility uses. A card click
   * names its chat but not the kind, and the access gate can decide differently
   * for the two, so when it does the kind is established rather than assumed:
   * `undefined` when neither this session nor Feishu can say, and the caller
   * then has nothing to decide on.
   */
  async chatType(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<'p2p' | 'group' | undefined> {
    const known = this.chatKinds.get(chatId);
    if (known !== undefined) return known;
    const mode = await this.chatMode(chatId, signal);
    if (mode === undefined) return undefined;
    return mode === 'p2p' ? 'p2p' : 'group';
  }

  private async chatMode(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<FeishuChatMode | undefined> {
    assertRoutingActive(signal);
    const pending = this.pendingChatModes.get(chatId);
    if (pending !== undefined) {
      const mode = await pending;
      assertRoutingActive(signal);
      return mode;
    }

    const lookup = this.lookupChatMode(chatId);
    this.pendingChatModes.set(chatId, lookup);
    try {
      const mode = await lookup;
      assertRoutingActive(signal);
      return mode;
    } finally {
      if (this.pendingChatModes.get(chatId) === lookup) {
        this.pendingChatModes.delete(chatId);
      }
    }
  }

  private async lookupChatMode(
    chatId: string,
  ): Promise<FeishuChatMode | undefined> {
    const getChatMode = this.opts.chatModes.getChatMode;
    if (getChatMode === undefined) {
      this.warnUnknownMode(chatId, 'chat_mode_lookup_unavailable');
      return undefined;
    }
    try {
      const mode = await withChatModeTimeout(
        getChatMode.call(this.opts.chatModes, chatId),
      );
      if (mode === undefined) {
        this.warnUnknownMode(chatId, 'missing_or_unknown_chat_mode');
        return undefined;
      }
      // The format is not remembered, but the kind it implies is stable, so a
      // successful lookup is also what a later card click can rely on.
      this.chatKinds.set(chatId, mode === 'p2p' ? 'p2p' : 'group');
      return mode;
    } catch (err) {
      this.warnUnknownMode(
        chatId,
        isFeishuOperationError(err, 'deadline')
          ? 'chat_mode_lookup_timed_out'
          : 'chat_mode_lookup_failed',
        safeError(err),
      );
      return undefined;
    }
  }

  private warnUnknownMode(
    chatId: string,
    reason: string,
    err?: { name?: string; message: string },
  ): void {
    this.opts.log.warn(
      { chat_id: chatId, reason, err },
      'could not verify the Feishu chat message format; automatic Team ' +
        'provisioning is disabled for it, and a card click that depends on ' +
        'its chat kind is refused',
    );
  }
}

function assertRoutingActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new FeishuOperationError('aborted');
  }
}

function withChatModeTimeout(
  promise: Promise<FeishuChatMode | undefined>,
): Promise<FeishuChatMode | undefined> {
  return runFeishuBoundedOperation({
    operation: () => promise,
    deadlineAt: Date.now() + FEISHU_CHAT_MODE_LOOKUP_TIMEOUT_MS,
  });
}

function safeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return {
      ...(err.name !== '' ? { name: err.name } : {}),
      message: err.message,
    };
  }
  return { message: String(err) };
}

/**
 * Feishu's authoritative answer to "where does this message go".
 *
 * This is the whole of what Core gave up. Core used to hold a binding store, a
 * target resolver, a fallback rule, a route-owner index, and a Collaboration
 * Space entity — all of them Core re-deriving facts only Feishu could state.
 * Here they are one small service over one document, and what leaves it is a
 * `team_name`.
 *
 * Every read is synchronous, against the last committed document; every write
 * is a commit, and a caller told that a route now exists or is gone is being
 * told what disk says. Nothing in progress lives here: automatic provisioning
 * is process-local work, and it reaches this service only as the final binding
 * it installs.
 */
import {
  PublicInvokeFailure,
  TransactionalStore,
} from '@excitedjs/dreamux-utils';

import {
  updateRoutingDocument,
  readRoutingDocument,
  routingDocumentPath,
  type FeishuRoutingDocumentOptions,
} from './store.js';
import type {
  FeishuBindingRecord,
  FeishuDocSubscriptionRecord,
  FeishuRoutingDocument,
  FeishuSpaceRecord,
  FeishuSpaceRepoPolicy,
  FeishuTargetRecord,
} from './document.js';
import { spaceId as deriveSpaceId } from './naming.js';
import {
  isBindableTarget,
  resolutionChain,
  targetKey,
  type FeishuTarget,
} from './target.js';

export interface FeishuRoutingPlanBound {
  readonly kind: 'bound';
  readonly teamName: string;
  /** The row that answered, which may be the parent group of a topic. */
  readonly matched: FeishuTarget;
}

export interface FeishuRoutingPlanProvision {
  readonly kind: 'provision';
  /**
   * The policy snapshot this provisioning runs under. It is the record as it
   * was committed when the plan was made, and a later policy update publishes
   * a new record rather than changing this one.
   */
  readonly space: FeishuSpaceRecord;
}

/**
 * Nothing this Channel routes to a Team answers here.
 *
 * It is a decision, not a gap: the message still reaches the Dispatcher Agent,
 * which is the recipient for every conversation an operator has not handed to
 * a Team — a direct chat with the bot, and a group nobody has bound.
 */
export interface FeishuRoutingPlanDispatcher {
  readonly kind: 'dispatcher';
  readonly reason: 'no_binding' | 'not_bindable';
}

export type FeishuRoutingPlan =
  | FeishuRoutingPlanBound
  | FeishuRoutingPlanProvision
  | FeishuRoutingPlanDispatcher;

/**
 * One subscription as its owner may see it. `team_name` is absent because the
 * read is already scoped to one recipient: every row it can return is its own.
 */
export interface FeishuDocumentSubscriptionView {
  readonly file_token: string;
  readonly file_type: string;
  readonly created_at: number;
}

export interface FeishuBindingView {
  readonly target_kind: FeishuTargetRecord['kind'];
  readonly chat_id: string;
  readonly thread_id: string | null;
  readonly display: string | null;
  readonly team_name: string;
  readonly space_name: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * A route that no longer exists, in the terms its removal is announced in.
 *
 * The row is gone from disk, so its display and root can no longer be read
 * back; both travel with the target because a caller telling a conversation
 * it was released names it, and replies under it, the way the bind did.
 */
export interface FeishuRemovedRoute {
  readonly target: FeishuTarget;
  readonly display: string | null;
  readonly rootMessageId: string | null;
}

export class FeishuRouting {
  private readonly store: TransactionalStore<FeishuRoutingDocument>;

  constructor(private readonly opts: FeishuRoutingDocumentOptions) {
    this.store = new TransactionalStore({
      path: routingDocumentPath(opts),
      load: () => readRoutingDocument(opts),
    });
  }

  /** Load before the session admits commands or subscribes to Core events. */
  async initialize(): Promise<void> {
    await this.store.load();
  }

  /** Drain after the session has stopped every routing writer. */
  async close(): Promise<void> {
    await this.store.drain();
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  /**
   * Where an inbound message goes, decided entirely from local state.
   *
   * The order is the product rule: an exact binding wins, a topic's parent
   * group answers next, and only a target that matched nothing at all may be
   * provisioned. A message that reaches none of those goes to the Dispatcher
   * Agent, which is what an unbound conversation with this bot has always
   * been talking to — including after a restart, when provisioning that never
   * finished has simply left no binding behind.
   */
  plan(
    target: FeishuTarget,
    containerChatId: string | null,
  ): FeishuRoutingPlan {
    for (const candidate of resolutionChain(target)) {
      const binding = this.bindingFor(candidate);
      if (binding !== undefined) {
        return {
          kind: 'bound',
          teamName: binding.team_name,
          matched: candidate,
        };
      }
    }
    if (!isBindableTarget(target)) {
      return { kind: 'dispatcher', reason: 'not_bindable' };
    }
    const space =
      containerChatId === null
        ? undefined
        : this.spaceForContainer(containerChatId);
    return space === undefined
      ? { kind: 'dispatcher', reason: 'no_binding' }
      : { kind: 'provision', space };
  }

  bindingFor(target: FeishuTarget): FeishuBindingRecord | undefined {
    const key = targetKey(target);
    return this.store.current.bindings.find(
      (row) => targetKey(fromRecord(row.target)) === key,
    );
  }

  spaceForContainer(chatId: string): FeishuSpaceRecord | undefined {
    return this.store.current.spaces.find(
      (row) => row.container_chat_id === chatId,
    );
  }

  /**
   * This Team's own topic-kind bindings inside one Collaboration Space
   * container — the row a `reply` call with no `message_id` inside that
   * container may fall back to. A `null` team name — the Dispatcher Agent,
   * which owns no Team — matches nothing by construction: no row's
   * `team_name` is ever `null`.
   */
  topicBindingsFor(
    containerChatId: string,
    teamName: string | null,
  ): readonly FeishuBindingRecord[] {
    return this.store.current.bindings.filter(
      (row) =>
        row.target.kind === 'topic' &&
        row.target.chat_id === containerChatId &&
        row.team_name === teamName,
    );
  }

  spaceByName(spaceName: string): FeishuSpaceRecord | undefined {
    return this.store.current.spaces.find(
      (row) => row.space_name === spaceName,
    );
  }

  // ── Bindings ───────────────────────────────────────────────────────────

  /**
   * Install or move one route, and report what it displaced.
   *
   * The previous team is read inside the change rather than before it, because
   * the change is what the commit serializes: reading first would answer from
   * a document another commit may already have replaced. `requireOwner` and
   * the Collaboration Space refusal are checked in the same place and for the
   * same reason — a precondition read outside the commit is a precondition
   * about a document that has moved on.
   */
  async bind(input: {
    target: FeishuTarget;
    teamName: string;
    display: string | null;
    spaceId: string | null;
    /**
     * The visible message this binding's topic conversation should reply
     * under, or `null` when the caller has none: a `group`/`p2p` target, or a
     * topic bound through a path with no message id. A `null` keeps the root
     * the row already holds, decided inside the commit, so a rebind never
     * erases one that a concurrent `fillTopicRoot` just learned.
     */
    rootMessageId: string | null;
    /**
     * When set, refuse a target another Team currently holds instead of
     * moving it. A Team may claim what is free and keep what is already its
     * own; taking a route away from another Team is a Dispatcher decision.
     */
    requireOwner?: string;
  }): Promise<{
    previousTeamName: string | null;
    /** The root the row holds after this bind. */
    rootMessageId: string | null;
  }> {
    const displaced: { teamName: string | null } = { teamName: null };
    const committed: { rootMessageId: string | null } = {
      rootMessageId: null,
    };
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const key = targetKey(input.target);
      const now = Date.now();
      if (
        input.target.kind === 'group' &&
        document.spaces.some(
          (row) => row.container_chat_id === input.target.chatId,
        )
      ) {
        // The binding side of the document invariant stated on
        // `FeishuRoutingDocument`. A topic inside the Space is unaffected and
        // stays bindable — that is the row provisioning itself installs.
        throw new PublicInvokeFailure(
          'This Feishu chat is a Collaboration Space, which gives each of ' +
            'its topics its own Team. Binding the chat itself would take ' +
            'over every topic in it and stop new ones from getting a Team. ' +
            'Bind a chat that is not a Collaboration Space.',
        );
      }
      const existing = document.bindings.find(
        (row) => targetKey(fromRecord(row.target)) === key,
      );
      if (existing !== undefined) {
        if (
          input.requireOwner !== undefined &&
          existing.team_name !== input.requireOwner
        ) {
          // Deliberately says only that it belongs to someone else. Which
          // Team owns a route is a Dispatcher read, and a refusal is not the
          // place to hand it out.
          throw new PublicInvokeFailure(
            'This Feishu conversation is already routed to another Team. ' +
              'Ask the Dispatcher to move it.',
          );
        }
        displaced.teamName = existing.team_name;
        const rootMessageId = input.rootMessageId ?? existing.root_message_id;
        committed.rootMessageId = rootMessageId;
        if (
          existing.team_name === input.teamName &&
          existing.display === input.display &&
          existing.space_id === input.spaceId &&
          existing.root_message_id === rootMessageId
        ) {
          return false;
        }
        existing.team_name = input.teamName;
        existing.display = input.display;
        existing.space_id = input.spaceId;
        existing.root_message_id = rootMessageId;
        existing.updated_at = now;
        return true;
      }
      committed.rootMessageId = input.rootMessageId;
      document.bindings.push({
        target: toRecord(input.target),
        display: input.display,
        team_name: input.teamName,
        space_id: input.spaceId,
        root_message_id: input.rootMessageId,
        created_at: now,
        updated_at: now,
      });
      return true;
    });
    return {
      previousTeamName: displaced.teamName,
      rootMessageId: committed.rootMessageId,
    };
  }

  /**
   * Give a topic binding the message its conversation replies under, when it
   * has none yet.
   *
   * Nothing but that one field is written: not the Team, not the display, and
   * not the row's `updated_at`, because learning where a route already lives is
   * not a change to the route. Only a topic row has a root, so any other target is
   * left alone, as is a row that is absent (a topic served by its parent
   * group, or a route removed meanwhile) or already rooted — whichever root
   * was learned first is the one kept. The precondition is checked twice:
   * against the last commit, so a topic that already has a root costs no
   * write, and inside the commit, for the same reason `bind` re-reads its own.
   */
  async fillTopicRoot(
    target: FeishuTarget,
    rootMessageId: string,
  ): Promise<void> {
    if (target.kind !== 'topic') return;
    const current = this.bindingFor(target);
    if (current === undefined || current.root_message_id !== null) return;
    const key = targetKey(target);
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const row = document.bindings.find(
        (candidate) => targetKey(fromRecord(candidate.target)) === key,
      );
      if (row === undefined || row.root_message_id !== null) return false;
      row.root_message_id = rootMessageId;
      return true;
    });
  }

  /**
   * Remove one route. `requireOwner` restricts it to that Team's own routes.
   *
   * A target nobody routes is not a failure under either authority — there is
   * simply nothing to release, and the answer says so. A target another Team
   * holds is refused, because releasing it would end that Team's conversation.
   */
  async unbind(
    target: FeishuTarget,
    requireOwner?: string,
  ): Promise<(FeishuRemovedRoute & { teamName: string }) | null> {
    // The removed row is reported from inside the commit that deletes it, the
    // way `forgetTeam` reports its routes: a snapshot read before this commit
    // would miss a root `fillTopicRoot` committed just ahead of it.
    let removed: (FeishuRemovedRoute & { teamName: string }) | null = null;
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const key = targetKey(target);
      const kept = document.bindings.filter((row) => {
        if (targetKey(fromRecord(row.target)) !== key) return true;
        if (requireOwner !== undefined && row.team_name !== requireOwner) {
          throw new PublicInvokeFailure(
            'This Feishu conversation is routed to another Team. Only the ' +
              'Dispatcher can release it.',
          );
        }
        removed = {
          target: fromRecord(row.target),
          display: row.display,
          rootMessageId: row.root_message_id,
          teamName: row.team_name,
        };
        return false;
      });
      if (kept.length === document.bindings.length) return false;
      document.bindings = kept;
      return true;
    });
    return removed;
  }

  /**
   * Forget everything that reaches a Team: its routes and the documents it
   * followed, in one commit.
   *
   * Two kinds of evidence lead here — Core said the Team closed, or a
   * submission was rejected before admission — and both go through this one
   * commit, because a second synchronous authority would only disagree with
   * disk. Repeating it is free: a Team with no rows left changes nothing and
   * writes nothing, which is what closes the window between a Team closing and
   * the commit that records it.
   */
  async forgetTeam(teamName: string): Promise<{
    removed: readonly FeishuRemovedRoute[];
    subscriptions: readonly FeishuDocSubscriptionRecord[];
  }> {
    const removed: FeishuRemovedRoute[] = [];
    const subscriptions: FeishuDocSubscriptionRecord[] = [];
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const kept = document.bindings.filter((row) => {
        if (row.team_name !== teamName) return true;
        removed.push({
          target: fromRecord(row.target),
          display: row.display,
          rootMessageId: row.root_message_id,
        });
        return false;
      });
      const keptSubscriptions = document.subscriptions.filter((row) => {
        if (row.team_name !== teamName) return true;
        subscriptions.push(row);
        return false;
      });
      const changed =
        kept.length !== document.bindings.length ||
        keptSubscriptions.length !== document.subscriptions.length;
      if (!changed) return false;
      document.bindings = kept;
      document.subscriptions = keptSubscriptions;
      return true;
    });
    // Reported apart from `removed` rather than folded into it: a removed route
    // is announced back into the conversation it named, and a subscription has
    // no conversation to announce into.
    return { removed, subscriptions };
  }

  listBindings(): readonly FeishuBindingView[] {
    const spaces = new Map(
      this.store.current.spaces.map((row) => [row.space_id, row]),
    );
    return this.store.current.bindings.map((row) => ({
      target_kind: row.target.kind,
      chat_id: row.target.chat_id,
      thread_id: row.target.thread_id ?? null,
      display: row.display,
      team_name: row.team_name,
      space_name:
        row.space_id === null
          ? null
          : (spaces.get(row.space_id)?.space_name ?? null),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  // ── Document subscriptions ─────────────────────────────────────────────

  /**
   * Follow one document for one recipient, and say whether it was already
   * followed.
   *
   * The row a recipient may write is its own and only its own, because
   * `teamName` is the caller's identity rather than an argument. Re-subscribing
   * changes nothing and writes nothing — the row already says what it would
   * say, and `created_at` is when the following started.
   */
  async subscribe(input: {
    fileToken: string;
    fileType: string;
    teamName: string | null;
  }): Promise<{ alreadySubscribed: boolean }> {
    const existing = { found: false };
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const row = document.subscriptions.find(
        (candidate) =>
          candidate.file_token === input.fileToken &&
          candidate.team_name === input.teamName,
      );
      if (row !== undefined) {
        existing.found = true;
        return false;
      }
      document.subscriptions.push({
        file_token: input.fileToken,
        file_type: input.fileType,
        team_name: input.teamName,
        created_at: Date.now(),
      });
      return true;
    });
    return { alreadySubscribed: existing.found };
  }

  /**
   * Stop following one document, for one recipient.
   *
   * Two things reach here and both mean the same row: the recipient asked, or
   * a delivery to it was refused before admission. A document nobody was
   * following is not a failure — there is simply nothing to release.
   */
  async unsubscribe(
    fileToken: string,
    teamName: string | null,
  ): Promise<boolean> {
    const removed = { any: false };
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const kept = document.subscriptions.filter(
        (row) => row.file_token !== fileToken || row.team_name !== teamName,
      );
      if (kept.length === document.subscriptions.length) return false;
      document.subscriptions = kept;
      removed.any = true;
      return true;
    });
    return removed.any;
  }

  /** Every recipient a comment on this document must reach. */
  subscribersFor(fileToken: string): readonly FeishuDocSubscriptionRecord[] {
    return this.store.current.subscriptions.filter(
      (row) => row.file_token === fileToken,
    );
  }

  /** The rows one recipient owns — what it may see, and what it may remove. */
  listSubscriptions(
    teamName: string | null,
  ): readonly FeishuDocumentSubscriptionView[] {
    return this.store.current.subscriptions
      .filter((row) => row.team_name === teamName)
      .map((row) => ({
        file_token: row.file_token,
        file_type: row.file_type,
        created_at: row.created_at,
      }));
  }

  // ── Collaboration Space policy ─────────────────────────────────────────

  async bindSpace(input: {
    spaceName: string;
    containerChatId: string;
    display: string | null;
    leaderAgentRuntime: string;
    identity: string | null;
    repo: FeishuSpaceRepoPolicy | null;
  }): Promise<FeishuSpaceRecord> {
    const id = deriveSpaceId({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      containerChatId: input.containerChatId,
    });
    const committed: { record: FeishuSpaceRecord | undefined } = {
      record: undefined,
    };
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const now = Date.now();
      const existing = document.spaces.find((row) => row.space_id === id);
      const conflicting = document.spaces.find(
        (row) => row.space_name === input.spaceName && row.space_id !== id,
      );
      if (conflicting !== undefined) {
        throw new PublicInvokeFailure(
          `Collaboration space ${JSON.stringify(input.spaceName)} is ` +
            'already bound to another Feishu chat. Choose another name, or ' +
            'unbind that space first.',
        );
      }
      // The space side of the document invariant stated on
      // `FeishuRoutingDocument`. Only a whole-chat row conflicts; the topic
      // rows a Space installs as it provisions do not, so re-registering a
      // Space that already has live topics keeps working.
      const wholeChat = document.bindings.find(
        (row) =>
          row.target.kind === 'group' &&
          row.target.chat_id === input.containerChatId,
      );
      if (wholeChat !== undefined) {
        throw new PublicInvokeFailure(
          `This Feishu chat is bound as a whole to Team ` +
            `${JSON.stringify(wholeChat.team_name)}, which would answer for ` +
            'every topic in it and leave new topics without a Team of their ' +
            'own. Unbind the chat first, then register the space.',
        );
      }
      if (existing === undefined) {
        const created: FeishuSpaceRecord = {
          space_id: id,
          space_name: input.spaceName,
          container_chat_id: input.containerChatId,
          display: input.display,
          leader_agent_runtime: input.leaderAgentRuntime,
          identity: input.identity,
          repo: input.repo,
          created_at: now,
          updated_at: now,
        };
        document.spaces.push(created);
        committed.record = created;
        return true;
      }
      existing.space_name = input.spaceName;
      existing.display = input.display;
      existing.leader_agent_runtime = input.leaderAgentRuntime;
      existing.identity = input.identity;
      existing.repo = input.repo;
      existing.updated_at = now;
      committed.record = existing;
      return true;
    });
    const saved = committed.record;
    if (saved === undefined) {
      throw new Error('feishu space policy was not saved');
    }
    return saved;
  }

  /**
   * Stop provisioning for a space without touching what it already produced.
   *
   * The Teams it created are ordinary Teams and the bindings it installed keep
   * routing. Removing a policy is a statement about the future only — it is
   * never a dissolve, never a bulk unbind, and never a cancellation of a Team
   * creation already under way.
   */
  async unbindSpace(spaceName: string): Promise<FeishuSpaceRecord | null> {
    const removed: { record: FeishuSpaceRecord | undefined } = {
      record: undefined,
    };
    await updateRoutingDocument(this.store, this.opts.stateDir, (document) => {
      const kept = document.spaces.filter((row) => {
        if (row.space_name !== spaceName) return true;
        removed.record = row;
        return false;
      });
      if (kept.length === document.spaces.length) return false;
      document.spaces = kept;
      return true;
    });
    return removed.record ?? null;
  }

  listSpaces(): readonly FeishuSpaceRecord[] {
    return this.store.current.spaces;
  }
}

function toRecord(target: FeishuTarget): FeishuTargetRecord {
  return {
    kind: target.kind,
    chat_id: target.chatId,
    ...(target.threadId !== undefined ? { thread_id: target.threadId } : {}),
  };
}

function fromRecord(record: FeishuTargetRecord): FeishuTarget {
  return {
    kind: record.kind,
    chatId: record.chat_id,
    ...(record.thread_id !== undefined ? { threadId: record.thread_id } : {}),
  };
}

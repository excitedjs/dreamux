/** Fail-open wiring between a live Feishu session and its COT adapter. */
import type {
  ChannelCoreEventSource,
  ChannelCoreEventSubscription,
  ChannelTarget,
  ChannelToolCallerContext,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { FeishuCotClient } from '@excitedjs/feishu-transport';

import { FeishuCotAdapter } from './feishu-cot-adapter.js';
import { cotErrorCategory } from './feishu-cot-diagnostics.js';
import type { VisibleMessageAnchor } from './feishu-cot-state.js';

interface FeishuCotSessionContext {
  readonly dispatcherId: string;
  readonly log: DreamuxLogger;
  adapter(): FeishuCotAdapter | undefined;
}

/** Session-owned coordinator; lifecycle state remains inside the adapter. */
export class FeishuCotSessionSeam {
  private adapter: FeishuCotAdapter | undefined;
  private isCurrent: (() => boolean) | undefined;
  private readonly context: FeishuCotSessionContext;

  constructor(private readonly opts: {
    readonly dispatcherId: string;
    readonly channelId: string | undefined;
    readonly log: DreamuxLogger;
    readonly cotClient: () => FeishuCotClient | undefined;
  }) {
    this.context = {
      dispatcherId: opts.dispatcherId,
      log: opts.log,
      adapter: () => this.adapter,
    };
  }

  start(
    coreEvents: ChannelCoreEventSource | undefined,
    isCurrent: () => boolean,
  ): ChannelCoreEventSubscription[] {
    if (this.adapter !== undefined) {
      throw new Error('Feishu COT session seam is already started');
    }
    this.adapter = new FeishuCotAdapter({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      log: this.opts.log,
      cotClient: this.opts.cotClient,
    });
    this.isCurrent = isCurrent;
    return subscribeCotActivity(this.context, coreEvents, isCurrent);
  }

  setBindingFallbackAnchor(
    teamName: string,
    leaderName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    guard(
      this.context,
      'binding fallback anchor failed; notification unchanged',
      () => {
        const adapter = this.adapter;
        const isCurrent = this.isCurrent;
        if (adapter === undefined || isCurrent === undefined || !isCurrent()) {
          return;
        }
        adapter.setFallbackAnchorIfAbsent(teamName, leaderName, anchor);
      },
    );
  }

  refreshReplyNextAnchor(input: {
    caller: ChannelToolCallerContext | undefined;
    chatId: string;
    messageId: string;
    resolveTarget: () => ChannelTarget;
    isCurrent: () => boolean;
  }): void {
    const caller = input.caller;
    if (caller?.kind !== 'team_leader') return;
    guard(this.context, 'reply anchor refresh failed; Reply unchanged', () => {
      const adapter = this.adapter;
      const isCurrent = this.isCurrent;
      if (
        adapter === undefined ||
        isCurrent === undefined ||
        !isCurrent() ||
        !input.isCurrent()
      ) {
        return;
      }
      adapter.refreshNextAnchor(caller.team_name, caller.leader_name, {
        chatId: input.chatId,
        messageId: input.messageId,
        target: input.resolveTarget(),
      });
    });
  }

  async close(): Promise<void> {
    const adapter = this.adapter;
    this.isCurrent = undefined;
    if (adapter === undefined) return;
    this.adapter = undefined;
    try {
      await adapter.close();
    } catch (err) {
      logCotSeamFailure(this.context, 'adapter close failed', err);
    }
  }
}

/** Core listeners are synchronous local projections and never await Feishu. */
function subscribeCotActivity(
  context: FeishuCotSessionContext,
  coreEvents: ChannelCoreEventSource | undefined,
  isCurrent: () => boolean,
): ChannelCoreEventSubscription[] {
  if (coreEvents === undefined) return [];
  const forward =
    <T>(handle: (adapter: FeishuCotAdapter, event: T) => void) =>
    (event: T): void => {
      const adapter = context.adapter();
      if (adapter === undefined || !isCurrent()) return;
      guard(context, 'listener failed; display only', () =>
        handle(adapter, event));
    };
  return [
    coreEvents.on('turn.submitted', forward((a, e) => a.onTurnSubmitted(e))),
    coreEvents.on('turn.settled', forward((a, e) => a.onTurnSettled(e))),
    coreEvents.on('turn.message', forward((a, e) => a.onTurnMessage(e))),
    coreEvents.on('turn.tool_call', forward((a, e) => a.onTurnToolCall(e))),
    coreEvents.on('team.state', forward((a, e) => a.onTeamState(e))),
    coreEvents.on('binding.route', forward((a, e) => a.onBindingRoute(e))),
  ];
}

function guard<T>(
  context: FeishuCotSessionContext,
  what: string,
  run: () => T,
): T | undefined {
  try {
    return run();
  } catch (err) {
    logCotSeamFailure(context, what, err);
    return undefined;
  }
}

function logCotSeamFailure(
  context: FeishuCotSessionContext,
  what: string,
  err: unknown,
): void {
  try {
    context.log.warn(
      { dispatcher_id: context.dispatcherId, ...cotErrorCategory(err) },
      `Feishu COT ${what}`,
    );
  } catch {
    // Diagnostics are part of the fail-open seam too. A hostile or broken
    // logger must not leak a display-only failure back into Reply or teardown.
  }
}

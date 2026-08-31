/** Fail-open wiring between a live Feishu session and its COT adapter. */
import type {
  ChannelCoreEvent,
  ChannelMcpCaller,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { FeishuCotClient } from '@excitedjs/feishu-transport';

import { FeishuCotAdapter } from './feishu-cot-adapter.js';
import { cotErrorCategory } from './feishu-cot-diagnostics.js';
import { FeishuSubmittedTurns } from './feishu-inbound-anchor.js';
import type { VisibleMessageAnchor } from './feishu-cot-state.js';
import type { FeishuTarget } from './routing/target.js';

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

  private readonly submitted = new FeishuSubmittedTurns();

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

  start(isCurrent: () => boolean): void {
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
  }

  /**
   * One subscription, demultiplexed here.
   *
   * Every submitted turn is recorded before it is presented, whoever submitted
   * it: the recording is a key-value fact, not a presentation decision, and
   * only a session holding the matching `turn_id` can turn it into one.
   */
  handle(event: ChannelCoreEvent): void {
    const adapter = this.adapter;
    const isCurrent = this.isCurrent;
    if (adapter === undefined || isCurrent === undefined) return;
    if (!isCurrent()) return;
    this.guard('listener failed; display only', () => {
      switch (event.kind) {
        case 'teammate.turn.submitted':
          this.submitted.record(event);
          adapter.onTurnSubmitted(event);
          return;
        case 'teammate.turn.settled':
          adapter.onTurnSettled(event);
          return;
        case 'teammate.turn.message':
          adapter.onTurnMessage(event);
          return;
        case 'teammate.turn.tool_call':
          adapter.onTurnToolCall(event);
          return;
        case 'team.state':
          adapter.onTeamState(event);
          return;
        default:
          return;
      }
    });
  }

  /**
   * Bind this session's visible message to the turn its own submit created.
   *
   * `turnId` came back from that Command, so claiming the matching submitted
   * event is the proof of ownership — no other session can hold it, and the
   * event states the recipient instead of this Channel guessing at one.
   */
  attachInboundAnchor(turnId: string, anchor: VisibleMessageAnchor): void {
    const event = this.submitted.claim(turnId);
    if (event === null) return;
    this.withAdapter(
      'inbound anchor attach failed; display only',
      (adapter) => adapter.onAnchoredSubmission({ event, anchor }),
    );
  }

  setBindingFallbackAnchor(
    teamName: string,
    leaderName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    this.withAdapter(
      'binding fallback anchor failed; notification unchanged',
      (adapter) => adapter.setFallbackAnchorIfAbsent(
        teamName,
        leaderName,
        anchor,
      ),
    );
  }

  refreshReplyNextAnchor(input: {
    caller: ChannelMcpCaller;
    anchor: VisibleMessageAnchor;
  }): void {
    if (input.caller.kind !== 'team_leader') return;
    const caller = input.caller;
    this.withAdapter(
      'reply anchor refresh failed; Reply unchanged',
      (adapter) => adapter.refreshNextAnchor(
        caller.team_name,
        caller.leader_name,
        input.anchor,
      ),
    );
  }

  onRouteReleased(input: { teamName: string; target: FeishuTarget }): void {
    this.withAdapter(
      'route release failed; display only',
      (adapter) => adapter.onRouteReleased(input),
    );
  }

  onRouteClaimed(input: { teamName: string; target: FeishuTarget }): void {
    this.withAdapter(
      'route claim failed; display only',
      (adapter) => adapter.onRouteClaimed(input),
    );
  }

  async close(): Promise<void> {
    const adapter = this.adapter;
    this.isCurrent = undefined;
    this.submitted.clear();
    if (adapter === undefined) return;
    this.adapter = undefined;
    try {
      await adapter.close();
    } catch (err) {
      logCotSeamFailure(this.context, 'adapter close failed', err);
    }
  }

  private withAdapter(
    what: string,
    run: (adapter: FeishuCotAdapter) => void,
  ): void {
    const adapter = this.adapter;
    const isCurrent = this.isCurrent;
    if (adapter === undefined || isCurrent === undefined) return;
    if (!isCurrent()) return;
    this.guard(what, () => run(adapter));
  }

  private guard(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      logCotSeamFailure(this.context, what, err);
    }
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

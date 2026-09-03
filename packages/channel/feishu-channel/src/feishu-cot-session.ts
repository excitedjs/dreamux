/** Fail-open wiring between a live Feishu session and its COT adapter. */
import type {
  ChannelCoreEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { FeishuCotClient } from '@excitedjs/feishu-transport';

import {
  FeishuCotAdapter,
  type FeishuCotInboundSubmission,
} from './feishu-cot-adapter.js';
import { cotErrorCategory } from './feishu-cot-diagnostics.js';
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
   * Two facts carry the whole conversation, split by producer: Core says what
   * it admitted, and the runtime says what it did. The input echoes the
   * caller-owned id, so a body this session itself submitted is recognized and
   * hidden once rather than shown twice; it does not move the anchor.
   */
  handle(event: ChannelCoreEvent): void {
    const adapter = this.adapter;
    const isCurrent = this.isCurrent;
    if (adapter === undefined || isCurrent === undefined) return;
    if (!isCurrent()) return;
    this.guard('listener failed; display only', () => {
      switch (event.kind) {
        case 'teammate.input':
          adapter.onInput(event);
          return;
        case 'teammate.activity':
          adapter.onActivity(event);
          return;
        case 'team.state':
          adapter.onTeamState(event);
          return;
        default:
          return;
      }
    });
  }

  /** Optimistically take this visible message before `team.submit` runs. */
  beginInboundSubmission(
    teamName: string | null,
    anchor: VisibleMessageAnchor,
    sourceId: string,
  ): FeishuCotInboundSubmission | null {
    const adapter = this.adapter;
    const isCurrent = this.isCurrent;
    if (adapter === undefined || isCurrent === undefined || !isCurrent()) {
      return null;
    }
    try {
      return adapter.beginInboundSubmission({ teamName, anchor, sourceId });
    } catch (err) {
      logCotSeamFailure(this.context, 'inbound anchor failed; display only', err);
      return null;
    }
  }

  /**
   * A Team's visible bind card, offered as its leader's first anchor.
   *
   * The one anchor a recipient may acquire without a Channel user message, and
   * only a TeamLeader may: a Dispatcher has no installation or restart anchor.
   * It only ever initializes — a TeamLeader that already has a standing anchor
   * keeps it — so no bind card can displace a live conversation's placement.
   */
  setBindingFallbackAnchor(
    teamName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    this.withAdapter(
      'binding fallback anchor failed; notification unchanged',
      (adapter) => adapter.setFallbackAnchorIfAbsent(teamName, anchor),
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

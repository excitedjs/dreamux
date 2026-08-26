/** Bounded, stateless platform I/O for one Feishu COT presentation. */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type {
  FeishuCotAppendInput,
  FeishuCotClient,
  FeishuCotCreateInput,
  FeishuCotCreateResult,
} from '@excitedjs/feishu-transport';

import { runFeishuBoundedOperation } from './feishu-bounded-operation.js';
import {
  logCotFailure,
  type CotLogScope,
  type CotStage,
} from './feishu-cot-diagnostics.js';

const FEISHU_COT_OPERATION_TIMEOUT_MS = 20_000;

interface FeishuCotIoOptions {
  readonly log: DreamuxLogger;
  readonly cotClient: () => FeishuCotClient | undefined;
  readonly signal: AbortSignal;
}

interface FeishuCotIoScope {
  readonly logScope: CotLogScope;
  readonly presentationId: string;
}

/**
 * Resolves the optional platform capability without owning presentation state.
 * A handle captures one client so every batch and its failure cleanup use the
 * same transport instance.
 */
export class FeishuCotIo {
  constructor(private readonly opts: FeishuCotIoOptions) {}

  open(scope: FeishuCotIoScope): FeishuCotIoHandle | undefined {
    const client = this.opts.cotClient();
    return client === undefined
      ? undefined
      : new FeishuCotIoHandle(this.opts.log, client, this.opts.signal, scope);
  }
}

/** One client-bound set of bounded calls; no lifecycle or queue state lives here. */
export class FeishuCotIoHandle {
  constructor(
    private readonly log: DreamuxLogger,
    private readonly client: FeishuCotClient,
    private readonly signal: AbortSignal,
    private readonly scope: FeishuCotIoScope,
  ) {}

  async create(input: FeishuCotCreateInput): Promise<FeishuCotCreateResult> {
    try {
      return await this.bounded(
        () => this.client.createCot(input),
        (late) => this.completeWithError(late),
      );
    } catch (error) {
      this.logFailure('create', error);
      throw error;
    }
  }

  async append(input: FeishuCotAppendInput): Promise<void> {
    try {
      await this.bounded(() => this.client.appendCot(input));
    } catch (error) {
      this.logFailure('append', error);
      throw error;
    }
  }

  async completeWithError(
    card: { readonly cotId: string; readonly messageId: string },
  ): Promise<void> {
    try {
      await runFeishuBoundedOperation({
        deadlineAt: Date.now() + FEISHU_COT_OPERATION_TIMEOUT_MS,
        operation: () => this.client.completeCot({
          cotId: card.cotId,
          messageId: card.messageId,
          reason: 'error',
        }),
      });
    } catch (error) {
      this.logFailure('complete', error);
    }
  }

  private bounded<T>(
    operation: () => Promise<T>,
    onLateValue?: (value: T) => void | Promise<void>,
  ): Promise<T> {
    return runFeishuBoundedOperation({
      signal: this.signal,
      deadlineAt: Date.now() + FEISHU_COT_OPERATION_TIMEOUT_MS,
      operation,
      ...(onLateValue !== undefined ? { onLateValue } : {}),
    });
  }

  private logFailure(stage: CotStage, error: unknown): void {
    logCotFailure(
      this.log,
      this.scope.logScope,
      { presentationId: this.scope.presentationId, stage },
      error,
    );
  }
}

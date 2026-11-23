import type {
  AgentRuntimeSubmissionInput,
  RuntimeAdmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

import type {
  LiveTranscript,
  LiveTranscriptRecord,
} from '../transcript/live.js';
import type { TmuxSession } from './session.js';

export type TurnMember = (settlement: RuntimeSubmissionSettlement) => void;

interface NativeWrite {
  text: string;
  offset: number;
  finish: (admission: RuntimeAdmission) => void;
}

const ADMISSION_TIMEOUT_MS = 10_000;

/** One TUI composer can carry one unconfirmed write. After native USER_INPUT,
 * the writer is free even if the owning native turn still has work to do. */
export class TmuxInput {
  private writes: Promise<unknown> = Promise.resolve();
  private composer: Promise<unknown> = Promise.resolve();
  private pending: NativeWrite | undefined;
  private closed: RuntimeAdmission | undefined;

  constructor(
    private readonly session: TmuxSession,
    private readonly transcript: LiveTranscript,
    private readonly observe: () => Promise<void>,
    private readonly canWrite: () => Error | undefined,
    private readonly nativeBusy: () => boolean,
    private readonly ambiguous: (error: Error) => void,
  ) {}

  submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission> {
    const task = this.writes.then(() => this.write(input));
    this.writes = task.catch(() => undefined);
    return task;
  }

  /** Return the exact native input's membership, ready to attach before any
   * later transcript records in this observation are processed. */
  admit(
    record: LiveTranscriptRecord,
    text: string,
  ): TurnMember | Error | undefined {
    const pending = this.pending;
    if (!pending || record.offset < pending.offset) return;
    this.pending = undefined;
    if (pending.text !== text) {
      const error = new Error(
        'Antigravity native TUI recorded different USER_INPUT from the exact submitted text',
      );
      pending.finish({ status: 'ambiguous', error });
      return error;
    }
    const settlement = deferred<RuntimeSubmissionSettlement>();
    pending.finish({
      status: 'submitted',
      submission: { settled: settlement.promise },
    });
    return settlement.resolve;
  }

  close(error?: Error): Promise<unknown> {
    this.closed = error ? { status: 'failed', error } : { status: 'stopped' };
    if (this.pending) {
      const { finish } = this.pending;
      this.pending = undefined;
      finish({
        status: 'ambiguous',
        error:
          error ??
          new Error(
            'Antigravity stopped before native input could be confirmed',
          ),
      });
    }
    return this.writes;
  }

  /** Keep paste and its separate Enter indivisible with respect to Escape. */
  useComposer<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.composer.then(action);
    this.composer = operation.catch(() => undefined);
    return operation;
  }

  private async write(
    input: AgentRuntimeSubmissionInput,
  ): Promise<RuntimeAdmission> {
    const accepted = deferred<RuntimeAdmission>();
    const early = await this.useComposer(() =>
      this.send(input, accepted.resolve),
    );
    if (early) return early;

    const deadline = setTimeout(() => {
      // Native Queue may defer USER_INPUT until the current tool finishes.
      if (this.nativeBusy()) {
        deadline.refresh();
        return;
      }
      this.pending = undefined;
      const error = new Error(
        'Antigravity native TUI did not record exact complete USER_INPUT after bracketed paste and Enter',
      );
      accepted.resolve({ status: 'ambiguous', error });
      this.ambiguous(error);
    }, ADMISSION_TIMEOUT_MS);
    try {
      return await accepted.promise;
    } finally {
      clearTimeout(deadline);
    }
  }

  private async send(
    input: AgentRuntimeSubmissionInput,
    finish: (admission: RuntimeAdmission) => void,
  ): Promise<RuntimeAdmission | undefined> {
    if (this.closed) return this.closed;
    let offset: number;
    try {
      await this.observe();
      if (this.closed) return this.closed;
      const blocked = this.canWrite();
      if (blocked) return { status: 'failed', error: blocked };
      await this.session.loadInput(input.text);
      ({ offset } = await this.transcript.snapshot());
    } catch (cause) {
      return this.closed ?? { status: 'failed', error: errorFrom(cause) };
    }
    if (this.closed) return this.closed;

    this.pending = { text: input.text, offset, finish };
    try {
      await this.session.pasteInput();
      if (!this.closed) await this.session.enter();
    } catch {
      // The tmux client can fail after writing to the pane. Only the native
      // transcript can determine whether that write was accepted.
    }
  }
}

export function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

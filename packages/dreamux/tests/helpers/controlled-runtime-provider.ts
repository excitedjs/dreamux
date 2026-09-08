import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeSubmissionInput,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';

import {
  controllableRuntimeSubmission,
  type ControllableRuntimeSubmission,
} from './runtime-submission.js';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

export interface ControlledRuntimePlan {
  readonly delayedAdmission?: Promise<RuntimeAdmission>;
  readonly stopBarrier?: Promise<void>;
  readonly stopFailures?: readonly Error[];
}

export class ControlledRuntime {
  readonly inputs: string[] = [];
  readonly submissions: ControllableRuntimeSubmission[] = [];
  readonly submitStarted = deferred<void>();
  readonly stopStarted = deferred<void>();
  private delayedAdmission: Promise<RuntimeAdmission> | null;
  private readonly stopBarrier: Promise<void> | null;
  private readonly stopFailures: Error[];

  constructor(
    readonly context: AgentRuntimeCreateContext<unknown>,
    plan: ControlledRuntimePlan,
  ) {
    this.delayedAdmission = plan.delayedAdmission ?? null;
    this.stopBarrier = plan.stopBarrier ?? null;
    this.stopFailures = [...(plan.stopFailures ?? [])];
  }

  readonly runtime: AgentRuntime = {
    start: async () => ({ continuity: 'fresh' }),
    submit: (input) => this.submit(input),
    stop: () => this.stop(),
  };

  private async submit(
    input: AgentRuntimeSubmissionInput,
  ): Promise<RuntimeAdmission> {
    this.inputs.push(input.text);
    this.submitStarted.resolve();
    const delayed = this.delayedAdmission;
    if (delayed !== null) {
      this.delayedAdmission = null;
      return delayed;
    }
    const submission = controllableRuntimeSubmission();
    this.submissions.push(submission);
    if (input.text.startsWith('<task-notification>')) submission.complete(null);
    return { status: 'submitted', submission: submission.submission };
  }

  private async stop(): Promise<void> {
    this.stopStarted.resolve();
    await this.stopBarrier;
    const failure = this.stopFailures.shift();
    if (failure !== undefined) throw failure;
    for (const submission of this.submissions) submission.stop();
  }
}

export class ControlledRuntimeProvider implements AgentRuntimeProvider<unknown> {
  readonly runtimes: ControlledRuntime[] = [];
  private readonly plans: ControlledRuntimePlan[] = [];

  getCapabilities() {
    return { tags: [] };
  }

  async readRecentActivity() {
    return { records: [], truncated: false };
  }

  async createRuntime(
    context: AgentRuntimeCreateContext<unknown>,
  ): Promise<AgentRuntime> {
    const runtime = new ControlledRuntime(context, this.plans.shift() ?? {});
    this.runtimes.push(runtime);
    return runtime.runtime;
  }

  planNext(plan: ControlledRuntimePlan): void {
    this.plans.push(plan);
  }
}

/**
 * External-provider compile fixture (issue #209 validation guard).
 *
 * This file imports Dreamux contracts from `@excitedjs/dreamux-types` ONLY and
 * implements a complete Agent Runtime provider (descriptor + `readConfig` +
 * `getCapabilities` + optional `diagnostic` + `createRuntime` returning a live
 * `AgentRuntime` handle) and a Channel
 * provider (with the optional `reply` / `react` / `tools` / `handleTool` /
 * `messageBelongsToTarget`), the way an external provider package in another
 * repository would. It also exercises the published provider factory contracts
 * (`AgentRuntimeProviderFactory` / `ChannelProviderFactory`).
 *
 * It must never import `@excitedjs/dreamux`. Because it imports from the package
 * ROOT only, it doubles as the over-exposure oracle: every type it must name to
 * implement these surfaces has to be a root export. The fixture is type-checked
 * by the package's test typecheck; the runtime assertions live in
 * `fixtures.test.ts`.
 *
 * Value-keyed submission/completion contract (task
 * `restore-value-keyed-turn-contract`): an accepted send is ONE
 * `RuntimeSubmission`, and a provider-observed native result is ONE frozen
 * `RuntimeCompletion` token. Submission identity never implies folding — the
 * TOKEN does. The fixture exposes both native shapes so a caller can prove the
 * difference from outside, without any "number of completions" knob:
 *
 * - queue: {@link fixtureRuntimeProvider}'s runtime opens and closes one native
 *   turn per accepted send, so two sends settle with two DISTINCT tokens even
 *   when their text is identical.
 * - fold: {@link createNativeTurnWindowRuntimeFixture} keeps a native turn OPEN
 *   until the caller reports a result, so every send accepted inside that
 *   window settles with the SAME `Object.is`-identical frozen token.
 */
import type {
  AgentRuntime,
  AgentRuntimeBinCheck,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeProviderFactory,
  AgentRuntimeStatus,
  AgentRuntimeSystemPrompt,
  AgentRuntimeTextInput,
  AgentRuntimeTranscriptPage,
  ChannelBindingRouteEvent,
  ChannelCoreEventSubscription,
  ChannelInboundEnvelope,
  ChannelMessageTargetCheck,
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelProviderFactory,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelSession,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolDescriptor,
  DreamuxLogger,
  InboundTurnInput,
  RuntimeActivityEvent,
  RuntimeActivitySink,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

export const EXTERNAL_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

export function describeConfigContext(
  context: AgentRuntimeProviderConfigReadContext,
): string {
  return `${context.providerRef}:${context.agentId}`;
}

export const appendArrayPrompt: AgentRuntimeSystemPrompt = {
  replace: 'full replacement prompt',
  append: ['first append fragment', 'second append fragment'],
};

/** The fixture runtime's parsed config shape. */
interface FixtureRuntimeConfig {
  model: string;
}

/** One accepted send the fixture has not settled yet. */
interface PendingFixtureSubmission {
  readonly submission: RuntimeSubmission;
  settle(settlement: RuntimeSubmissionSettlement): void;
}

/**
 * Open one accepted send. Settlement is one-shot: later calls are ignored, so a
 * submission drained by `stop()` can never be re-settled by a late result.
 */
function openSubmission(): PendingFixtureSubmission {
  let resolve!: (settlement: RuntimeSubmissionSettlement) => void;
  const settled = new Promise<RuntimeSubmissionSettlement>((resolveSettled) => {
    resolve = resolveSettled;
  });
  const submission: RuntimeSubmission = Object.freeze({ settled });
  let done = false;
  return {
    submission,
    settle(settlement) {
      if (done) return;
      done = true;
      resolve(settlement);
    },
  };
}

/**
 * Mint the frozen, opaque completion token for ONE provider-observed native
 * result. `displaySubmission` is the send that owns the display position for
 * that result — for a folded native turn, the first send admitted into it.
 */
function mintCompletion(
  displaySubmission: RuntimeSubmission,
  resultText: string | null,
): RuntimeCompletion {
  return Object.freeze<RuntimeCompletion>({
    status: 'completed',
    displaySubmission,
    resultText,
    truncated: false,
  });
}

/**
 * One accepted send that has already observed its own native result.
 *
 * Note the circular reference the contract forces: the token names the
 * submission (`displaySubmission`) and the submission settles with the token.
 * So the deferred submission is created FIRST, the token is frozen around it,
 * and only then is the submission resolved with `{ kind: 'completion' }`.
 */
function settledSubmission(resultText: string | null): RuntimeSubmission {
  const pending = openSubmission();
  const completion = mintCompletion(pending.submission, resultText);
  pending.settle({ kind: 'completion', completion });
  return pending.submission;
}

class FixtureRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/fixture-runtime';
  private status: AgentRuntimeStatus = 'declared';
  private threadId: string | null = null;
  private readonly logger?: DreamuxLogger;
  /** Required by the create context and captured before `start()` runs. */
  private readonly activitySink: RuntimeActivitySink;
  private clock = 0;

  constructor(context: AgentRuntimeCreateContext<FixtureRuntimeConfig>) {
    this.logger = context.logger;
    this.threadId = context.identity.checkpoint?.id ?? null;
    this.activitySink = context.activitySink;
  }

  async start(): Promise<void> {
    this.status = 'ready';
    this.logger?.info('fixture runtime started');
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    return this.admit(`channel:${input.text}`);
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return this.threadId === null ? null : { id: this.threadId };
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return { usedTokens: null, windowTokens: null };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return EXTERNAL_RUNTIME_CAPABILITIES;
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return this.admit(`completion:${input.text}`);
  }

  /**
   * Each accepted send opens AND closes its own native turn, so two sends
   * settle with two distinct tokens even when their text is identical. See
   * {@link createNativeTurnWindowRuntimeFixture} for the folding shape.
   */
  private admit(resultText: string): RuntimeAdmission {
    if (this.status === 'stopping' || this.status === 'stopped') {
      return { status: 'stopped' };
    }
    const pending = openSubmission();
    // Live activity is reported against the send that owns it, before the
    // native result settles it.
    this.report(pending.submission, resultText);
    const completion = mintCompletion(pending.submission, resultText);
    pending.settle({ kind: 'completion', completion });
    return { status: 'submitted', submission: pending.submission };
  }

  private report(submission: RuntimeSubmission, text: string): void {
    this.clock += 1;
    this.activitySink({
      submission,
      activity: {
        kind: 'assistant.message',
        id: `fixture-message-${this.clock}`,
        text,
        truncated: false,
      },
      occurredAt: 1_700_000_000_000 + this.clock,
    });
  }
}

/**
 * Runtime fixture for the FOLD half of the contract: the native turn stays OPEN
 * until the caller reports a result, so every send admitted inside that window
 * settles with ONE `Object.is`-identical frozen token. Closing the window
 * before the next send yields the queue shape instead — the boundary, not a
 * knob, is what decides.
 */
class NativeTurnWindowFixtureRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/fixture-runtime';
  private status: AgentRuntimeStatus = 'declared';
  private readonly activitySink: RuntimeActivitySink;
  private readonly openWindow: PendingFixtureSubmission[] = [];
  private clock = 0;

  constructor(context: AgentRuntimeCreateContext<FixtureRuntimeConfig>) {
    this.activitySink = context.activitySink;
  }

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopping';
    // No native result was observed, so these mint NO token.
    for (const pending of this.openWindow.splice(0)) {
      pending.settle({ kind: 'stopped' });
    }
    this.status = 'stopped';
  }

  async channelInput(_input: InboundTurnInput): Promise<RuntimeAdmission> {
    return this.admit();
  }

  async completionInput(_input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return this.admit();
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): null {
    return null;
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return EXTERNAL_RUNTIME_CAPABILITIES;
  }

  /** Report ONE native result, closing the open fold window. */
  completeNativeTurn(resultText: string | null): RuntimeCompletion {
    const folded = this.openWindow.splice(0);
    if (folded.length === 0) {
      throw new Error('no open native turn to complete');
    }
    // The FIRST send admitted into the window owns the display position.
    const displaySubmission = folded[0].submission;
    if (resultText !== null) {
      this.clock += 1;
      const event: RuntimeActivityEvent = {
        submission: displaySubmission,
        activity: {
          kind: 'assistant.message',
          id: `fixture-window-message-${this.clock}`,
          text: resultText,
          truncated: false,
        },
        occurredAt: 1_700_000_000_000 + this.clock,
      };
      this.activitySink(event);
    }
    const completion = mintCompletion(displaySubmission, resultText);
    for (const pending of folded) {
      pending.settle({ kind: 'completion', completion });
    }
    return completion;
  }

  private admit(): RuntimeAdmission {
    if (this.status === 'stopping' || this.status === 'stopped') {
      return { status: 'stopped' };
    }
    const pending = openSubmission();
    this.openWindow.push(pending);
    return { status: 'submitted', submission: pending.submission };
  }
}

/**
 * The fold/queue seam an outside caller drives: sends accepted before
 * `completeNativeTurn()` share ONE token; sends separated by a
 * `completeNativeTurn()` boundary each get their own.
 */
export function createNativeTurnWindowRuntimeFixture(): {
  runtime: AgentRuntime;
  completeNativeTurn(resultText: string | null): RuntimeCompletion;
  activity: readonly RuntimeActivityEvent[];
} {
  const activity: RuntimeActivityEvent[] = [];
  const runtime = new NativeTurnWindowFixtureRuntime({
    identity: { runtime_id: 'fixture-window', checkpoint: null },
    config: { model: 'fixture-model' },
    cwd: '/tmp/fixture',
    mcpServers: [],
    activitySink: (event) => {
      activity.push(event);
    },
  });
  return {
    runtime,
    completeNativeTurn: (resultText) => runtime.completeNativeTurn(resultText),
    activity,
  };
}

/**
 * Runtime fixture for the public stop-convergence contract. The transport gate
 * models an already-started native admission that teardown must settle before
 * `stop()` is allowed to resolve.
 */
class PendingAdmissionFixtureRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/pending-admission-runtime';
  private status: AgentRuntimeStatus = 'ready';
  private stopping = false;
  private readonly pending = new Set<Promise<RuntimeAdmission>>();

  constructor(
    private readonly transportGate: Promise<void>,
    private readonly onAdmissionStarted: () => void,
  ) {}

  async start(): Promise<void> {}

  async resume(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopping = true;
    this.status = 'stopping';
    await this.transportGate;
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
    this.status = 'stopped';
  }

  channelInput(_input: InboundTurnInput): Promise<RuntimeAdmission> {
    return this.admit();
  }

  completionInput(_input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return this.admit();
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): null {
    return null;
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return EXTERNAL_RUNTIME_CAPABILITIES;
  }

  private admit(): Promise<RuntimeAdmission> {
    if (this.stopping) return Promise.resolve({ status: 'stopped' });
    this.onAdmissionStarted();
    // The fence is checked AFTER the transport settles, so a stopped admission
    // mints no completion token at all.
    const admission = this.transportGate.then<RuntimeAdmission>(() =>
      this.stopping
        ? { status: 'stopped' }
        : {
            status: 'submitted',
            submission: settledSubmission('pending admission result'),
          },
    );
    this.pending.add(admission);
    void admission.finally(() => this.pending.delete(admission));
    return admission;
  }
}

export function createPendingAdmissionRuntimeFixture(): {
  runtime: AgentRuntime;
  admissionStarted: Promise<void>;
  releaseTransport(): void;
} {
  let releaseTransport!: () => void;
  let markAdmissionStarted!: () => void;
  const transportGate = new Promise<void>((resolve) => {
    releaseTransport = resolve;
  });
  const admissionStarted = new Promise<void>((resolve) => {
    markAdmissionStarted = resolve;
  });
  return {
    runtime: new PendingAdmissionFixtureRuntime(
      transportGate,
      markAdmissionStarted,
    ),
    admissionStarted,
    releaseTransport,
  };
}

const runtimeDescriptor: AgentRuntimeProviderDescriptor = {
  id: 'fixture-runtime',
  kind: 'agentRuntime',
  ref: {
    source: 'npm',
    package: '@example/fixture-runtime',
    export: null,
    raw: 'npm:@example/fixture-runtime',
  },
};

/**
 * An optional diagnostic driven by Dreamux core. The host supplies the
 * command runner; the fixture only declares bin checks and runs its own check.
 */
const fixtureRuntimeDiagnostic: AgentRuntimeDiagnostic<FixtureRuntimeConfig> = {
  binChecks(): AgentRuntimeBinCheck[] {
    return [{ name: 'fixture', bin: 'fixture-cli', args: ['--version'] }];
  },
  async runDiagnostic(context, runner): Promise<AgentRuntimeDiagnosticResult> {
    const ok = await runner.check('fixture-cli', ['--version'], {
      env: context.env,
    });
    return { ok, detail: ok ? 'fixture ready' : 'fixture missing', errors: [] };
  },
};

export const fixtureRuntimeProvider: AgentRuntimeProvider<FixtureRuntimeConfig> =
  {
    ref: 'npm:@example/fixture-runtime',
    descriptor: runtimeDescriptor,
    getCapabilities() {
      return EXTERNAL_RUNTIME_CAPABILITIES;
    },
    readConfig(rawConfig) {
      const model = typeof rawConfig.model === 'string' ? rawConfig.model : 'default';
      return { model };
    },
    diagnostic: fixtureRuntimeDiagnostic,
    async readTranscript(): Promise<AgentRuntimeTranscriptPage> {
      return { turns: [], nextCursor: null, truncated: false };
    },
    createRuntime(context) {
      return new FixtureRuntime(context);
    },
  };

/**
 * The package's default export an external runtime ships: the loader invokes it
 * with the seed `ProviderFactoryContext`, narrowed to the Agent Runtime kind.
 */
export const fixtureRuntimeFactory: AgentRuntimeProviderFactory<FixtureRuntimeConfig> =
  (context) => ({ ...fixtureRuntimeProvider, descriptor: context.descriptor });

class FixtureChannelSession implements ChannelSession {
  readonly provider = 'npm:@example/fixture-channel';
  readonly channel_id: string;
  private readonly logger?: DreamuxLogger;
  private readonly coreEventSubscriptions: ChannelCoreEventSubscription[] = [];

  constructor(channel_id: string, logger?: DreamuxLogger) {
    this.channel_id = channel_id;
    this.logger = logger;
  }

  async start(routes: ChannelRoutes): Promise<void> {
    this.logger?.info(
      { channel_id: this.channel_id },
      'fixture channel started',
    );
    if (routes.coreEvents !== undefined) {
      this.coreEventSubscriptions.push(
        routes.coreEvents.on(
          'binding.route',
          (event: ChannelBindingRouteEvent) => {
            this.logger?.info(
              {
                action: event.action,
                transition: event.transition,
                provider: event.endpoint.provider,
                endpoint_type: event.endpoint.endpoint_type,
                team_name: event.current_team?.team_name ?? null,
              },
              'fixture binding event',
            );
          },
        ),
      );
    }
    const envelope: ChannelInboundEnvelope = {
      provider: this.provider,
      channel_id: this.channel_id,
      target: { target_type: 'group', target_key: 'demo', bindable: true },
    };
    await routes.deliver(
      { text: 'fixture event', sourceId: 'fixture-event-1' },
      envelope,
    );
  }

  async close(): Promise<void> {
    for (const subscription of this.coreEventSubscriptions.splice(0)) {
      subscription.unsubscribe();
    }
  }

  async resolveTarget(meta: unknown): Promise<ChannelTarget> {
    const record = (meta ?? {}) as Record<string, unknown>;
    const key = String(record.id ?? 'unknown');
    return {
      target_type: 'group',
      target_key: key,
      bindable: true,
    };
  }

  async reply(input: ChannelReplyInput): Promise<unknown> {
    this.logger?.info({ key: input.target.target_key }, 'reply');
    return { delivered: true };
  }

  async react(input: ChannelReactInput): Promise<unknown> {
    return { reacted: input.reaction };
  }

  tools(): readonly ChannelToolDescriptor[] {
    return [
      {
        name: 'echo',
        description: 'echo a message',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ];
  }

  // Optional ChannelSession methods: a strict implementer names these param
  // types (they are not contextually inferred for optional members).
  async handleTool(call: ChannelToolCall): Promise<unknown> {
    return { echoed: call.name };
  }

  messageBelongsToTarget(input: ChannelMessageTargetCheck): boolean {
    return input.target.target_key === input.message_id;
  }
}

const channelDescriptor: ChannelProviderDescriptor = {
  id: 'fixture-channel',
  kind: 'channel',
  ref: {
    source: 'npm',
    package: '@example/fixture-channel',
    export: null,
    raw: 'npm:@example/fixture-channel',
  },
};

export const fixtureChannelProvider: ChannelProvider = {
  ref: 'npm:@example/fixture-channel',
  descriptor: channelDescriptor,
  createSession(context) {
    return new FixtureChannelSession(context.channel_id, context.logger);
  },
};

/** The package's default export an external channel ships. */
export const fixtureChannelFactory: ChannelProviderFactory = (context) => ({
  ...fixtureChannelProvider,
  descriptor: context.descriptor,
});

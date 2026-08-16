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
 */
import type {
  AgentRuntime,
  AgentRuntimeBinCheck,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticResult,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeProviderFactory,
  AgentRuntimeStatus,
  AgentRuntimeSystemPrompt,
  AgentRuntimeTextInput,
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
  RuntimeAdmission,
  RuntimeTurn,
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

class FixtureRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/fixture-runtime';
  private status: AgentRuntimeStatus = 'declared';
  private threadId: string | null = null;
  private readonly logger?: DreamuxLogger;

  constructor(context: AgentRuntimeCreateContext<FixtureRuntimeConfig>) {
    this.logger = context.logger;
    this.threadId = context.identity.checkpoint_id ?? null;
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

  async channelInput(_input: InboundTurnInput): Promise<RuntimeAdmission> {
    return { status: 'submitted', turn: completedRuntimeTurn() };
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

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return { text: null };
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return { usedTokens: null, windowTokens: null };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return EXTERNAL_RUNTIME_CAPABILITIES;
  }

  async completionInput(_input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return { status: 'submitted', turn: completedRuntimeTurn() };
  }
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

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return null;
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
    const admission = this.transportGate.then<RuntimeAdmission>(() =>
      this.stopping
        ? { status: 'stopped' }
        : { status: 'submitted', turn: completedRuntimeTurn() },
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

function completedRuntimeTurn(): RuntimeTurn {
  return Object.freeze({
    settled: Promise.resolve({
      status: 'completed' as const,
      resultText: null,
      truncated: false,
    }),
  });
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

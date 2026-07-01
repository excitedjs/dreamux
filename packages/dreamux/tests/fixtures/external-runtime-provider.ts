import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProviderFactory,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

interface ExternalParityRuntimeConfig {
  finalTextPrefix: string;
  model: string;
}

export interface ExternalRuntimeObservation {
  providerRef: string;
  runtimeId: string;
  cwd: string;
  config: ExternalParityRuntimeConfig;
  mcpServerNames: string[];
  disableFeatures: readonly string[];
  skillSourceNames: string[];
  injectEnvKeys: string[];
  hasTurnSettledHook: boolean;
  starts: number;
  stops: number;
  submittedTexts: string[];
  lastText: string | null;
}

export const EXTERNAL_PARITY_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

export const externalRuntimeObservations: ExternalRuntimeObservation[] = [];

export function resetExternalRuntimeFixture(): void {
  externalRuntimeObservations.splice(0);
}

class ExternalParityRuntime implements AgentRuntime {
  private status: AgentRuntimeStatus = 'declared';
  private threadId: string | null;

  constructor(
    readonly providerRef: string,
    private readonly context: AgentRuntimeCreateContext<ExternalParityRuntimeConfig>,
    private readonly observation: ExternalRuntimeObservation,
  ) {
    this.threadId = context.identity.checkpoint_id ?? null;
  }

  async start(): Promise<void> {
    this.status = 'ready';
    this.observation.starts += 1;
    this.threadId = `external-thread:${this.context.identity.runtime_id}`;
    await this.context.state?.setStatus('ready');
    await this.context.state?.setCheckpoint({ id: this.threadId });
  }

  async resume(): Promise<void> {
    await this.start();
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    this.observation.stops += 1;
    await this.context.state?.setStatus('stopped');
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    if (this.status !== 'ready') {
      return { status: 'failed', error: new Error('external runtime is not ready') };
    }
    this.observation.submittedTexts.push(input.text);
    const turnId = input.sourceId;
    this.observation.lastText =
      `${this.context.config.finalTextPrefix}: ${input.text}`;
    await Promise.resolve();
    this.context.onTurnSettled?.({
      turnId,
      status: 'completed',
      result: { text: this.observation.lastText },
    });
    return { status: 'submitted', turnId };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    if (this.status !== 'ready') {
      return { status: 'failed', error: new Error('external runtime is not ready') };
    }
    this.observation.submittedTexts.push(input.text);
    const turnId = input.sourceId ?? `plain:${this.observation.submittedTexts.length}`;
    this.observation.lastText =
      `${this.context.config.finalTextPrefix}: ${input.text}`;
    await Promise.resolve();
    this.context.onTurnSettled?.({
      turnId,
      status: 'completed',
      result: { text: this.observation.lastText },
    });
    return { status: 'submitted', turnId };
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
    return { text: this.observation.lastText };
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return EXTERNAL_PARITY_RUNTIME_CAPABILITIES;
  }
}

export const provider: AgentRuntimeProviderFactory<ExternalParityRuntimeConfig> =
  ({ ref, descriptor }) => ({
    ref,
    descriptor,
    getCapabilities() {
      return EXTERNAL_PARITY_RUNTIME_CAPABILITIES;
    },
    readConfig(rawConfig) {
      return {
        finalTextPrefix:
          typeof rawConfig['finalTextPrefix'] === 'string'
            ? rawConfig['finalTextPrefix']
            : 'external-runtime-completed',
        model: typeof rawConfig['model'] === 'string' ? rawConfig['model'] : 'fake',
      };
    },
    createRuntime(context) {
      const observation: ExternalRuntimeObservation = {
        providerRef: ref,
        runtimeId: context.identity.runtime_id,
        cwd: context.cwd,
        config: context.config,
        mcpServerNames: context.mcpServers.map((server) => server.name),
        disableFeatures: context.disableFeatures ?? [],
        skillSourceNames: context.skillSources?.map((source) => source.name) ?? [],
        injectEnvKeys: Object.keys(context.injectEnv ?? {}).sort(),
        hasTurnSettledHook: context.onTurnSettled !== undefined,
        starts: 0,
        stops: 0,
        submittedTexts: [],
        lastText: null,
      };
      externalRuntimeObservations.push(observation);
      return new ExternalParityRuntime(ref, context, observation);
    },
  });

export default provider;

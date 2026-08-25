import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeProviderFactory,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  InboundTurnInput,
  RuntimeAdmission,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
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
  /** Proves core installed the required live activity sink before start. */
  hasActivitySink: boolean;
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
    this.threadId = context.identity.checkpoint?.id ?? null;
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

  async channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    if (this.status !== 'ready') {
      return { status: 'failed', error: new Error('external runtime is not ready') };
    }
    this.observation.submittedTexts.push(input.text);
    this.observation.lastText =
      `${this.context.config.finalTextPrefix}: ${input.text}`;
    await Promise.resolve();
    return {
      status: 'submitted',
      submission: completedSubmission(this.observation.lastText),
    };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    if (this.status !== 'ready') {
      return { status: 'failed', error: new Error('external runtime is not ready') };
    }
    this.observation.submittedTexts.push(input.text);
    this.observation.lastText =
      `${this.context.config.finalTextPrefix}: ${input.text}`;
    await Promise.resolve();
    return {
      status: 'submitted',
      submission: completedSubmission(this.observation.lastText),
    };
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
    async readTranscript(query) {
      const text = externalRuntimeObservations.at(-1)?.lastText ?? null;
      return {
        turns:
          text === null || query.turns < 1
            ? []
            : [
                {
                  startedAt: null,
                  endedAt: null,
                  blocks: [
                    {
                      kind: 'message' as const,
                      role: 'assistant' as const,
                      text,
                      truncated: false,
                    },
                  ],
                },
              ],
        nextCursor: null,
        truncated: false,
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
        hasActivitySink: typeof context.activitySink === 'function',
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

function completedSubmission(resultText: string | null): RuntimeSubmission {
  // One accepted send -> one submission; this fixture's runtime answers each
  // send on its own native result boundary, so every submission gets its OWN
  // frozen completion token (the queued shape). Folding would instead reuse a
  // single token across several submissions.
  let resolve!: (settlement: RuntimeSubmissionSettlement) => void;
  const submission: RuntimeSubmission = Object.freeze({
    settled: new Promise<RuntimeSubmissionSettlement>((accept) => {
      resolve = accept;
    }),
  });
  resolve({
    kind: 'completion',
    completion: Object.freeze({
      status: 'completed' as const,
      displaySubmission: submission,
      resultText,
      truncated: false,
    }),
  });
  return submission;
}

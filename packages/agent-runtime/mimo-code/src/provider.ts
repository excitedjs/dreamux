import {
  assertNoNativeMcpConfig,
  DEFAULT_MIMO_CODE_BIN,
  readMimoCodeConfig,
  type MimoCodeConfig,
} from './config.js';
import { mimoCodeAgentRuntimeDiagnostic } from './diagnostic.js';
import { MIMO_CODE_PROVIDER_REF } from './provider-ref.js';
import {
  MimoCodeRuntime,
  type MimoCodeRuntimeDeps,
} from './runtime.js';
import type { MimoServerFactory } from './supervisor.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeProviderFactory,
  ProviderDescriptor,
  ProviderFactoryContext,
} from '@excitedjs/dreamux-types';

export interface MimoCodeAgentRuntimeProviderOptions {
  descriptor?: ProviderDescriptor;
  serverFactory?: MimoServerFactory;
}

export const MIMO_CODE_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true },
};

const DEFAULT_DESCRIPTOR: AgentRuntimeProviderDescriptor = {
  id: 'mimo-code',
  kind: 'agentRuntime',
  ref: {
    source: 'npm',
    package: '@excitedjs/agent-runtime-mimo-code',
    export: null,
    raw: MIMO_CODE_PROVIDER_REF,
  },
};

function asAgentRuntimeDescriptor(
  descriptor: ProviderDescriptor,
): AgentRuntimeProviderDescriptor {
  if (descriptor.kind !== 'agentRuntime') {
    throw new Error(
      `@excitedjs/agent-runtime-mimo-code: descriptor.kind must be ` +
        `'agentRuntime' (got ${JSON.stringify(descriptor.kind)})`,
    );
  }
  return { ...descriptor, kind: descriptor.kind };
}

export function createMimoCodeAgentRuntimeProvider(
  options: MimoCodeAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider<MimoCodeConfig> {
  return {
    ref: MIMO_CODE_PROVIDER_REF,
    descriptor:
      options.descriptor === undefined
        ? DEFAULT_DESCRIPTOR
        : asAgentRuntimeDescriptor(options.descriptor),
    getCapabilities: () => MIMO_CODE_AGENT_RUNTIME_CAPABILITIES,
    diagnostic: mimoCodeAgentRuntimeDiagnostic,
    onboard: {
      async collect(_context, prompts): Promise<Record<string, unknown>> {
        const bin = await prompts.text({
          message: 'MiMo Code CLI binary',
          initialValue: DEFAULT_MIMO_CODE_BIN,
          required: true,
        });
        return { bin, permission_mode: 'deny' };
      },
    },
    readConfig(rawConfig, context) {
      assertNoNativeMcpConfig(rawConfig, context.file, context.prefix);
      return readMimoCodeConfig(rawConfig, context.file, context.prefix);
    },
    createRuntime(context: AgentRuntimeCreateContext<MimoCodeConfig>): AgentRuntime {
      const deps: MimoCodeRuntimeDeps = {
        context,
        ...(options.serverFactory !== undefined
          ? { serverFactory: options.serverFactory }
          : {}),
      };
      return new MimoCodeRuntime(context.identity, deps);
    },
  };
}

export { readMimoCodeConfig };

export type MimoCodeProviderFactoryContext =
  ProviderFactoryContext<AgentRuntimeProviderDescriptor>;

const mimoCodeAgentRuntimeProviderFactory: AgentRuntimeProviderFactory<MimoCodeConfig> =
  (context) =>
    createMimoCodeAgentRuntimeProvider({ descriptor: context.descriptor });

export default mimoCodeAgentRuntimeProviderFactory;

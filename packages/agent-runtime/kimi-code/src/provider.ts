import {
  DEFAULT_KIMI_CODE_BIN,
  readDispatcherKimiCodeConfig,
  type DispatcherKimiCodeConfig,
} from './config.js';
import { createDefaultKimiCodeAcpClient } from './acp-client.js';
import { KIMI_CODE_AGENT_RUNTIME_CAPABILITIES } from './capabilities.js';
import { KimiCodeRuntime, type KimiCodeRuntimeDeps } from './runtime.js';
import { KIMI_CODE_PROVIDER_REF } from './provider-ref.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeProviderFactory,
  ProviderDescriptor,
  ProviderFactoryContext,
} from '@excitedjs/dreamux-types';

export interface KimiCodeAgentRuntimeProviderOptions {
  descriptor?: ProviderDescriptor;
  clientFactory?: KimiCodeRuntimeDeps['clientFactory'];
}

const DEFAULT_KIMI_CODE_DESCRIPTOR: AgentRuntimeProviderDescriptor = {
  id: 'kimi-code',
  kind: 'agentRuntime',
  ref: {
    source: 'npm',
    package: '@excitedjs/agent-runtime-kimi-code',
    export: null,
    raw: KIMI_CODE_PROVIDER_REF,
  },
};

function asAgentRuntimeDescriptor(
  descriptor: ProviderDescriptor,
): AgentRuntimeProviderDescriptor {
  if (descriptor.kind !== 'agentRuntime') {
    throw new Error(
      `@excitedjs/agent-runtime-kimi-code: descriptor.kind must be 'agentRuntime' ` +
        `(got ${JSON.stringify(descriptor.kind)})`,
    );
  }
  return { ...descriptor, kind: descriptor.kind };
}

export function createKimiCodeAgentRuntimeProvider(
  options: KimiCodeAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider<DispatcherKimiCodeConfig> {
  const descriptor =
    options.descriptor === undefined
      ? DEFAULT_KIMI_CODE_DESCRIPTOR
      : asAgentRuntimeDescriptor(options.descriptor);
  return {
    ref: descriptor.ref.raw,
    descriptor,
    getCapabilities: () => KIMI_CODE_AGENT_RUNTIME_CAPABILITIES,
    onboard: {
      async collect(_context, prompts): Promise<Record<string, unknown>> {
        const bin = await prompts.text({
          message: 'Kimi Code CLI binary',
          initialValue: DEFAULT_KIMI_CODE_BIN,
          required: true,
        });
        return { bin };
      },
    },
    readConfig(rawConfig, context) {
      return readDispatcherKimiCodeConfig(rawConfig, context.file, context.prefix);
    },
    createRuntime(context: AgentRuntimeCreateContext<DispatcherKimiCodeConfig>): AgentRuntime {
      if (context.state === undefined) {
        throw new Error('kimi-code runtime requires a state sink in the create context');
      }
      if (context.paths === undefined) {
        throw new Error('kimi-code runtime requires a path context in the create context');
      }
      const systemPromptAppend =
        context.systemPrompt?.append?.filter((entry) => entry !== '') ?? [];
      if (
        context.systemPrompt?.replace !== undefined &&
        systemPromptAppend.length === 0
      ) {
        throw new Error(
          'kimi-code runtime cannot apply systemPrompt.replace; Kimi ACP exposes no public replacement hook and no append fallback was supplied',
        );
      }
      if (context.systemPrompt?.replace !== undefined) {
        context.logger?.warn?.(
          'kimi-code runtime cannot replace Kimi base instructions; applying append-only Dreamux instructions through KIMI_CODE_HOME/AGENTS.md',
        );
      }
      return new KimiCodeRuntime(context.identity, {
        providerRef: descriptor.ref.raw,
        config: context.config,
        cwd: context.cwd,
        state: context.state,
        paths: context.paths,
        mcpServers: context.mcpServers,
        clientFactory: options.clientFactory ?? createDefaultKimiCodeAcpClient,
        ...(context.injectEnv !== undefined
          ? { injectEnv: context.injectEnv }
          : {}),
        ...(systemPromptAppend.length > 0
          ? { systemPromptAppend }
          : {}),
        ...(context.skillSources !== undefined
          ? { skillSources: context.skillSources }
          : {}),
        ...(context.disableFeatures !== undefined
          ? { disableFeatures: context.disableFeatures }
          : {}),
        ...(context.onTurnSettled !== undefined
          ? { onTurnSettled: context.onTurnSettled }
          : {}),
        ...(context.logger !== undefined ? { logger: context.logger } : {}),
      });
    },
  };
}

export type KimiCodeProviderFactoryContext =
  ProviderFactoryContext<AgentRuntimeProviderDescriptor>;

const kimiCodeAgentRuntimeProviderFactory: AgentRuntimeProviderFactory<DispatcherKimiCodeConfig> =
  (context) => createKimiCodeAgentRuntimeProvider({ descriptor: context.descriptor });

export default kimiCodeAgentRuntimeProviderFactory;

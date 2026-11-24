import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
} from '@excitedjs/dreamux-types';
import { unsupportedFeatureError } from '@excitedjs/dreamux-utils';

import { AcpRuntime } from './acp/runtime.js';
import {
  DEFAULT_ANTIGRAVITY_BIN,
  readAntigravityConfig,
  type AntigravityConfig,
} from './config.js';
import { antigravityAgentRuntimeDiagnostic } from './diagnostic.js';
import { prepareNativeCustomizations } from './native-customizations.js';
import { resolveAntigravityNativeRoots } from './paths.js';
import { TmuxRuntime } from './tmux/runtime.js';
import { readAntigravityRecentActivity } from './transcript/reader.js';

/** Create the external Antigravity provider over one native agy installation. */
export function createAntigravityAgentRuntimeProvider(): AgentRuntimeProvider<AntigravityConfig> {
  return {
    diagnostic: antigravityAgentRuntimeDiagnostic,
    operatorStateRoot: (env) => resolveAntigravityNativeRoots(env).geminiHome,
    onboard: {
      async collect(_context, prompts): Promise<Record<string, unknown>> {
        const bin = await prompts.text({
          message: 'Antigravity CLI binary',
          initialValue: DEFAULT_ANTIGRAVITY_BIN,
          required: true,
        });
        return { bin };
      },
    },
    config: {
      read(rawConfig, context) {
        return readAntigravityConfig(rawConfig, context.file, context.prefix);
      },
    },
    readRecentActivity: readAntigravityRecentActivity,
    async createRuntime(
      context: AgentRuntimeCreateContext<AntigravityConfig>,
    ): Promise<AgentRuntime> {
      if (context.outputSchema !== undefined) {
        throw unsupportedFeatureError(
          'outputSchema',
          'Antigravity does not support neutral structured output',
        );
      }
      if (
        context.systemPrompt?.replace !== undefined &&
        context.systemPrompt.append === undefined
      ) {
        throw unsupportedFeatureError(
          'systemPrompt.replace',
          'Antigravity default agents support prompt append, not replacement',
        );
      }
      const options = await prepareNativeCustomizations(context);
      return context.config.transport === 'acp'
        ? new AcpRuntime(context, options)
        : new TmuxRuntime(context, options);
    },
  };
}

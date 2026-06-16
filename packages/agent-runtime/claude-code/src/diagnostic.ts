/**
 * The `builtin:claude-code` self-reported diagnostic surface (issue #146 fold;
 * relocated into the owning package by the issue #209 cleanup).
 *
 * Claude Code has no host-managed home/auth/version state Dreamux owns, so it
 * only declares its bin check; the internal diagnostic is a neutral pass. Runs
 * entirely against the neutral `@excitedjs/dreamux-types` diagnostic context.
 */
import type {
  AgentRuntimeBinCheck,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDiagnosticResult,
} from '@excitedjs/dreamux-types';

import {
  type DispatcherClaudeCodeConfig,
  DEFAULT_CLAUDE_CODE_BIN,
} from './config.js';

type ClaudeDiagnosticContext =
  AgentRuntimeDiagnosticContext<DispatcherClaudeCodeConfig>;

function claudeBinCheckName(scope: ClaudeDiagnosticContext['scope']): string {
  return scope === 'managedService'
    ? 'managed service Claude Code binary'
    : 'claude-code binary';
}

export const claudeCodeAgentRuntimeDiagnostic: AgentRuntimeDiagnostic<DispatcherClaudeCodeConfig> =
  {
    binChecks(context): AgentRuntimeBinCheck[] {
      return [
        {
          name: claudeBinCheckName(context.scope),
          bin: context.config.bin || DEFAULT_CLAUDE_CODE_BIN,
          args: ['--help'],
        },
      ];
    },
    async runDiagnostic(): Promise<AgentRuntimeDiagnosticResult> {
      return {
        ok: true,
        detail: 'Claude Code runtime has no host-managed home state',
        errors: [],
      };
    },
  };

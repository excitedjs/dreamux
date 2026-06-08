import type {
  AgentRuntimeBinCheck,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDoctorResult,
} from '../../types.js';
import { dispatcherClaudeCodeConfig, DEFAULT_CLAUDE_CODE_BIN } from './config.js';

function claudeBinCheckName(scope: AgentRuntimeDiagnosticContext['scope']): string {
  return scope === 'managedService'
    ? 'managed service Claude Code binary'
    : 'claude-code binary';
}

/**
 * The `builtin:claude-code` doctor surface (issue #146 fold). Claude Code has no
 * host-managed home/auth/version state dreamux owns, so it only declares its bin
 * check; the internal diagnostic is a neutral pass.
 */
export const claudeCodeAgentRuntimeDiagnostic: AgentRuntimeDiagnostic = {
  binChecks(context): AgentRuntimeBinCheck[] {
    return [
      {
        name: claudeBinCheckName(context.scope),
        bin:
          dispatcherClaudeCodeConfig(context.dispatcher).bin ||
          DEFAULT_CLAUDE_CODE_BIN,
        args: ['--help'],
      },
    ];
  },
  async runDiagnostic(): Promise<AgentRuntimeDoctorResult> {
    return {
      ok: true,
      detail: 'Claude Code runtime has no host-managed home state',
      errors: [],
    };
  },
};

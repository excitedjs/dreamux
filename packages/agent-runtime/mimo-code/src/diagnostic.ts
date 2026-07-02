import { DEFAULT_MIMO_CODE_BIN, type MimoCodeConfig } from './config.js';
import type {
  AgentRuntimeBinCheck,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDiagnosticResult,
} from '@excitedjs/dreamux-types';

type MimoDiagnosticContext = AgentRuntimeDiagnosticContext<MimoCodeConfig>;

function mimoBinCheckName(scope: MimoDiagnosticContext['scope']): string {
  return scope === 'managedService'
    ? 'managed service MiMo Code binary'
    : 'mimo-code binary';
}

export const mimoCodeAgentRuntimeDiagnostic: AgentRuntimeDiagnostic<MimoCodeConfig> =
  {
    binChecks(context): AgentRuntimeBinCheck[] {
      return [
        {
          name: mimoBinCheckName(context.scope),
          bin: context.config.bin || DEFAULT_MIMO_CODE_BIN,
          args: ['--help'],
        },
      ];
    },
    async runDiagnostic(): Promise<AgentRuntimeDiagnosticResult> {
      return {
        ok: true,
        detail:
          'MiMo Code runtime diagnostics are limited to binary checks in this package slice',
        errors: [],
      };
    },
  };

import { join } from 'node:path';

import type {
  AgentRuntimeBinCheck,
  AgentRuntimeDiagnosticCapability,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDiagnosticResult,
} from '@excitedjs/dreamux-types';
import { unixSocketPathFitsBudget } from '@excitedjs/dreamux-utils';

import { DEFAULT_ANTIGRAVITY_BIN, type AntigravityConfig } from './config.js';
import {
  antigravityVersionSatisfies,
  MIN_ANTIGRAVITY_VERSION,
} from './version.js';

type DiagnosticContext = AgentRuntimeDiagnosticContext<AntigravityConfig>;

export const antigravityAgentRuntimeDiagnostic: AgentRuntimeDiagnosticCapability<AntigravityConfig> =
  {
    binChecks(context): AgentRuntimeBinCheck[] {
      const checks: AgentRuntimeBinCheck[] = [
        {
          name: `Antigravity ${context.config.transport} binary`,
          bin: context.config.bin || DEFAULT_ANTIGRAVITY_BIN,
          args: ['--help'],
        },
      ];
      if (context.config.transport === 'tmux') {
        checks.push({
          name: 'Antigravity tmux binary',
          bin: 'tmux',
          args: ['-V'],
        });
      }
      return checks;
    },
    async runDiagnostic(
      context: DiagnosticContext,
      runner,
    ): Promise<AgentRuntimeDiagnosticResult> {
      const errors: string[] = [];
      if (context.config.transport === 'tmux' && process.platform === 'win32') {
        errors.push('Antigravity tmux transport is not supported on Windows');
      }
      if (
        context.config.transport === 'tmux' &&
        !context.paths
          .runtimeSocketDirs()
          .some((dir) => unixSocketPathFitsBudget(join(dir, 'a-XXXXXX', 's')))
      ) {
        errors.push('No neutral runtime socket directory fits a tmux socket');
      }
      let version = '';
      try {
        version = await runner.capture(context.config.bin, ['--version'], {
          env: { ...context.env, ...context.config.extra_env },
        });
        if (!antigravityVersionSatisfies(version)) {
          errors.push(
            `Antigravity reported ${version.trim() || '<empty>'}; requires agy >= ${MIN_ANTIGRAVITY_VERSION}`,
          );
        }
      } catch (error) {
        errors.push(
          `Could not determine Antigravity version: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        ok: errors.length === 0,
        detail: `Antigravity ${context.config.transport}: ${version.trim() || 'version unavailable'}`,
        errors,
      };
    },
  };

/**
 * The `builtin:codex` self-reported diagnostic surface (issue #146 fold; relocated
 * into the owning package by the issue #209 cleanup).
 *
 * Declares the codex bin check (deduped + executed by Dreamux core) and runs
 * the codex-home validation plus the codex version gate (#147) itself,
 * entirely against the neutral `@excitedjs/dreamux-types` diagnostic context. The
 * representative app-server socket sample is derived from the neutral path
 * context's `runtimeSocketDirs()`, so the package never names `~/.dreamux`.
 */
import type {
  AgentRuntimeBinCheck,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeDiagnosticResult,
} from '@excitedjs/dreamux-types';

import { codexArgsFromConfig, codexArgsToCli } from './args.js';
import { type DispatcherCodexConfig } from './config.js';
import {
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
} from './codex-home.js';
import { representativeCodexSocketPath } from './internal/socket.js';
import { resolveCodexBinPath } from './bin.js';
import { MIN_CODEX_VERSION, codexVersionSatisfies } from './version.js';

type CodexDiagnosticContext = AgentRuntimeDiagnosticContext<DispatcherCodexConfig>;

function codexBinCheckName(scope: CodexDiagnosticContext['scope']): string {
  return scope === 'managedService' ? 'managed service Codex binary' : 'codex binary';
}

async function checkCodexVersion(
  context: CodexDiagnosticContext,
  runner: AgentRuntimeDiagnosticRunner,
): Promise<string | null> {
  const bin = resolveCodexBinPath(context.config.bin, context.env);
  let raw: string;
  try {
    raw = await runner.capture(bin, ['--version'], { env: context.env });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return `could not determine Codex version from ${bin}: ${cause}; requires codex >= ${MIN_CODEX_VERSION}`;
  }
  if (codexVersionSatisfies(raw)) return null;
  return (
    `Codex at ${bin} reported ${raw.trim() || '<empty>'}; requires codex >= ` +
    `${MIN_CODEX_VERSION} for the app-server runtime protocol`
  );
}

export const codexAgentRuntimeDiagnostic: AgentRuntimeDiagnostic<DispatcherCodexConfig> =
  {
    binChecks(context): AgentRuntimeBinCheck[] {
      return [
        {
          name: codexBinCheckName(context.scope),
          bin: resolveCodexBinPath(context.config.bin, context.env),
          args: ['--help'],
        },
      ];
    },
    async runDiagnostic(context, runner): Promise<AgentRuntimeDiagnosticResult> {
      const cliArgs = codexArgsToCli(codexArgsFromConfig(context.config));
      const socketDirs = context.paths?.runtimeSocketDirs() ?? [];
      const homeContext = dispatcherCodexHomeDoctorContext(context.runtime_id, {
        codexCliArgs: cliArgs,
        socketPath: representativeCodexSocketPath(socketDirs, context.runtime_id),
      });
      const home = await validateDispatcherCodexHome(homeContext, {
        env: context.env,
        codexCliArgs: cliArgs,
      });
      const errors = [...home.errors];
      const versionError = await checkCodexVersion(context, runner);
      if (versionError !== null) errors.push(versionError);
      // Detail mirrors the old printCodexHomeDoctor line (the codex home path);
      // per-problem lines live in `errors`.
      return {
        ok: errors.length === 0,
        detail: homeContext.codexHome,
        errors,
      };
    },
  };

import type {
  AgentRuntimeBinCheck,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeDoctorResult,
} from '../../types.js';
import { defaultDispatcherCwd } from '../../../platform/paths.js';
import { codexArgsFromConfig, codexArgsToCli } from './args.js';
import { dispatcherCodexConfig, DEFAULT_CODEX_BIN } from './config.js';
import {
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
} from './codex-home.js';
import { resolveCodexBinPath } from './provider.js';
import {
  MIN_CODEX_VERSION,
  codexVersionSatisfies,
} from '@excitedjs/agent-runtime-codex';

// The codex version gate (MIN_CODEX_VERSION / parseCodexVersion /
// codexVersionSatisfies) now lives in `@excitedjs/agent-runtime-codex`; it is
// re-exported here so existing import paths stay stable (issue #209 slice 3).
export {
  MIN_CODEX_VERSION,
  parseCodexVersion,
  codexVersionSatisfies,
} from '@excitedjs/agent-runtime-codex';

function codexBinCheckName(scope: AgentRuntimeDiagnosticContext['scope']): string {
  return scope === 'managedService' ? 'managed service Codex binary' : 'codex binary';
}

function codexCliArgs(context: AgentRuntimeDiagnosticContext): string[] {
  const codexConfig = dispatcherCodexConfig(context.dispatcher);
  return codexArgsToCli(codexArgsFromConfig(codexConfig));
}

async function checkCodexVersion(
  context: AgentRuntimeDiagnosticContext,
  runner: AgentRuntimeDiagnosticRunner,
): Promise<string | null> {
  const bin = resolveCodexBinPath(
    dispatcherCodexConfig(context.dispatcher).bin,
    context.env,
  );
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
    `${MIN_CODEX_VERSION} for teammate completion delivery (thread/inject_items)`
  );
}

/**
 * The `builtin:codex` doctor surface (issue #146 fold). Declares the codex bin
 * check (deduped + executed by doctor) and runs the codex-home validation plus
 * the codex version gate (#147) itself.
 */
export const codexAgentRuntimeDiagnostic: AgentRuntimeDiagnostic = {
  binChecks(context): AgentRuntimeBinCheck[] {
    return [
      {
        name: codexBinCheckName(context.scope),
        bin: resolveCodexBinPath(
          dispatcherCodexConfig(context.dispatcher).bin,
          context.env,
        ),
        args: ['--help'],
      },
    ];
  },
  async runDiagnostic(context, runner): Promise<AgentRuntimeDoctorResult> {
    const cliArgs = codexCliArgs(context);
    const homeContext = dispatcherCodexHomeDoctorContext(context.dispatcher.id, {
      codexCliArgs: cliArgs,
      dispatcherCwd:
        context.dispatcher.cwd ?? defaultDispatcherCwd(context.dispatcher.id),
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

export { DEFAULT_CODEX_BIN };

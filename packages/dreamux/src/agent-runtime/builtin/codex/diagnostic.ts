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

/**
 * Minimum codex version dreamux requires. The teammate-completion reverse leg
 * (#147) appends the completion to the dispatcher thread via `thread/inject_items`,
 * an RPC that exists only on codex >= 0.137. Doctor surfaces this loudly rather
 * than letting a teammate completion silently RPC-fail at runtime.
 */
export const MIN_CODEX_VERSION = '0.137.0';

/** Parse a `major.minor.patch` triple out of a `codex --version` line. */
export function parseCodexVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric (not string) component-wise compare against {@link MIN_CODEX_VERSION}. */
export function codexVersionSatisfies(raw: string): boolean {
  const got = parseCodexVersion(raw);
  if (got === null) return false;
  const min = parseCodexVersion(MIN_CODEX_VERSION)!;
  for (let i = 0; i < 3; i += 1) {
    if (got[i] > min[i]) return true;
    if (got[i] < min[i]) return false;
  }
  return true;
}

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

/**
 * Claude Code runtime artifact paths. These are the Claude Code runtime's own
 * bookkeeping files (the generated MCP config dir/file and the resident
 * stream-json child's stderr stream log). They were relocated out of the shared
 * `platform/paths` layer (issue #143 de-leak) so the shared layer stays
 * runtime-neutral; every string here is byte-identical to its former
 * `platform/paths.ts` output.
 */

import { join } from 'node:path';

import {
  dispatcherDir,
  dispatcherPathSegment,
  logsRoot,
  teamMateNameSegment,
} from '../../../platform/paths.js';

/**
 * Central Claude Code log directory. Relocated out of `platform/paths`
 * (issue #143 de-leak) so the shared layer never names `claude-code`; the
 * string is byte-identical to its former `platform/paths.ts` output.
 */
export function claudeCodeLogDir(): string {
  return join(logsRoot(), 'claude-code');
}

/**
 * Per-dispatcher Claude Code runtime state dir (issue #110 PR6). Holds the
 * generated Claude Code MCP config; kept under the dispatcher's state dir, not
 * the workspace cwd, so it never pollutes the operator's repo.
 */
export function dispatcherClaudeCodeDir(id: string): string {
  return join(dispatcherDir(id), 'claude-code');
}

/** The generated Claude Code MCP config file (`--mcp-config <path>`). */
export function dispatcherClaudeCodeMcpConfigPath(id: string): string {
  return join(dispatcherClaudeCodeDir(id), 'mcp.json');
}

/**
 * Per-dispatcher Claude Code resident stream-json child diagnostics (issue
 * #120). The child's stdout is the NDJSON data plane (consumed in-process by the
 * runtime), so only its stderr is logged here for crash diagnosis.
 */
export function dispatcherClaudeCodeStreamLogPath(id: string): string {
  return join(claudeCodeLogDir(), `${dispatcherPathSegment(id)}.stderr.log`);
}

/**
 * Per-teammate Claude Code resident stream-json child stderr log, under the
 * central claude-code log tree.
 */
export function teammateClaudeCodeStreamLogPath(
  id: string,
  teammateName: string,
): string {
  return join(
    claudeCodeLogDir(),
    'teammate',
    dispatcherPathSegment(id),
    `${teamMateNameSegment(teammateName)}.stderr.log`,
  );
}

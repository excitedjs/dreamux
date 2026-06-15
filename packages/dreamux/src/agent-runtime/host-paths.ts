/**
 * Host implementations of the neutral `AgentRuntimePathContext`
 * (`@excitedjs/dreamux-types`). The Dreamux host owns where a runtime's
 * artifacts land — the per-runtime state root, the central log tree, the
 * completion-spill cache, and the preference-ordered volatile-socket dirs — and
 * exposes them through this neutral context so a provider composes its OWN
 * subpaths without naming any host directory (issue #209 cleanup).
 *
 * These are provider-NEUTRAL: logs are now composed by the runtime as
 * `<logsDir()>/<engine>/<runtime_id>.log`, so the host no longer branches on the
 * runtime ref to pick a log path. The only per-launcher difference is grouping:
 * a teammate's state runtime dir and completion spill stay nested under its
 * OPERATOR dispatcher (not its composite runtime id), so a teammate context
 * closes over the operator id rather than keying off the passed runtime id.
 */
import type { AgentRuntimePathContext } from '@excitedjs/dreamux-types';

import {
  dispatcherCompletionSpillDir,
  dispatcherDir,
  dispatcherTeamMateRuntimeDir,
  logsRoot,
} from '../platform/paths.js';
import { runtimeSocketDirCandidates } from '../platform/runtime-sockets.js';

/**
 * The path context for a dispatcher's OWN runtime. Every method is keyed by the
 * runtime id the launcher passes as `identity.runtime_id` (the dispatcher id):
 * state files under `<stateRoot>/<id>/`, logs under the central tree, spill in
 * the dispatcher's cache, sockets in the preference-ordered volatile dirs.
 */
export const dispatcherHostPaths: AgentRuntimePathContext = {
  dispatcherDir,
  logsDir: logsRoot,
  completionSpillDir: dispatcherCompletionSpillDir,
  runtimeSocketDirs: () => runtimeSocketDirCandidates(),
};

/**
 * Build the path context for a teammate/team-member runtime. The state runtime
 * dir and completion spill stay grouped under the operator dispatcher (so a
 * teammate's `mcp.json` lands in `<operator>/teammate/runtime/<name>/` and its
 * spill in the operator's cache), independent of the composite runtime id the
 * launcher assigns. Logs and sockets share the host-wide roots.
 *
 * @param operatorDispatcherId the dispatcher that owns the teammate
 * @param runtimeName the teammate's runtime-identity name
 *   (`runtimeIdentityName(identity)` — `team_id.name` for a Team member, the
 *   bare name otherwise); the value the operator-nested dirs are keyed by.
 */
export function teammateHostPaths(
  operatorDispatcherId: string,
  runtimeName: string,
): AgentRuntimePathContext {
  return {
    dispatcherDir: () =>
      dispatcherTeamMateRuntimeDir(operatorDispatcherId, runtimeName),
    logsDir: logsRoot,
    completionSpillDir: () => dispatcherCompletionSpillDir(operatorDispatcherId),
    runtimeSocketDirs: () => runtimeSocketDirCandidates(),
  };
}

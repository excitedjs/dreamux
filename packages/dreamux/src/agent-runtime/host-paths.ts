/**
 * Host implementations of the neutral `AgentRuntimePathContext`
 * (`@excitedjs/dreamux-types`). The Dreamux host owns where a runtime's
 * artifacts land — the global cache root, the central log tree, and the
 * preference-ordered volatile-socket dirs — and exposes them through this neutral
 * context so a provider composes its OWN subpaths without naming any host
 * directory (issue #209 cleanup).
 *
 * These are provider-NEUTRAL: cache scratch is global and logs are composed by
 * the runtime as `<logsDir()>/<engine>/<runtime_id>.log`, so the host no longer
 * branches on role or runtime ref to pick provider paths.
 */
import type { AgentRuntimePathContext } from '@excitedjs/dreamux-types';

import {
  cacheRoot,
  logsRoot,
} from '../platform/paths.js';
import { runtimeSocketDirCandidates } from '../platform/runtime-sockets.js';

export const hostRuntimePaths: AgentRuntimePathContext = {
  cacheDir: cacheRoot,
  logsDir: logsRoot,
  runtimeSocketDirs: () => runtimeSocketDirCandidates(),
};

export const dispatcherHostPaths = hostRuntimePaths;

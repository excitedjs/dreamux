import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';

import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';

import type { AntigravityConfig } from './config.js';

export interface AntigravityRuntimeOptions {
  /** Provider-owned process-level native log path. */
  nativeLogPath: string;
  /** Optional provider-cache directory passed to agy with --add-dir. */
  skillAddDir: string | null;
}

export function antigravityRuntimeKey(
  context: AgentRuntimeCreateContext<AntigravityConfig>,
): string {
  const digest = createHash('sha256')
    .update(context.paths.cacheDir())
    .update('\0')
    .update(context.identity.runtimeId)
    .digest('hex')
    .slice(0, 24);
  return `dreamux-${digest}`;
}

export function antigravityNativeLogPath(
  context: AgentRuntimeCreateContext<AntigravityConfig>,
): string {
  return join(
    context.paths.logsDir(),
    'antigravity',
    `${antigravityRuntimeKey(context)}-${randomUUID()}.log`,
  );
}

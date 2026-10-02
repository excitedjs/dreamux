import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { isAbsolute } from 'node:path';

import type { CodexWsClient } from './rpc.js';

export async function applyCodexSkillExtraRoots(input: {
  client: CodexWsClient;
  sources: readonly AgentRuntimeSkillSource[];
  logger: DreamuxLogger;
}): Promise<void> {
  if (input.sources.length === 0) return;
  assertAbsoluteSkillRootPaths(input.sources);
  const extraRoots = [...new Set(input.sources.map((source) => source.path))];
  if (extraRoots.length === 0) return;
  try {
    await input.client.request('skills/extraRoots/set', { extraRoots });
  } catch (err) {
    if (isUnsupportedRpcMethodError(err)) {
      input.logger.warn(
        { extra_root_count: extraRoots.length, err },
        'skills/extraRoots/set unsupported by this app-server; continuing skill-blind',
      );
      return;
    }
    throw err;
  }
  input.logger.info(
    { extra_roots: extraRoots, extra_root_count: extraRoots.length },
    'applied skill extra roots',
  );
}

function assertAbsoluteSkillRootPaths(
  sources: readonly AgentRuntimeSkillSource[],
): void {
  for (const source of sources) {
    if (!isAbsolute(source.path)) {
      throw new Error(
        `skill source ${JSON.stringify(source.name)} path must be absolute`,
      );
    }
  }
}

/**
 * Classify an RPC rejection as a capability/version gap, not a genuine failure
 * of an existing method. The rpc layer drops JSON-RPC error codes, so this must
 * stay message-based and deliberately narrow.
 */
export function isUnsupportedRpcMethodError(err: unknown): boolean {
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    message.includes('unknown variant') ||
    message.includes('method not found') ||
    message.includes('unknown method') ||
    message.includes('no such method') ||
    message.includes('unsupported method')
  );
}

import { dirname } from 'node:path';

import type {
  AgentRuntimeSkillSource,
} from '@excitedjs/dreamux-types';

import type { CodexWsClient } from './rpc.js';

const CODEX_SKILL_DIR_LAYOUT = 'skill-dir';

export async function applyCodexSkillExtraRoots(input: {
  client: CodexWsClient;
  sources: readonly AgentRuntimeSkillSource[];
  log: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}): Promise<void> {
  if (input.sources.length === 0) return;
  const extraRoots = [
    ...new Set(
      input.sources
        .filter((source) => source.layout === CODEX_SKILL_DIR_LAYOUT)
        .map((source) => dirname(source.path)),
    ),
  ];
  if (extraRoots.length === 0) return;
  try {
    await input.client.request('skills/extraRoots/set', { extraRoots });
  } catch (err) {
    if (isUnsupportedRpcMethodError(err)) {
      input.log(
        'warn',
        `skills/extraRoots/set unsupported by this app-server; continuing skill-blind (${extraRoots.length} extra root(s) not applied)`,
        err,
      );
      return;
    }
    throw err;
  }
  input.log(
    'info',
    `applied ${extraRoots.length} skill extra root(s): ${extraRoots.join(', ')}`,
  );
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

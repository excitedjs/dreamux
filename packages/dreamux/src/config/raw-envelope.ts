import {
  describeType,
  isPlainObject,
  rejectUnknownKeys,
} from '@excitedjs/dreamux-utils';

export interface ConfigRawEnvelope {
  agents: unknown[] | undefined;
  dispatchers: unknown[] | undefined;
}

export function validateConfigRawEnvelope(
  raw: unknown,
  file: string,
): ConfigRawEnvelope {
  if (!isPlainObject(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }
  rejectTopLevelCodex(raw, file);
  rejectUnknownKeys(raw, new Set(['agents', 'dispatchers']), file, '');

  const agents = raw['agents'];
  if (agents !== undefined && !Array.isArray(agents)) {
    throw new Error(
      `dreamux config error in ${file}: agents must be an array (got ${describeType(agents)}).\n` +
        'Declare named runtimes as agents[] entries, each with an id, a provider ' +
        '(for example "builtin:<id>" or "npm:<package>"), and a provider-owned config block.',
    );
  }

  const dispatchers = raw['dispatchers'];
  if (dispatchers !== undefined && !Array.isArray(dispatchers)) {
    throw new Error(
      `dreamux config error in ${file}: dispatchers must be an array (got ${describeType(dispatchers)})`,
    );
  }

  return {
    agents,
    dispatchers,
  };
}

function rejectTopLevelCodex(raw: Record<string, unknown>, file: string): void {
  if (!('codex' in raw)) return;
  throw new Error(
    `dreamux config error in ${file}: a top-level "codex" block is no longer ` +
      'supported. Declare a named agent under agents[] with the selected runtime ' +
      'provider and a provider-owned config block, then reference it from each ' +
      'dispatcher via dispatchers[].agentRuntime.',
  );
}

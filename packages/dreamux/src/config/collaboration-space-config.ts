import {
  describeType,
  isPlainObject,
  readOptionalString,
  rejectUnknownKeys,
  requireNonEmptyString,
} from '@excitedjs/dreamux-utils';

import {
  expandHome,
  readOptionalBoolean,
} from './config-helpers.js';

export interface DispatcherChannelCollaborationSpaceConfig {
  defaultBinding: {
    enabled: boolean;
    repo: null | {
      cwd: string;
      baseRef: string | null;
    };
    identity: string | null;
  };
}

export function defaultChannelCollaborationSpaceConfig(): DispatcherChannelCollaborationSpaceConfig {
  return {
    defaultBinding: {
      enabled: false,
      repo: null,
      identity: null,
    },
  };
}

export function readChannelCollaborationSpace(
  raw: unknown,
  file: string,
  prefix: string,
): DispatcherChannelCollaborationSpaceConfig {
  if (raw === undefined) return defaultChannelCollaborationSpaceConfig();
  if (!isPlainObject(raw)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix.slice(0, -1)} must be an object ` +
        `(got ${describeType(raw)})`,
    );
  }
  rejectUnknownKeys(raw, new Set(['defaultBinding']), file, prefix);
  const rawDefault = raw['defaultBinding'];
  if (rawDefault === undefined) return defaultChannelCollaborationSpaceConfig();
  if (!isPlainObject(rawDefault)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix}defaultBinding must be an object ` +
        `(got ${describeType(rawDefault)})`,
    );
  }
  const bindingPrefix = `${prefix}defaultBinding.`;
  rejectUnknownKeys(
    rawDefault,
    new Set(['enabled', 'repo', 'identity']),
    file,
    bindingPrefix,
  );
  const repo = readDefaultBindingRepo(rawDefault['repo'], file, `${bindingPrefix}repo.`);
  const identity = readOptionalString(rawDefault, 'identity', file, bindingPrefix);
  if (identity !== null && identity.trim() === '') {
    throw new Error(
      `dreamux config error in ${file}: ${bindingPrefix}identity must be non-empty`,
    );
  }
  return {
    defaultBinding: {
      enabled: readOptionalBoolean(rawDefault, 'enabled', false, file, bindingPrefix),
      repo,
      identity,
    },
  };
}

export function stringifyChannelCollaborationSpace(
  config: DispatcherChannelCollaborationSpaceConfig,
): Record<string, unknown> {
  const binding = config.defaultBinding;
  return {
    defaultBinding: {
      enabled: binding.enabled,
      ...(binding.repo !== null
        ? {
            repo: {
              cwd: binding.repo.cwd,
              ...(binding.repo.baseRef !== null
                ? { baseRef: binding.repo.baseRef }
                : {}),
            },
          }
        : {}),
      ...(binding.identity !== null ? { identity: binding.identity } : {}),
    },
  };
}

function readDefaultBindingRepo(
  raw: unknown,
  file: string,
  prefix: string,
): DispatcherChannelCollaborationSpaceConfig['defaultBinding']['repo'] {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    throw new Error(
      `dreamux config error in ${file}: ${prefix.slice(0, -1)} must be an object ` +
        `(got ${describeType(raw)})`,
    );
  }
  rejectUnknownKeys(raw, new Set(['cwd', 'baseRef']), file, prefix);
  return {
    cwd: expandHome(requireNonEmptyString(raw, 'cwd', file, prefix)),
    baseRef: readOptionalString(raw, 'baseRef', file, prefix),
  };
}

import { parse as parsePlist, type PlistValue } from 'plist';

import { LAUNCHD_LABEL } from '../onboard/service.js';

export function parseSystemdUnit(content: string): {
  environment: Record<string, string> | null;
  execStart: string[] | null;
} {
  const environment: Record<string, string> = {};
  let execStart: string[] | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('Environment=')) {
      const assignment = line.slice('Environment='.length);
      const eq = assignment.indexOf('=');
      if (eq > 0) {
        environment[assignment.slice(0, eq)] = systemdUnescapeEnv(
          assignment.slice(eq + 1),
        );
      }
    } else if (line.startsWith('ExecStart=')) {
      execStart = splitSystemdCommand(line.slice('ExecStart='.length));
    }
  }
  return {
    environment: Object.keys(environment).length > 0 ? environment : null,
    execStart,
  };
}

function systemdUnescapeEnv(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (value.slice(index, index + 4) === '\\x20') {
      out += ' ';
      index += 3;
      continue;
    }
    const next = value[index + 1];
    if (next === '\\') {
      out += '\\';
      index += 1;
      continue;
    }
    if (next === '"') {
      out += '"';
      index += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function splitSystemdCommand(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current !== '') {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') args.push(current);
  return args;
}

export function parseLaunchdPlist(content: string): {
  environment: Record<string, string> | null;
  execStart: string[] | null;
} {
  let parsed: PlistValue;
  try {
    parsed = parsePlist(content);
  } catch {
    return { environment: null, execStart: null };
  }
  if (!isPlistRecord(parsed)) {
    return { environment: null, execStart: null };
  }
  return {
    environment: parseLaunchdEnvironment(parsed['EnvironmentVariables']),
    execStart: parseLaunchdProgramArguments(parsed['ProgramArguments']),
  };
}

function parseLaunchdEnvironment(
  value: PlistValue | undefined,
): Record<string, string> | null {
  if (!isPlistRecord(value)) return null;
  const environment: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') environment[key] = raw;
  }
  return Object.keys(environment).length > 0 ? environment : null;
}

function parseLaunchdProgramArguments(
  value: PlistValue | undefined,
): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is string => typeof item === 'string')) {
    return null;
  }
  return value.length > 0 ? value : null;
}

function isPlistRecord(
  value: PlistValue | undefined,
): value is Record<string, PlistValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function launchdTarget(uid?: number): string {
  const actualUid = uid ?? process.getuid?.();
  if (actualUid === undefined) {
    throw new Error('launchd user service diagnostics require a numeric uid');
  }
  return `gui/${actualUid}/${LAUNCHD_LABEL}`;
}

export function parseLaunchdPid(raw: string): number | null {
  const match = raw.match(/\bpid = (\d+)/);
  if (match === null) return null;
  return parsePositiveInt(match[1]);
}

export function parseLaunchdDetail(raw: string): string | null {
  const state = raw.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
  const reason = raw.match(/\breason = ([^\n]+)/)?.[1]?.trim();
  return [state, reason]
    .filter((value) => value !== undefined && value !== '')
    .join(', ') || null;
}

export function parseSystemdProperties(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

export function systemdDetail(props: Record<string, string>): string | null {
  const parts = [
    props['LoadState'],
    props['ActiveState'],
    props['SubState'],
    props['Result'] !== undefined && props['Result'] !== 'success'
      ? `result=${props['Result']}`
      : undefined,
  ].filter((part) => part !== undefined && part !== '');
  return parts.join(', ') || null;
}

export function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

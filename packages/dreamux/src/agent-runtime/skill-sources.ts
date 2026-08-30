import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { ValidationError, errorMessage } from '../command/errors.js';
import type { CommandPayload } from '../command/payload.js';

/** Parse the runtime-neutral skill-source shape at host-owned trust boundaries. */
export function parseAgentRuntimeSkillSources(
  value: unknown,
  label: string,
): AgentRuntimeSkillSource[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const path = nonBlankString(record['path'], `${label}[${index}].path`);
    if (!isAbsolute(path)) {
      throw new Error(`${label}[${index}].path must be an absolute path`);
    }
    return {
      name: nonBlankString(record['name'], `${label}[${index}].name`),
      path,
      source: nonBlankString(record['source'], `${label}[${index}].source`),
    };
  });
}

export interface NormalizeAgentRuntimeSkillSourcesOptions {
  label: string;
  /**
   * Required roots are owned by core (for example a TeamLeader role root). They
   * are not returned, but their canonical roots and child skill names fence the
   * caller-provided roots so custom roots cannot replace role-critical skills.
   */
  requiredSources?: readonly AgentRuntimeSkillSource[];
}

/**
 * Normalize caller-provided skill roots into a stable provider-neutral shape:
 * paths are existing readable directories, stored as canonical realpaths, root
 * duplicates are removed, and direct child skill names are globally unique.
 */
export async function normalizeAgentRuntimeSkillSources(
  sources: readonly AgentRuntimeSkillSource[],
  opts: NormalizeAgentRuntimeSkillSourcesOptions,
): Promise<AgentRuntimeSkillSource[]> {
  const seenRoots = new Set<string>();
  const seenSkillNames = new Map<string, string>();

  for (const source of opts.requiredSources ?? []) {
    const root = await canonicalSkillRoot(source, opts.label, 'required source');
    seenRoots.add(root.path);
    for (const skillName of root.skillNames) {
      seenSkillNames.set(skillName, `required source ${JSON.stringify(source.name)}`);
    }
  }

  const normalized: AgentRuntimeSkillSource[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    const itemLabel = `${opts.label}[${index}]`;
    const root = await canonicalSkillRoot(source, itemLabel, 'path');
    if (seenRoots.has(root.path)) continue;
    for (const skillName of root.skillNames) {
      const previous = seenSkillNames.get(skillName);
      if (previous !== undefined) {
        throw new Error(
          `${itemLabel}.path contains skill ${JSON.stringify(skillName)} ` +
            `which conflicts with ${previous}`,
        );
      }
    }
    seenRoots.add(root.path);
    for (const skillName of root.skillNames) {
      seenSkillNames.set(skillName, `${itemLabel}.path`);
    }
    normalized.push({ ...source, path: root.path });
  }
  return normalized;
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

async function canonicalSkillRoot(
  source: AgentRuntimeSkillSource,
  label: string,
  field: string,
): Promise<{ path: string; skillNames: string[] }> {
  if (!isAbsolute(source.path)) {
    throw new Error(`${label}.${field} must be an absolute path`);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(source.path);
  } catch (err) {
    throw new Error(
      `${label}.${field} must be an existing readable directory: ${messageOf(err)}`,
    );
  }
  let skillNames: string[];
  try {
    const entries = await readdir(canonicalPath, {
      encoding: 'utf8',
      withFileTypes: true,
    });
    skillNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    throw new Error(
      `${label}.${field} must be an existing readable directory: ${messageOf(err)}`,
    );
  }
  return {
    path: canonicalPath,
    skillNames,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse supplied skill sources without touching the filesystem. Normalization
 * against the bundled roots is an `execute`-time step; see
 * {@link normalizeSkillSources}.
 */
export function optionalParsedSkillSources(
  params: CommandPayload,
): readonly AgentRuntimeSkillSource[] | null {
  if (params['skill_sources'] === undefined) return null;
  try {
    return parseAgentRuntimeSkillSources(
      params['skill_sources'],
      "param 'skill_sources'",
    );
  } catch (err) {
    throw new ValidationError(errorMessage(err));
  }
}

/** Resolve parsed skill sources, adding the owner's mandatory roots. */
export async function normalizeSkillSources(
  parsed: readonly AgentRuntimeSkillSource[] | null,
  options: { requiredSources?: readonly AgentRuntimeSkillSource[] } = {},
): Promise<readonly AgentRuntimeSkillSource[] | null> {
  if (parsed === null) return null;
  try {
    return await normalizeAgentRuntimeSkillSources(parsed, {
      label: "param 'skill_sources'",
      ...(options.requiredSources !== undefined
        ? { requiredSources: options.requiredSources }
        : {}),
    });
  } catch (err) {
    throw new ValidationError(errorMessage(err));
  }
}

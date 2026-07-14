import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

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
    return {
      name: nonBlankString(record['name'], `${label}[${index}].name`),
      path: nonBlankString(record['path'], `${label}[${index}].path`),
      source: nonBlankString(record['source'], `${label}[${index}].source`),
    };
  });
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Every input a model can fill on a Dreamux-owned MCP tool says what it is for.
 *
 * Both engines defer MCP tool definitions: the model sees a tool name, loads
 * the definition, and from that point the tool description and the property
 * descriptions are the whole manual. This walks the `teammate`, `team`, and
 * `cron` catalogs as each caller sees them — nested objects such as `repo`
 * included — and fails on any input property that states only its type.
 *
 * The negative gates cover the other half of the same move, matching stable
 * names rather than sentences: the Dispatcher prompts no longer send the model
 * to `dispatcher-workflow` before tool work, and neither role skill's
 * frontmatter description asks to be loaded before using a tool.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bundledDispatcherSkillRoot,
  bundledTeamLeaderSkillRoot,
} from '../src/platform/paths.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from '../src/service/dispatcher-service/base-prompt.js';
import { createCronMcpDelegate } from '../src/service/scheduler/mcp-delegate.js';
import { createTeamMcpDelegate } from '../src/service/team-collection/mcp-delegate.js';
import { teammateToolDescriptors } from '../src/service/teammate-collection/mcp-tool-descriptors.js';

/** What the walk reads out of an advertised tool, which is otherwise opaque. */
interface AdvertisedTool {
  readonly name: string;
  readonly inputSchema: unknown;
}

/**
 * `describe()` answers from the caller binding and the descriptors alone, so a
 * catalog needs no live Dispatcher or scheduler behind it.
 */
const CATALOGS: Record<string, readonly unknown[]> = {
  'teammate (dispatcher)': teammateToolDescriptors('dispatcher'),
  'teammate (team_leader)': teammateToolDescriptors('team_leader'),
  'team (dispatcher)': createTeamMcpDelegate({
    dispatcher: {} as never,
    caller: { kind: 'dispatcher' },
  })
    .describe()
    .tools,
  'team (team_leader)': createTeamMcpDelegate({
    dispatcher: {} as never,
    caller: { kind: 'team_leader', teamId: 'team-x', leaderName: 'leader-x' },
  })
    .describe()
    .tools,
  cron: createCronMcpDelegate({
    scheduler: async () => {
      throw new Error('unused');
    },
  })
    .describe()
    .tools,
};

const SKILL_DESCRIPTION_SOURCES: Record<string, string> = {
  'dispatcher-workflow': join(
    bundledDispatcherSkillRoot(),
    'dispatcher-workflow',
    'SKILL.md',
  ),
  'team-workflow': join(bundledTeamLeaderSkillRoot(), 'team-workflow', 'SKILL.md'),
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every property of an object schema by dotted path, descending into nested
 * object schemas that declare their own properties.
 */
function inputProperties(
  schema: unknown,
  prefix: string,
): [string, unknown][] {
  if (!isJsonObject(schema) || !isJsonObject(schema['properties'])) {
    return [];
  }
  return Object.entries(schema['properties']).flatMap(([name, property]) => [
    [`${prefix}${name}`, property] as [string, unknown],
    ...inputProperties(property, `${prefix}${name}.`),
  ]);
}

function frontmatterDescription(skillMarkdownPath: string): string {
  const frontmatter =
    /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(skillMarkdownPath, 'utf8'))?.[1] ??
    '';
  return (
    frontmatter
      .split('\n')
      .find((line) => line.startsWith('description:')) ?? ''
  );
}

describe('Dreamux MCP tool descriptions', () => {
  for (const [catalog, tools] of Object.entries(CATALOGS)) {
    it(`describes every input property in the ${catalog} catalog`, () => {
      expect(tools.length).toBeGreaterThan(0);
      for (const advertised of tools) {
        const { name, inputSchema } = advertised as AdvertisedTool;
        for (const [path, property] of inputProperties(inputSchema, '')) {
          const description = isJsonObject(property)
            ? property['description']
            : undefined;
          expect(
            typeof description === 'string' && description.trim().length > 0,
            `${catalog} tool "${name}" input property "${path}" has no description`,
          ).toBe(true);
        }
      }
    });
  }
});

describe('role guidance is not a precondition for tool calls', () => {
  it('keeps the Dispatcher prompts from routing tool work through a skill', () => {
    for (const [prompt, text] of Object.entries({
      DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
      DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
    })) {
      expect(
        text,
        `${prompt} still sends the model to dispatcher-workflow`,
      ).not.toContain('dispatcher-workflow');
    }
  });

  it('keeps a load mandate out of the role skill descriptions', () => {
    for (const [skill, source] of Object.entries(SKILL_DESCRIPTION_SOURCES)) {
      const description = frontmatterDescription(source);
      expect(
        description,
        `${skill} SKILL.md has no frontmatter description line`,
      ).not.toBe('');
      expect(
        description,
        `${skill} SKILL.md description still mandates loading before tool use`,
      ).not.toContain('before using');
    }
  });
});

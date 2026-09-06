/**
 * Every input a model can fill on a Dreamux-owned MCP tool says what it is for.
 *
 * Both engines defer MCP tool definitions: the model sees a tool name, loads
 * the definition, and from that point the tool description and the property
 * descriptions are the whole manual. This walks the `teammate`, `team`, and
 * `cron` catalogs as each caller sees them — nested objects such as `repo`
 * included — and fails on any input property that states only its type.
 *
 * The other gates cover the rest of the same move, matching stable names and
 * Dreamux-owned sentences rather than prose: the Dispatcher prompts no longer
 * send the model to `dispatcher-workflow` before tool work and no longer carry
 * a rule another surface now owns, while keeping the one skill trigger the
 * role does own; no bundled skill's frontmatter description asks to be loaded
 * before using a tool; and every hand-off tool states in its own description
 * that the completion is pushed back later, which on Claude Code is the only
 * place the model can read it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bundledDispatcherSkillRoot,
  bundledSharedSkillRoot,
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
  readonly description: string;
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
  teamwork: join(bundledTeamLeaderSkillRoot(), 'teamwork', 'SKILL.md'),
  'dynamic-workflow': join(
    bundledSharedSkillRoot(),
    'dynamic-workflow',
    'SKILL.md',
  ),
};

/** The two role prompts Dreamux writes for a Dispatcher, by export name. */
const DISPATCHER_PROMPTS: Record<string, string> = {
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
};

/**
 * Rules that used to live in a Dispatcher prompt and now have a single owner
 * elsewhere: the no-polling rule and the pushed completion belong to the
 * dispatch-result reminders and the hand-off descriptions, reaching the user
 * belongs to the channel's own reminder, and loading a tool definition is the
 * engine's own mechanism. Fragments, not sentences, so a reworded comeback is
 * still caught.
 */
const RULES_OWNED_ELSEWHERE = [
  'do not poll',
  'reply tool',
  'public artifacts',
  'Load a tool',
];

/**
 * What a hand-off tool must say about the result the caller will never see in
 * its own return value. The dispatch-result reminder carries the same fact,
 * but Claude Code drops an MCP result's text next to its structured content,
 * so there the description is the only carrier.
 */
const PUSHED_COMPLETION =
  'Returns a receipt at once; the completion is pushed later as a new message.';

const HAND_OFF_SENTENCES: readonly [string, string, string][] = [
  ['teammate (dispatcher)', 'spawn', PUSHED_COMPLETION],
  ['teammate (dispatcher)', 'send', PUSHED_COMPLETION],
  ['teammate (team_leader)', 'spawn', PUSHED_COMPLETION],
  ['teammate (team_leader)', 'send', PUSHED_COMPLETION],
  [
    'team (dispatcher)',
    'create',
    'With `prompt`, returns a receipt at once and the TeamLeader\'s completion ' +
      'is pushed later as a new message; without it, the Team is created and ' +
      'nothing is submitted.',
  ],
  ['team (dispatcher)', 'send', PUSHED_COMPLETION],
  [
    'teammate (dispatcher)',
    'workflow_run',
    'Dreamux pushes one terminal completion when the run finishes.',
  ],
];

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
    for (const [prompt, text] of Object.entries(DISPATCHER_PROMPTS)) {
      expect(
        text,
        `${prompt} still sends the model to dispatcher-workflow`,
      ).not.toContain('dispatcher-workflow');
    }
  });

  it('keeps a load mandate out of the bundled skill descriptions', () => {
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

describe('what only the Dispatcher role prompts still carry', () => {
  it('triggers the one skill the role itself owns', () => {
    for (const [prompt, text] of Object.entries(DISPATCHER_PROMPTS)) {
      expect(
        text,
        `${prompt} no longer triggers dreamux-maintenance`,
      ).toContain('Load `dreamux-maintenance`');
    }
  });

  it('states no rule another surface now owns', () => {
    for (const [prompt, text] of Object.entries(DISPATCHER_PROMPTS)) {
      for (const fragment of RULES_OWNED_ELSEWHERE) {
        expect(text, `${prompt} states "${fragment}" again`).not.toContain(
          fragment,
        );
      }
    }
  });
});

describe('a hand-off says the completion comes back later', () => {
  for (const [catalog, name, sentence] of HAND_OFF_SENTENCES) {
    it(`states it on ${catalog} "${name}"`, () => {
      const tool = (CATALOGS[catalog] as readonly AdvertisedTool[] | undefined)
        ?.find((advertised) => advertised.name === name);
      expect(tool, `${catalog} advertises no tool "${name}"`).toBeDefined();
      expect(tool?.description).toContain(sentence);
    });
  }
});

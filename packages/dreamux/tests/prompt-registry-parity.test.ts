import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cronTools } from '../src/mcp/cron-mcp.js';
import { teamTools } from '../src/mcp/team-mcp.js';
import { teammateTools } from '../src/mcp/teammate-mcp.js';
import { bundledSkillDir, type BundledSkillName } from '../src/platform/paths.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from '../src/service/dispatcher-service/base-prompt.js';
import { dispatcherMcpServerDescriptors } from '../src/service/dispatcher-service/mcp-descriptors.js';

interface RegisteredTool {
  server: string;
  name: string;
}

const PROMPT_DECLARED_REMOVED_VERBS = [
  'resume',
  'ctx',
  'history_events',
] as const;

function registeredDreamuxMcpTools(): RegisteredTool[] {
  return [
    ...toolNames('teammate', teammateTools('dispatcher')),
    ...toolNames('team', teamTools()),
    ...toolNames('cron', cronTools()),
  ];
}

function registeredTeamLeaderMcpTools(): RegisteredTool[] {
  return [
    ...toolNames('teammate', teammateTools('team_leader')),
    ...toolNames('team', teamTools('team_leader')),
    ...toolNames('cron', cronTools()),
  ];
}

function toolNames(
  server: string,
  tools: Array<Record<string, unknown>>,
): RegisteredTool[] {
  return tools.map((tool) => {
    const name = tool['name'];
    if (typeof name !== 'string' || name === '') {
      throw new Error(`${server} MCP tool has an invalid name: ${JSON.stringify(name)}`);
    }
    return { server, name };
  });
}

function promptMentionsTool(name: string): boolean {
  return textMentionsTool(
    `${DREAMUX_DISPATCHER_BASE_INSTRUCTIONS}\n${DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS}`,
    name,
  );
}

function skillMentionsTool(skillName: BundledSkillName, name: string): boolean {
  return textMentionsTool(readBundledSkill(skillName), name);
}

function readBundledSkill(name: BundledSkillName): string {
  return readFileSync(join(bundledSkillDir(name), 'SKILL.md'), 'utf8');
}

function textMentionsTool(text: string, name: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTools(tools: RegisteredTool[]): string {
  return tools.map((tool) => `${tool.server}.${tool.name}`).join('\n');
}

describe('dispatcher prompt matches registered Dreamux MCP tools', () => {
  it('keeps dispatcher Dreamux MCP server registration aligned with this gate', () => {
    const servers = dispatcherMcpServerDescriptors({
      dispatcherId: 'dispatcher-a',
      channels: new Map(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
    }).map((server) => server.name);

    expect(servers).toEqual(['team', 'teammate', 'cron']);
  });

  it('names every registered dispatcher Dreamux MCP tool in the model-facing prompt', () => {
    const missing = registeredDreamuxMcpTools().filter(
      (tool) => !promptMentionsTool(tool.name),
    );

    expect(
      missing,
      [
        'Dispatcher prompt/registry parity drift: registered Dreamux MCP tools must be named as whole words in DREAMUX_DISPATCHER_BASE_INSTRUCTIONS or DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS.',
        `Missing tool(s):\n${formatTools(missing)}`,
      ].join('\n'),
    ).toEqual([]);
  });

  it('names dispatcher-visible tools in dispatcher-workflow', () => {
    const missing = registeredDreamuxMcpTools().filter(
      (tool) => !skillMentionsTool('dispatcher-workflow', tool.name),
    );

    expect(
      missing,
      [
        'Dispatcher skill/registry parity drift: dispatcher-workflow must name every dispatcher-visible Dreamux MCP tool as a whole word.',
        `Missing tool(s):\n${formatTools(missing)}`,
      ].join('\n'),
    ).toEqual([]);
  });

  it('names TeamLeader-visible tools in team-workflow', () => {
    const missing = registeredTeamLeaderMcpTools().filter(
      (tool) => !skillMentionsTool('team-workflow', tool.name),
    );

    expect(
      missing,
      [
        'TeamLeader skill/registry parity drift: team-workflow must name every TeamLeader-visible Dreamux MCP tool as a whole word.',
        `Missing tool(s):\n${formatTools(missing)}`,
      ].join('\n'),
    ).toEqual([]);
  });

  it('mentions Team MCP send in the Team MCP instructions explicitly', () => {
    expect(DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS).toMatch(
      /Team MCP[\s\S]*create, send, list, status, history, dissolve, bind_channel, and transfer_back/,
    );
    expect(DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS).toMatch(
      /send\(\{ team_name, prompt, intent\? \}\) submits a follow-up turn to that Team's TeamLeader only/,
    );
  });

  it('keeps prompt-declared removed verbs out of the registered dispatcher tools', () => {
    const registered = new Set(registeredDreamuxMcpTools().map((tool) => tool.name));
    const reintroduced = PROMPT_DECLARED_REMOVED_VERBS.filter((name) =>
      registered.has(name),
    );

    expect(
      reintroduced,
      [
        'Dispatcher prompt removed-verb honesty drift: the prompt declares these verbs removed, so they must not be registered dispatcher Dreamux MCP tools.',
        `Reintroduced verb(s): ${reintroduced.join(', ')}`,
      ].join('\n'),
    ).toEqual([]);
  });
});

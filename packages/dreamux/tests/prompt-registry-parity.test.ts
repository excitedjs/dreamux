import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collaborationSpaceTools } from '../src/mcp/collaboration-space-mcp.js';
import { cronTools } from '../src/mcp/cron-mcp.js';
import { teamTools } from '../src/mcp/team-mcp.js';
import { teammateTools } from '../src/mcp/teammate-mcp.js';
import {
  bundledDispatcherSkillRoot,
  bundledSharedSkillRoot,
  bundledTeamLeaderSkillRoot,
  type BundledSkillName,
} from '../src/platform/paths.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from '../src/service/dispatcher-service/base-prompt.js';
import { dispatcherMcpServerDescriptors } from '../src/service/dispatcher-service/mcp-descriptors.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';

interface RegisteredTool {
  server: string;
  name: string;
}

function registeredDreamuxMcpTools(): RegisteredTool[] {
  return [
    ...toolNames('collaboration_space', collaborationSpaceTools()),
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

function skillMentionsTool(skillName: BundledSkillName, name: string): boolean {
  return textMentionsTool(readBundledSkill(skillName), name);
}

const SKILL_ROOT_BY_NAME = {
  'dispatcher-workflow': bundledDispatcherSkillRoot(),
  'dreamux-maintenance': bundledDispatcherSkillRoot(),
  'team-workflow': bundledTeamLeaderSkillRoot(),
  'workflow': bundledSharedSkillRoot(),
} satisfies Record<BundledSkillName, string>;

const SHARED_WORKFLOW_TOOLS = new Set([
  'workflow_run',
  'workflow_status',
  'workflow_stop',
  'workflow_list',
]);

function assignedSkillMentionsTool(
  roleSkill: 'dispatcher-workflow' | 'team-workflow',
  name: string,
): boolean {
  return skillMentionsTool(SHARED_WORKFLOW_TOOLS.has(name) ? 'workflow' : roleSkill, name);
}

function readBundledSkill(name: BundledSkillName): string {
  return readFileSync(join(SKILL_ROOT_BY_NAME[name], name, 'SKILL.md'), 'utf8');
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
      channels: [],
      channelProviders: new ChannelProviderCatalog({
        registry: createBuiltinProviderRegistry(),
      }),
      adminSocketPath: '/tmp/dreamux-admin.sock',
    }).map((server) => server.name);

    expect(servers).toEqual(['collaboration_space', 'team', 'teammate', 'cron']);
  });

  it('names dispatcher-visible tools in dispatcher-workflow', () => {
    const missing = registeredDreamuxMcpTools().filter(
      (tool) => !assignedSkillMentionsTool('dispatcher-workflow', tool.name),
    );

    expect(
      missing,
      [
        'Dispatcher skill/registry parity drift: assigned bundled skills must name every dispatcher-visible Dreamux MCP tool as a whole word.',
        `Missing tool(s):\n${formatTools(missing)}`,
      ].join('\n'),
    ).toEqual([]);
  });

  it('names TeamLeader-visible tools in team-workflow', () => {
    const missing = registeredTeamLeaderMcpTools().filter(
      (tool) => !assignedSkillMentionsTool('team-workflow', tool.name),
    );

    expect(
      missing,
      [
        'TeamLeader skill/registry parity drift: assigned bundled skills must name every TeamLeader-visible Dreamux MCP tool as a whole word.',
        `Missing tool(s):\n${formatTools(missing)}`,
      ].join('\n'),
    ).toEqual([]);
  });

  it('routes dispatcher prompts to skills instead of enumerating MCP schemas', () => {
    const basePrompt = DREAMUX_DISPATCHER_BASE_INSTRUCTIONS;
    const appendPrompt = DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS;
    const allDispatcherPrompts = `${basePrompt}\n${appendPrompt}`;

    expect(basePrompt).toContain('Load `dispatcher-workflow` before');
    expect(basePrompt).toContain('Load `dreamux-maintenance` before');
    expect(basePrompt).toMatch(/warm, curious, collaborative/i);
    expect(basePrompt).toMatch(/Do not read or edit repository code files/i);
    expect(basePrompt).toMatch(/delegat\w*[\s\S]{0,80}TeamMate or Team MCP tools/i);
    expect(basePrompt).toMatch(/simple request[\s\S]{0,120}terminal command/i);
    expect(basePrompt).toMatch(/meaningful progress[\s\S]{0,120}key task milestones/i);
    expect(basePrompt).toMatch(/do not poll `last`[\s\S]{0,120}pushes task completions/i);
    expect(basePrompt).toMatch(/task was submitted successfully[\s\S]{0,160}end the turn naturally/i);
    expect(appendPrompt).toContain('Load `dispatcher-workflow` before');
    expect(appendPrompt).toContain('Load `dreamux-maintenance` before');
    expect(appendPrompt).toMatch(/Do not read or edit repository code files/i);
    expect(appendPrompt).toMatch(/do not poll `last`[\s\S]{0,120}pushes task results/i);
    expect(appendPrompt).toMatch(/task was submitted successfully[\s\S]{0,160}end the turn naturally/i);
    expect(allDispatcherPrompts).not.toContain('bind_channel({ team_name, channel_id?, meta })');
    expect(allDispatcherPrompts).not.toContain('create, send, list, status, history, dissolve');
    expect(allDispatcherPrompts).not.toContain('ctx and history_events');
    expect(allDispatcherPrompts).not.toContain('legacy TeamMate CLI');
  });
});

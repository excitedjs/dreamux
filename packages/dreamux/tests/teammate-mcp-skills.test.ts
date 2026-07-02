import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bundledSkillDir, type BundledSkillName } from '../src/platform/paths.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from '../src/service/dispatcher-service/base-prompt.js';

const TEAMMATE_MCP_TOOLS = [
  'spawn',
  'send',
  'close',
  'history',
  'list',
  'status',
  'last',
  'get_capabilities',
];

const DISPATCHER_TEAM_MCP_TOOLS = [
  'create',
  'send',
  'list',
  'status',
  'history',
  'dissolve',
  'bind_channel',
  'transfer_back',
];

const CRON_MCP_TOOLS = [
  'cron_create',
  'cron_list',
  'cron_update',
  'cron_delete',
  'cron_run_now',
];

function readBundledSkill(name: BundledSkillName): string {
  return readFileSync(join(bundledSkillDir(name), 'SKILL.md'), 'utf8');
}

describe('role-specific bundled Dreamux skills', () => {
  it('dispatcher-workflow is MCP-only dispatcher orchestration guidance', () => {
    const skill = readBundledSkill('dispatcher-workflow');

    expect(skill).toContain('Use this skill only from a Dreamux Dispatcher');
    expect(skill).toContain('There is no legacy TeamMate CLI fallback');
    expect(skill).toContain('Use the separate `dreamux-maintenance` skill');
    expect(skill).toMatch(/wait for the TeamMate\s+completion/);
    expect(skill).toMatch(/Do not call\s+`status`, `last`, or `history` just because the turn is quiet/);
    expect(skill).not.toContain('Maintenance Notes');
    for (const tool of TEAMMATE_MCP_TOOLS) expect(skill).toContain(tool);
    for (const tool of DISPATCHER_TEAM_MCP_TOOLS) expect(skill).toContain(tool);
    for (const tool of CRON_MCP_TOOLS) expect(skill).toContain(tool);

    expect(skill).not.toContain('tm spawn');
    expect(skill).not.toContain('tm send');
    expect(skill).not.toContain('npm exec --package @excitedjs/tm');
    expect(skill).not.toContain('team-dev-workflow');
    expect(skill).not.toContain('references/');
  });

  it('dreamux-maintenance is Dispatcher-only host operations guidance', () => {
    const skill = readBundledSkill('dreamux-maintenance');

    expect(skill).toContain('Use this skill only from a Dreamux Dispatcher');
    expect(skill).toMatch(/Dreamux\s+server operation/);
    expect(skill).toContain('dreamux doctor');
    expect(skill).toContain('dreamux status');
    expect(skill).toContain('dreamux changelog');
    expect(skill).toContain('dreamux daemon install|uninstall|start|stop|restart');
    expect(skill).toContain('missing replies');
    expect(skill).toContain('old `.codex/skills` symlinks are upgrade leftovers');
    expect(skill).toContain('There is no legacy TeamMate CLI fallback');
    expect(skill).not.toContain('do not invent a separate public daemon command tree');

    expect(skill).not.toContain('tm spawn');
    expect(skill).not.toContain('tm send');
    expect(skill).not.toContain('npm exec --package @excitedjs/tm');
    expect(skill).not.toContain('team-dev-workflow');
    expect(skill).not.toContain('references/');
  });

  it('team-workflow is TeamLeader-only and does not teach dispatcher Team orchestration', () => {
    const skill = readBundledSkill('team-workflow');

    expect(skill).toContain('Use this skill only from a Dreamux TeamLeader');
    expect(skill).toContain('The TeamLeader is not the Dispatcher');
    expect(skill).toContain('The TeamLeader-scoped `team` MCP exposes only `transfer_back`');
    expect(skill).toMatch(/wait for the TeamMate\s+completion/);
    expect(skill).toMatch(/Do not call\s+`status`, `last`, or `history` just because the turn is quiet/);
    for (const tool of TEAMMATE_MCP_TOOLS) expect(skill).toContain(tool);
    for (const tool of CRON_MCP_TOOLS) expect(skill).toContain(tool);
    expect(skill).toContain('transfer_back');

    for (const dispatcherOnlyTool of ['create', 'dissolve', 'bind_channel']) {
      expect(skill).not.toContain(`\`${dispatcherOnlyTool}\``);
    }
    expect(skill).not.toContain('`team.send`');
    expect(skill).not.toContain('targets that TeamLeader');
    expect(skill).not.toContain('bind_channel({');
    expect(skill).not.toContain('tm spawn');
    expect(skill).not.toContain('dreamux-maintenance');
  });

  it('dispatcher prompt loads dispatcher-workflow and no longer advertises tm', () => {
    const prompt = `${DREAMUX_DISPATCHER_BASE_INSTRUCTIONS}\n${DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS}`;

    expect(prompt).toContain('Load the bundled `dispatcher-workflow` skill');
    expect(prompt).toContain('Load the bundled `dreamux-maintenance` skill');
    expect(prompt).toContain('server-hosted TeamMate MCP is the primary interface');
    expect(prompt).toContain('named, semi-resident TeamMate agents');
    for (const tool of TEAMMATE_MCP_TOOLS) expect(prompt).toContain(tool);
    for (const tool of DISPATCHER_TEAM_MCP_TOOLS) expect(prompt).toContain(tool);
    for (const tool of CRON_MCP_TOOLS) expect(prompt).toContain(tool);

    expect(prompt).not.toContain('The tm CLI is the labeled fallback');
    expect(prompt).not.toContain('tm CLI');
    expect(prompt).not.toContain('tm executable');
    expect(prompt).not.toContain('Load the bundled `dispatcher` skill');
    expect(prompt).not.toContain('run_task');
    expect(prompt).not.toContain('execute_task');
    expect(prompt).not.toContain('await_completion');
  });
});

describe('channel binding remains a Team MCP capability', () => {
  it('dispatcher-workflow teaches bind_channel / transfer_back with channel_id + meta', () => {
    const skill = readBundledSkill('dispatcher-workflow');

    expect(skill).toContain('bind_channel');
    expect(skill).toContain('transfer_back');
    expect(skill).toMatch(/meta[\s\S]{0,120}chat_id/);
    expect(skill).toContain('channel_id');
    expect(skill).not.toContain('## Channel MCP (`channel`)');
    expect(skill).not.toContain('mcp.channel');
    expect(skill).not.toContain('list_peers');
  });

  it('append-mode base prompt teaches the Team MCP bind_channel/meta contract', () => {
    const prompt = DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS;

    expect(prompt).toContain('bind_channel({ team_name, channel_id?, meta })');
    expect(prompt).toContain('transfer_back({ channel_id?, meta })');
    expect(prompt).toContain('TeamLeaders receive only their scoped transfer_back projection');
    expect(prompt).toMatch(/meta is \{ chat_id \}/);
    expect(prompt).not.toContain('The channel MCP is the dispatcher-only channel-binding interface');
    expect(prompt).not.toContain('addressed by chat_id');
    expect(prompt).not.toContain('mcp.channel');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const SKILL_ROOT_BY_NAME = {
  'dispatcher-workflow': bundledDispatcherSkillRoot(),
  'dreamux-maintenance': bundledDispatcherSkillRoot(),
  'team-workflow': bundledTeamLeaderSkillRoot(),
  'workflow': bundledSharedSkillRoot(),
} satisfies Record<BundledSkillName, string>;

function readBundledSkill(name: BundledSkillName): string {
  return readFileSync(join(SKILL_ROOT_BY_NAME[name], name, 'SKILL.md'), 'utf8');
}

function frontmatterDescription(skill: string): string {
  return skill.match(/^description:\s*"?(.+?)"?$/m)?.[1] ?? '';
}

describe('role-specific bundled Dreamux skills', () => {
  it('dispatcher-workflow is MCP-only dispatcher orchestration guidance', () => {
    const skill = readBundledSkill('dispatcher-workflow');
    const description = frontmatterDescription(skill);

    expect(description).toMatch(/MCP operation notes/i);
    expect(description).toMatch(/TeamMate|Team|channel|cron/);
    expect(skill).toMatch(/dreamux-maintenance[\s\S]{0,180}(server|host|daemon|missing-reply)/i);
    expect(skill).toMatch(/TeamMate completion/i);
    expect(skill).toMatch(/progress/i);
    expect(skill).toMatch(/milestones/i);
    expect(skill).toMatch(/reply tool/i);
    expect(skill).toMatch(/not channel delivery/i);
    expect(skill).not.toContain('Maintenance Notes');
    for (const tool of TEAMMATE_MCP_TOOLS) expect(skill).toContain(tool);
    for (const tool of DISPATCHER_TEAM_MCP_TOOLS) expect(skill).toContain(tool);
    for (const tool of CRON_MCP_TOOLS) expect(skill).toContain(tool);

    expect(skill).not.toContain('Use this skill only from');
    expect(skill).not.toContain('legacy TeamMate CLI fallback');
    expect(skill).not.toContain('There is no separate resume tool');
    expect(skill).not.toContain('Feishu');
    expect(skill).not.toContain('chat_id');
    expect(skill).not.toContain('list_chat_bots');
    expect(skill).not.toContain('tm spawn');
    expect(skill).not.toContain('tm send');
    expect(skill).not.toContain('npm exec --package @excitedjs/tm');
    expect(skill).not.toContain('team-dev-workflow');
    expect(skill).not.toContain('.codex/skills');
    expect(skill).not.toContain('references/');
  });

  it('dreamux-maintenance is Dispatcher-only host operations guidance', () => {
    const skill = readBundledSkill('dreamux-maintenance');
    const description = frontmatterDescription(skill);

    expect(description).toMatch(/Dreamux host operation notes/i);
    expect(description).toMatch(/serve|daemon|doctor|status|missing replies/);
    expect(skill).toContain('dreamux doctor');
    expect(skill).toContain('dreamux status');
    expect(skill).toContain('dreamux changelog');
    expect(skill).toContain('dreamux daemon install|uninstall|start|stop|restart');
    expect(skill).toContain('missing replies');
    expect(skill).not.toContain('do not invent a separate public daemon command tree');

    expect(skill).not.toContain('Use this skill only from');
    expect(skill).not.toContain('legacy TeamMate CLI fallback');
    expect(skill).not.toContain('There is no separate resume tool');
    expect(skill).not.toContain('old `.codex/skills`');
    expect(skill).not.toContain('Feishu');
    expect(skill).not.toContain('chat_id');
    expect(skill).not.toContain('tm spawn');
    expect(skill).not.toContain('tm send');
    expect(skill).not.toContain('npm exec --package @excitedjs/tm');
    expect(skill).not.toContain('team-dev-workflow');
    expect(skill).not.toContain('references/');
  });

  it('team-workflow is TeamLeader-only and does not teach dispatcher Team orchestration', () => {
    const skill = readBundledSkill('team-workflow');
    const description = frontmatterDescription(skill);

    expect(description).toMatch(/MCP operation notes/i);
    expect(description).toMatch(/TeamMate|channel|cron|binding/);
    expect(skill).toMatch(/`team` MCP exposes only `bind_channel` and `transfer_back`/);
    expect(skill).toMatch(/share the Team\s+workspace/);
    expect(skill).toMatch(/one TeamMate at a time to edit/);
    expect(skill).toMatch(/TeamMate completion/i);
    expect(skill).toMatch(/progress/i);
    expect(skill).toMatch(/milestones/i);
    expect(skill).toMatch(/reply tool/i);
    expect(skill).toMatch(/not channel delivery/i);
    for (const tool of TEAMMATE_MCP_TOOLS) expect(skill).toContain(tool);
    for (const tool of CRON_MCP_TOOLS) expect(skill).toContain(tool);
    expect(skill).toContain('bind_channel');
    expect(skill).toContain('transfer_back');
    expect(skill).toMatch(/unowned channel target/);
    expect(skill).toMatch(/refuses a target already owned/);

    expect(skill).not.toContain('Use this skill only from');
    expect(skill).not.toContain('TeamLeader-scoped');
    expect(skill).not.toContain('legacy TeamMate CLI fallback');
    expect(skill).not.toContain('There is no separate resume tool');
    expect(skill).not.toContain('Feishu');
    expect(skill).not.toContain('chat_id');
    expect(skill).not.toContain('list_chat_bots');
    expect(skill).not.toMatch(/ask the Dispatcher/i);
    expect(skill).not.toMatch(/return(?:s|ing)? .*Dispatcher/i);
    expect(skill).not.toMatch(/Dispatcher .*outcome/i);
    expect(skill).not.toContain('dreamux-maintenance');
    for (const dispatcherOnlyTool of ['create', 'dissolve']) {
      expect(skill).not.toContain(`\`${dispatcherOnlyTool}\``);
    }
    expect(skill).not.toContain('`team.send`');
    expect(skill).not.toContain('targets that TeamLeader');
    expect(skill).toContain('bind_channel({ channel_id?, meta })');
    expect(skill).not.toContain('tm spawn');
  });

  it('workflow documents the shared deterministic orchestration contract', () => {
    const skill = readBundledSkill('workflow');
    const description = frontmatterDescription(skill);

    expect(description).toMatch(/deterministic multi-agent orchestration/i);
    for (const tool of [
      'workflow_run',
      'workflow_status',
      'workflow_stop',
      'workflow_list',
    ]) {
      expect(skill).toContain(tool);
    }
    expect(skill).toContain('export const meta');
    expect(skill).toContain('export default async function run()');
    for (const scriptApi of [
      'agent(',
      'parallel(',
      'pipeline(',
      'phase(',
      'log(',
      'args',
      'schema',
    ]) {
      expect(skill).toContain(scriptApi);
    }
    expect(skill).toMatch(/concurrent prompts read-only|independent edit paths/i);
    expect(skill).toMatch(/concrete TeamMate name[\s\S]{0,100}`send`/i);
    expect(skill).not.toMatch(/auto.?close/i);
    expect(skill).not.toContain('Feishu');
    expect(skill).not.toContain('chat_id');
    expect(skill).not.toContain('process.env');
    expect(skill).not.toContain('require(');
  });

  it('dispatcher prompt routes to skills without embedding repo-development policy', () => {
    const basePrompt = DREAMUX_DISPATCHER_BASE_INSTRUCTIONS;
    const appendPrompt = DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS;
    const allDispatcherPrompts = `${basePrompt}\n${appendPrompt}`;

    expect(basePrompt).toContain('Load `dispatcher-workflow` before');
    expect(basePrompt).toContain('Load `dreamux-maintenance` before');
    expect(basePrompt).toContain('provider-exposed reply tool');
    expect(basePrompt).toContain('MCP tool results as the authority');
    expect(basePrompt).toMatch(/warm, curious, collaborative/i);
    expect(basePrompt).toMatch(/local reads[\s\S]{0,120}parallelize/i);
    expect(basePrompt).toMatch(/simple request[\s\S]{0,120}terminal command/i);
    expect(basePrompt).toMatch(/planning tool/i);
    expect(basePrompt).toMatch(/review mindset/i);
    expect(basePrompt).toMatch(/meaningful progress[\s\S]{0,120}key task milestones/i);
    expect(basePrompt).toMatch(/destructive commands/i);
    expect(basePrompt).toMatch(/unexpected local file changes/i);
    expect(basePrompt).toMatch(/Do not read or edit repository code files/i);
    expect(basePrompt).toMatch(/delegat\w*[\s\S]{0,80}TeamMate or Team MCP tools/i);
    expect(basePrompt).toMatch(/do not poll `last`[\s\S]{0,120}pushes task completions/i);
    expect(basePrompt).toMatch(/task was submitted successfully[\s\S]{0,160}end the turn naturally/i);

    expect(appendPrompt).toContain('Load `dispatcher-workflow` before');
    expect(appendPrompt).toContain('Load `dreamux-maintenance` before');
    expect(appendPrompt).toContain('MCP tool results as the authority');
    expect(appendPrompt).toMatch(/Do not read or edit repository code files/i);
    expect(appendPrompt).toMatch(/delegate repository work to TeamMates or Teams/i);
    expect(appendPrompt).toMatch(/do not poll `last`[\s\S]{0,120}pushes task results/i);
    expect(appendPrompt).toMatch(/task was submitted successfully[\s\S]{0,160}end the turn naturally/i);

    expect(allDispatcherPrompts).not.toContain('The tm CLI is the labeled fallback');
    expect(allDispatcherPrompts).not.toContain('tm CLI');
    expect(allDispatcherPrompts).not.toContain('tm executable');
    expect(allDispatcherPrompts).not.toContain('Load the bundled `dispatcher` skill');
    expect(allDispatcherPrompts).not.toContain('legacy TeamMate CLI');
    expect(allDispatcherPrompts).not.toContain('Feishu');
    expect(allDispatcherPrompts).not.toContain('chat_id');
    expect(allDispatcherPrompts).not.toContain('Phased Work And Review');
    expect(allDispatcherPrompts).not.toContain('Working Style');
    expect(allDispatcherPrompts).not.toContain('apply_patch');
    expect(allDispatcherPrompts).not.toContain('AGENTS.md');
    expect(allDispatcherPrompts).not.toContain('Frontend tasks');
    expect(allDispatcherPrompts).not.toContain('AI slop');
    expect(allDispatcherPrompts).not.toContain('【F:');
    expect(allDispatcherPrompts).not.toContain('named, semi-resident TeamMate agents');
    expect(allDispatcherPrompts).not.toContain('ctx and history_events');
    expect(allDispatcherPrompts).not.toContain('run_task');
    expect(allDispatcherPrompts).not.toContain('execute_task');
    expect(allDispatcherPrompts).not.toContain('await_completion');
  });
});

describe('channel binding remains a Team MCP capability', () => {
  it('dispatcher-workflow teaches bind_channel / transfer_back with channel_id + meta', () => {
    const skill = readBundledSkill('dispatcher-workflow');

    expect(skill).toContain('bind_channel');
    expect(skill).toContain('transfer_back');
    expect(skill).toContain('meta');
    expect(skill).toContain('channel_id');
    expect(skill).not.toContain('chat_id');
    expect(skill).not.toContain('## Channel MCP (`channel`)');
    expect(skill).not.toContain('mcp.channel');
    expect(skill).not.toContain('list_peers');
  });

  it('append-mode prompt delegates Team MCP details to dispatcher-workflow', () => {
    const prompt = DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS;

    expect(prompt).toContain('Load `dispatcher-workflow` before');
    expect(prompt).not.toContain('bind_channel({ team_name, channel_id?, meta })');
    expect(prompt).not.toContain('transfer_back({ channel_id?, meta })');
    expect(prompt).not.toContain('TeamLeaders receive only their scoped transfer_back projection');
    expect(prompt).not.toMatch(/meta is \{ chat_id \}/);
    expect(prompt).not.toContain('The channel MCP is the dispatcher-only channel-binding interface');
    expect(prompt).not.toContain('addressed by chat_id');
    expect(prompt).not.toContain('mcp.channel');
  });
});

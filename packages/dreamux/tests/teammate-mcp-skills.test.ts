import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

const MAINTENANCE_ROOT = join(
  SKILL_ROOT_BY_NAME['dreamux-maintenance'],
  'dreamux-maintenance',
);

const MAINTENANCE_ROUTES = [
  {
    task: 'Service lifecycle and reply diagnosis',
    readWhen:
      'Diagnosing `dreamux serve`, daemon startup, doctor/status results, Dispatcher health, missing replies, stuck turns, restart behavior, current state/run/log paths, bundled-skill injection, or runtime app-server readiness.',
    target: 'service-lifecycle.md',
  },
  {
    task: 'Managed Dreamux self-upgrade',
    readWhen:
      'The operator explicitly requests a Dreamux upgrade, or an injected restart notice requires post-restart recovery and verification.',
    target: 'self-upgrade.md',
  },
  {
    task: 'Host config envelope',
    readWhen:
      'Inspecting or safely editing the current `config.json` envelope, path authority, Dispatcher/agent/channel wiring, or an opaque external provider config.',
    target: 'config-envelope.md',
  },
  {
    task: 'Built-in Codex config',
    readWhen:
      'Inspecting or changing the current `builtin:codex` Agent Runtime provider config.',
    target: 'builtin-codex.md',
  },
  {
    task: 'Built-in Claude Code config',
    readWhen:
      'Inspecting or changing the current `builtin:claude-code` Agent Runtime provider config.',
    target: 'builtin-claude-code.md',
  },
  {
    task: 'Built-in Feishu credentials',
    readWhen:
      'Inspecting or changing the current `builtin:feishu` Channel credential config.',
    target: 'builtin-feishu.md',
  },
  {
    task: 'Feishu access V3',
    readWhen:
      'Diagnosing Feishu access policy or safely editing current V3 `access.json`, including trusted chats and `/introduce`.',
    target: 'feishu-access-v3.md',
  },
] as const;

function readMaintenanceReference(name: (typeof MAINTENANCE_ROUTES)[number]['target']): string {
  return readFileSync(join(MAINTENANCE_ROOT, 'references', name), 'utf8');
}

function enumerateMaintenanceTree(directory = MAINTENANCE_ROOT, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? enumerateMaintenanceTree(join(directory, entry.name), relative)
      : [relative];
  });
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

describe('dreamux-maintenance progressive disclosure', () => {
  it('keeps a concise entrypoint with a bijective seven-reference routing table', () => {
    const skill = readBundledSkill('dreamux-maintenance');
    const description = frontmatterDescription(skill);

    expect(description).toMatch(/Dreamux host operation notes/i);
    for (const trigger of [
      'dreamux serve',
      'daemon startup',
      'doctor/status results',
      'Dispatcher health',
      'missing replies',
      'stuck turns',
      'restart behavior',
      'current config/state/run/log paths',
      'bundled-skill injection',
      'Feishu access policy',
      'runtime app-server readiness',
      'Dreamux upgrade',
      'post-restart recovery',
    ]) {
      expect(description).toContain(trigger);
    }

    expect(skill).toMatch(/Scope And Authorization/);
    expect(skill).toMatch(/Secret Safety/);
    expect(skill).toMatch(/Common Diagnostic Sequence/);
    expect(skill).toMatch(/\| Task \| Read when \| Reference \|/);
    expect(skill).toMatch(/## Reporting/);
    expect(skill).toMatch(/Never print or relay an unredacted config/);
    expect(skill).toMatch(/provider reply tool[\s\S]{0,100}Channel delivery/);

    for (const route of MAINTENANCE_ROUTES) {
      const row = `| ${route.task} | ${route.readWhen} |`;
      expect(skill).toContain(row);
      expect(skill.match(new RegExp(`references/${route.target.replace('.', '\\.')}\\)`, 'g'))).toHaveLength(
        1,
      );
    }

    const expectedTree = [
      'SKILL.md',
      ...MAINTENANCE_ROUTES.map((route) => `references/${route.target}`),
    ].sort();
    expect(enumerateMaintenanceTree().sort()).toEqual(expectedTree);
    expect(readdirSync(join(MAINTENANCE_ROOT, 'references')).sort()).toEqual(
      MAINTENANCE_ROUTES.map((route) => route.target).sort(),
    );

    for (const route of MAINTENANCE_ROUTES) {
      expect(readMaintenanceReference(route.target)).not.toContain('references/');
    }

    for (const rootLeak of [
      '"version": 3',
      '`approval_policy`',
      '`permission_mode`',
      '`app_secret`:',
      'dispatcher stop -> confirmed stop',
      'npm pack @excitedjs/dreamux',
    ]) {
      expect(skill).not.toContain(rootLeak);
    }
    expect(skill.split('\n').length).toBeLessThan(100);
  });

  it('owns current service lifecycle, reply diagnosis, injection, and restart cautions', () => {
    const reference = readMaintenanceReference('service-lifecycle.md');

    expect(reference).toContain('dreamux doctor');
    expect(reference).toContain('dreamux status');
    expect(reference).toContain('dreamux daemon install|uninstall|start|stop|restart');
    expect(reference).toContain('missing replies');
    expect(reference).toMatch(/runtime app-server readiness/);
    expect(reference).toMatch(/Channel ingress[\s\S]{0,160}Channel egress/);
    expect(reference).toMatch(/restart does not prove[\s\S]{0,100}reply was sent/);
    expect(reference).toMatch(/Bundled skills are injected by role/);
    expect(reference).toMatch(/instead of copying bundled skills into a workspace/);
    expect(reference).toContain('~/.dreamux/state/');
    expect(reference).toContain('~/.dreamux/run/');
    expect(reference).toContain('~/.dreamux/logs/');
    expect(reference).toContain(
      'dreamux daemon restart --notify-resumed --dispatcher <current-id>',
    );
    expect(reference).toMatch(/break the active recovery path/);
    expect(reference).toMatch(/Foreground `dreamux serve`[\s\S]{0,100}external recovery path/);
  });

  it('owns the complete current host envelope and structural edit workflow', () => {
    const reference = readMaintenanceReference('config-envelope.md');

    expect(reference).toMatch(/Current `config\.json` Envelope/);
    expect(reference).toContain('dreamux config path');
    expect(reference).toContain('DREAMUX_CONFIG_DIR');
    expect(reference).toMatch(/Do not use `dreamux config\s+show`/);
    for (const hostField of [
      'agents[]',
      'dispatchers[]',
      'workspace.enabled',
      'channels[]',
      'agentRuntime',
      'collaborationSpace.defaultBinding',
      'baseRef',
      'identity',
    ]) {
      expect(reference).toContain(hostField);
    }
    expect(reference).toMatch(/enabled[^\n]+default `true`/);
    expect(reference).toMatch(/workspace\.enabled`, default `true`/);
    expect(reference).toMatch(/defaultBinding[\s\S]+default `false`/);
    expect(reference).toMatch(/enabled Dispatcher[\s\S]{0,100}explicit non-empty usable `cwd`/);
    expect(reference).toMatch(/one provider ref may appear only once/i);
    expect(reference).toMatch(/`repo\.baseRef` may be omitted, null, or any string/);
    expect(reference).toMatch(/External `npm:` provider configs are opaque/);
    expect(reference).toMatch(/exact structural transform/);
    expect(reference).toMatch(/sibling temporary file at mode `0600`/);
    expect(reference).toMatch(/clone it under a new unique id[\s\S]{0,100}repoint only/);
    expect(reference).toMatch(/load the separate provider reference/i);
  });

  it('owns only the current builtin:codex field catalog', () => {
    const reference = readMaintenanceReference('builtin-codex.md');

    for (const field of [
      'bin',
      'approval_policy',
      'sandbox_mode',
      'extra_args',
      'extra_env',
      'initialize_timeout_ms',
      'turn_timeout_ms',
    ]) {
      expect(reference).toContain(`\`${field}\``);
    }
    expect(reference).toContain('CODEX_HOST_CODEX_BIN');
    expect(reference).toContain('never | auto | auto-approve | on-failure');
    expect(reference).toContain('read-only | workspace-write | danger-full-access');
    expect(reference).toMatch(/initialize_timeout_ms[\s\S]{0,100}default `10000`/);
    expect(reference).toMatch(/turn_timeout_ms[\s\S]{0,100}default `600000`/);
    expect(reference).toMatch(/not passed into\s+`CodexRuntime`/);
    expect(reference).toMatch(/currently has no runtime effect/);
    expect(reference).not.toMatch(/permission_mode|remote_control|app_id|app_secret/);
  });

  it('owns only the current builtin:claude-code field catalog', () => {
    const reference = readMaintenanceReference('builtin-claude-code.md');

    for (const field of [
      'bin',
      'model',
      'permission_mode',
      'remote_control',
      'extra_args',
      'extra_env',
      'turn_timeout_ms',
    ]) {
      expect(reference).toContain(`\`${field}\``);
    }
    expect(reference).toContain('default | acceptEdits | plan | bypassPermissions');
    expect(reference).toMatch(/inactivity window reset by stream activity/);
    expect(reference).toMatch(/not a total-duration cap/);
    expect(reference).not.toMatch(/approval_policy|sandbox_mode|app_id|app_secret/);
  });

  it('owns only the current builtin:feishu credential catalog', () => {
    const reference = readMaintenanceReference('builtin-feishu.md');

    expect(reference).toMatch(/`app_id`[\s\S]{0,100}required non-empty string/);
    expect(reference).toMatch(/`app_secret`[\s\S]{0,100}required non-empty string/);
    expect(reference).toMatch(/no credential defaults/i);
    expect(reference).not.toMatch(
      /approval_policy|sandbox_mode|permission_mode|remote_control|dm_policy|allow_chats/,
    );
  });

  it('owns complete current V3 access semantics and quiesced editing', () => {
    const reference = readMaintenanceReference('feishu-access-v3.md');

    expect(reference).toContain('~/.dreamux/state/<dispatcher-id>/access.json');
    expect(reference).toMatch(/DREAMUX_CONFIG_DIR[\s\S]{0,100}affects `config\.json` only/);
    expect(reference).toMatch(/Never derive this state path[\s\S]{0,100}dreamux config path/);
    for (const accessField of [
      '"version": 3',
      '"dm_policy": "pairing"',
      '"policy": "follow-user"',
      '"allow_chats": []',
      '"require_mention": true',
      '"allow_users": []',
      '"pending": {}',
      '"observed_chats": []',
      '"warnings": []',
      '"last_gate"',
      '"at": 0',
    ]) {
      expect(reference).toContain(accessField);
    }
    expect(reference).toMatch(/Channel\/schema-owned: `version`/);
    expect(reference).toMatch(/Operator policy:[\s\S]{0,160}`group\.allow_chats`/);
    expect(reference).toMatch(/Shared authority: `allow_users`/);
    expect(reference).toMatch(/Channel runtime ledger:[\s\S]{0,140}`last_gate`/);
    expect(reference).toMatch(
      /chat in\s+`group\.allow_chats` is trusted under either `allowlist` or `follow-user`/,
    );
    expect(reference).toMatch(
      /`\/introduce` remains sender-scoped[\s\S]{0,100}exact\s+sender ID membership in `allow_users`/,
    );
    expect(reference).toMatch(/not human-only[\s\S]{0,100}manually listed bot\/app sender ID/);
    expect(reference).not.toMatch(/requires the human sender in `allow_users`/);
    expect(reference).toMatch(
      /dispatcher stop -> confirmed stop -> post-stop re-read -> exact atomic patch/,
    );
    expect(reference).toMatch(/fully quiesced for the entire read-modify-write window/);
    expect(reference).toMatch(/Preserve `version` and every Channel runtime-ledger field/);
    expect(reference).toMatch(/Do not claim that `dreamux doctor` validates access state/);
    expect(reference).toMatch(/explicit `ENOENT`[\s\S]{0,100}valid current state/);
    expect(reference).toMatch(/missing state directory[\s\S]{0,40}mode `0700`/);
    expect(reference).toMatch(/sibling mode-`0600` temporary file/);
    expect(reference).toMatch(/target Dispatcher only prepares and reports/);
    expect(reference).toMatch(/independent operator/);
  });

  it('owns the exact staged, restart-safe, two-phase self-upgrade SOP', () => {
    const reference = readMaintenanceReference('self-upgrade.md');
    const headings = Array.from({ length: 18 }, (_, index) => `### ${index + 1}.`);
    let lastHeading = -1;

    for (const heading of headings) {
      const nextHeading = reference.indexOf(heading);
      expect(nextHeading).toBeGreaterThan(lastHeading);
      lastHeading = nextHeading;
    }

    for (const tocLink of [
      '[Preflight](#preflight)',
      '[Staged inspection and classification](#staged-inspection-and-classification)',
      '[Execution before restart](#execution-before-restart)',
      '[Post-restart verification and reporting](#post-restart-verification-and-reporting)',
      '[Recovery and artifact disposition](#recovery-and-artifact-disposition)',
    ]) {
      expect(reference).toContain(tocLink);
    }

    expect(reference).toMatch(/originating Channel message[\s\S]{0,140}provider reply tool/);
    expect(reference).toMatch(/initial `dreamux doctor --json` only to discover/);
    expect(reference).toMatch(
      /exact launcher `doctor --json` again under the captured service[\s\S]{0,200}Only this result is authoritative/,
    );
    expect(reference).toMatch(/`builtin:codex` or `builtin:claude-code`/);
    expect(reference).toMatch(/status PID's parent[\s\S]{0,100}`doctor\.service\.pid`/);
    expect(reference).toMatch(/new status PID's parent[\s\S]{0,180}new\s+service PID/);
    expect(reference).toMatch(/`npm root -g`[\s\S]{0,80}`npm prefix -g`/);
    expect(reference).toMatch(/Reject an npm-linked package root/);
    expect(reference).toMatch(/package\.json\.version[\s\S]{0,180}exact service launcher/);
    expect(reference).toMatch(/npm-linked checkout reporting[\s\S]{0,40}`0\.0\.0` cannot pass/);
    expect(reference).toContain('@excitedjs/dreamux@latest');
    expect(reference).toMatch(/latest stable release[\s\S]{0,80}`beta` or `alpha`/);
    expect(reference).toContain(
      'npm view @excitedjs/dreamux@<requested-or-latest> version --json',
    );
    expect(reference).toMatch(/lower target is a downgrade and is always rejected/);

    for (const command of [
      'npm pack @excitedjs/dreamux@<oldVersion> --ignore-scripts --json --pack-destination <private-dir>/artifacts',
      'npm pack @excitedjs/dreamux@<targetVersion> --ignore-scripts --json --pack-destination <private-dir>/artifacts',
      '<npm-bin> install --global --ignore-scripts --cache <cache> --prefix <private-old-online> <staged-old-tarball>',
      '<npm-bin> install --global --ignore-scripts --cache <cache> --prefix <private-target-online> <staged-target-tarball>',
      '<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <private-old-offline> <staged-old-tarball>',
      '<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <private-target-offline> <staged-target-tarball>',
      '<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <captured-prefix> <staged-target-tarball>',
      '<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <captured-prefix> <staged-old-tarball>',
      '<exact-target-service-launcher> daemon restart --notify-resumed --dispatcher <current-id>',
    ]) {
      expect(reference).toContain(command);
    }

    expect(reference.indexOf('npm view @excitedjs/dreamux')).toBeLessThan(
      reference.indexOf('npm pack @excitedjs/dreamux'),
    );
    expect(reference).toMatch(/Extract the validated target tarball/);
    expect(reference).toMatch(/target owner references named by[\s\S]{0,80}root/);
    expect(reference).toMatch(/old version's[\s\S]{0,80}only to understand and preserve/);
    expect(reference).toContain('(oldVersion,\ntargetVersion]');
    expect(reference).toMatch(/oldest to newest/);
    expect(reference).toMatch(/installed `dreamux changelog --json`[\s\S]{0,100}match the staged/);
    expect(reference).toMatch(/untouched old config[\s\S]{0,100}every planned\s+intermediate config state/);
    expect(reference).toMatch(/live-safe[\s\S]{0,600}independent-quiesced/i);
    expect(reference).toMatch(/verified stage[\s\S]{0,180}confirmed stop[\s\S]{0,180}install the staged exact target/);
    expect(reference).toMatch(/staged target root routing table/);
    expect(reference).toMatch(/task\/read condition owns config editing/);
    expect(reference).not.toMatch(/references\/(?:config-envelope|builtin-codex|builtin-claude-code|builtin-feishu)\.md/);
    expect(reference).toMatch(/This step is preparation only/);
    expect(reference).toMatch(/owner-only backups/);
    expect(reference).toMatch(/operator-private path[\s\S]{0,80}Require acknowledgement/);
    expect(reference).toMatch(/independent controller owns the\s+recovery material/);
    expect(reference).toContain(
      '<captured-managed-HOME>/.dreamux/run/restart-intent.json',
    );
    expect(reference).toMatch(
      /Every\s+transfer, exact stat\/read, removal, and `ENOENT` absence proof[\s\S]{0,80}this one resolved path/,
    );
    expect(reference).toMatch(/non-private route[\s\S]{0,180}sanitized[\s\S]{0,180}stage fresh/);
    expect(reference).toMatch(/clean rather than retain or expose/);

    expect(reference).toMatch(/no-config-mutation boundary/);
    expect(reference).toMatch(
      /unexpected old-daemon exit[\s\S]*?residual\s+process-exit risk/,
    );
    expect(reference).toMatch(/rollback[\s\S]{0,180}do not restart/i);
    expect(reference).toMatch(/report through the original Channel/);
    expect(reference).toMatch(/Only that\s+independent operator[\s\S]*?`dreamux daemon stop`/);
    expect(reference).toMatch(/After confirmed stop[\s\S]{0,180}exact\s+marker path/);
    expect(reference).toMatch(/Only\s+explicit `ENOENT` counts as absence/);
    expect(reference).toMatch(/target package's exact launcher `doctor --json`/);
    expect(reference).toMatch(/managed `HOME`, `PATH`,[\s\S]{0,100}`DREAMUX_NODE_BIN` values override/);
    expect(reference).toMatch(/marker[\s\S]{0,120}same authority domain/);
    expect(reference).toMatch(/new server consumes[\s\S]{0,100}`Restart completed\.`/);
    expect(reference).toMatch(/must not[\s\S]{0,100}continue post-checks in the\s+pre-restart turn/);
    expect(reference).toMatch(/marker creation[\s\S]{0,180}service-control failure/);
    expect(reference).toMatch(/best-effort removal/);
    expect(reference).toMatch(/exact stat\/read[\s\S]{0,100}`ENOENT` proves absence/);
    expect(reference).toMatch(/notice[\s\S]{0,80}explicit trigger to continue with steps 15-18/);
    expect(reference).toMatch(/new `pid` and `uptimeSec`[\s\S]{0,120}pre-restart snapshot/);
    expect(reference).toMatch(/\| Outcome \| Required disposition \|/);
    for (const outcome of [
      'before the first live mutation and before private handoff acknowledgement',
      'Planned independent-quiesced operation with an acknowledged private operator path',
      'Verified success or fully verified rollback',
      'No notice or unresolved recovery',
    ]) {
      expect(reference).toContain(outcome);
    }
    expect(reference).toMatch(/Never use a broad or unresolved cleanup path/);
    expect(reference).toMatch(/same originating Channel surface/);
    expect(reference).toMatch(/Assistant text is not Channel\s+delivery/);
    expect(reference).toMatch(/restart notice does not arrive[\s\S]{0,120}cannot self-diagnose/);
    expect(reference).toMatch(/Foreground `dreamux serve` is not silently treated/);

    expect(reference).not.toMatch(/"version"\s*:\s*[0-2]|"dm_policy"|"allow_users"/);
    expect(reference).not.toMatch(/if (?:the )?(?:running )?version is v?\d/i);
    expect(reference).not.toMatch(/delete\s*(?:\/|or)\s*recreate|rm -rf/i);
  });

  it('keeps current-only owners free of transition recipes and facts singly owned', () => {
    const skill = readBundledSkill('dreamux-maintenance');
    const nonUpgradeReferences = MAINTENANCE_ROUTES.filter(
      (route) => route.target !== 'self-upgrade.md',
    ).map((route) => readMaintenanceReference(route.target));
    const currentOnly = [skill, ...nonUpgradeReferences].join('\n');
    const completeTree = [
      skill,
      ...MAINTENANCE_ROUTES.map((route) => readMaintenanceReference(route.target)),
    ].join('\n');

    expect(currentOnly).not.toMatch(
      /old format|historical format|release-specific migration|Rebuild:|delete\s*(?:\/|or)\s*recreate|rm -rf/i,
    );
    for (const ownerMarker of [
      '"version": 3',
      '`approval_policy`',
      '`permission_mode`',
      '- `app_secret`: required non-empty string authenticating the Feishu app.',
      'dispatcher stop -> confirmed stop -> post-stop re-read -> exact atomic patch',
    ]) {
      expect(completeTree.split(ownerMarker)).toHaveLength(2);
    }

    expect(completeTree).toContain('Feishu');
    for (const obsoleteOrForeignGuidance of [
      'do not invent a separate public daemon command tree',
      'Use this skill only from',
      'legacy TeamMate CLI fallback',
      'There is no separate resume tool',
      'old `.codex/skills`',
      'tm spawn',
      'tm send',
      'npm exec --package @excitedjs/tm',
      'team-dev-workflow',
    ]) {
      expect(completeTree).not.toContain(obsoleteOrForeignGuidance);
    }

    expect(readBundledSkill('dispatcher-workflow')).not.toContain('references/');
    expect(readBundledSkill('dispatcher-workflow')).not.toContain('Feishu');
    expect(readBundledSkill('dispatcher-workflow')).not.toContain('dreamux-maintenance/SKILL.md');
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

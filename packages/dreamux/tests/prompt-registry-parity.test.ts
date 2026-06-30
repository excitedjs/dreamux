import { describe, expect, it } from 'vitest';

import { cronTools } from '../src/mcp/cron-mcp.js';
import { teamTools } from '../src/mcp/team-mcp.js';
import { teammateTools } from '../src/mcp/teammate-mcp.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from '../src/service/dispatcher-service/base-prompt.js';
import { dispatcherMcpServerDescriptors } from '../src/service/dispatcher-service/mcp-descriptors.js';

interface RegisteredTool {
  server: string;
  name: string;
}

const CRON_KNOWN_DRIFT_EXEMPTION_REASON =
  'KNOWN DRIFT (T5a), grandfathered: the dispatcher is injected the cron MCP (service/dispatcher-service/mcp-descriptors.ts) but neither the base/append prompt nor the bundled `dispatcher` skill describes scheduling. Documenting the dispatcher scheduling model is a model-facing change tracked as a follow-up; these are exempted so the gate still enforces parity for the teammate/team verbs and bites future drift. REMOVE this exemption once the dispatcher prompt/skill describes cron_*.';

const PROMPT_EXEMPT_TOOLS = new Map<string, string>([
  // KNOWN DRIFT (T5a), grandfathered: cron is injected into the dispatcher but
  // scheduling is not yet model-facing in the prompt/skill. Remove when cron_*
  // is documented.
  ['cron.cron_create', CRON_KNOWN_DRIFT_EXEMPTION_REASON],
  ['cron.cron_list', CRON_KNOWN_DRIFT_EXEMPTION_REASON],
  ['cron.cron_delete', CRON_KNOWN_DRIFT_EXEMPTION_REASON],
  ['cron.cron_update', CRON_KNOWN_DRIFT_EXEMPTION_REASON],
  ['cron.cron_run_now', CRON_KNOWN_DRIFT_EXEMPTION_REASON],
]);

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
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  return (
    pattern.test(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS) ||
    pattern.test(DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS)
  );
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
      (tool) => !promptMentionsTool(tool.name) && !PROMPT_EXEMPT_TOOLS.has(`${tool.server}.${tool.name}`),
    );

    expect(
      missing,
      [
        'Dispatcher prompt/registry parity drift: registered Dreamux MCP tools must be named as whole words in DREAMUX_DISPATCHER_BASE_INSTRUCTIONS or DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS, unless explicitly exempted in PROMPT_EXEMPT_TOOLS with a model-facing documentation reason.',
        `Missing tool(s):\n${formatTools(missing)}`,
        `Prompt exemption(s):\n${[...PROMPT_EXEMPT_TOOLS.entries()]
          .map(([tool, reason]) => `${tool}: ${reason}`)
          .join('\n')}`,
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

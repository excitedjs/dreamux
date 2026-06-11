import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bundledSkillDir } from '../src/platform/paths.js';
import { DREAMUX_DISPATCHER_BASE_INSTRUCTIONS } from '../src/dispatcher-service/dispatcher/base-prompt.js';

/**
 * Guards the issue #124 alignment as updated by PR6 (issue #126): the bundled
 * dispatcher-facing skills and the injected dispatcher base prompt must present
 * the server-hosted TeamMate MCP as the DEFAULT orchestration interface for
 * named, semi-resident TeamMate agents: spawn/send/close plus
 * history/list/status/last/get_capabilities. The stale task/worker
 * vocabulary must stay gone after the agent-centric cut.
 *
 * These read the SHIPPED skill files (via `bundledSkillDir`) so packaging drift
 * — a stale tm-primary skill slipping back into the npm package — is caught, not
 * just an in-repo copy.
 */

// The dispatcher-scoped `teammate` MCP tool names, owned by
// `src/mcp/teammate-mcp.ts`. Kept in sync with that file's `teammateTools()`.
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

function readBundledSkill(name: string): string {
  return readFileSync(join(bundledSkillDir(name), 'SKILL.md'), 'utf8');
}

describe('TeamMate MCP is the default teammate interface (issue #124, #126 PR6)', () => {
  it('dispatcher skill presents the MCP as default and tm as the explicit fallback', () => {
    const skill = readBundledSkill('dispatcher');

    // Default framing names every MCP tool in the agent-centric surface.
    for (const tool of TEAMMATE_MCP_TOOLS) {
      expect(skill).toContain(tool);
    }
    expect(skill).toContain('the primary interface');
    expect(skill).toContain('the default interface');

    // The task/worker surface must stay deleted.
    expect(skill).toContain('semi-resident TeamMate agents');
    expect(skill).not.toContain('Phase 1 boundary');
    expect(skill).not.toContain('autonomous worker execution');
    expect(skill).not.toContain('may not run a scheduled task to completion');
    expect(skill).not.toContain('runs a repo-local teammate to completion today');
    expect(skill).not.toContain('run_task');
    expect(skill).not.toContain('execute_task');
    expect(skill).not.toContain('schedule');
    expect(skill).not.toContain('task id');

    // tm survives only as the explicit fallback.
    expect(skill).toContain('the explicit fallback');

    // Anti-regression: the old tm-primary framing must not return.
    expect(skill).not.toContain('owns teammate lifecycle, history, and');
    expect(skill).not.toContain('a tm-managed teammate');
  });

  it('team-dev-workflow no longer inherits a tm-primary contract', () => {
    const skill = readBundledSkill('team-dev-workflow');

    expect(skill).toContain('server-hosted TeamMate');
    expect(skill).not.toContain('`dispatcher` owns `tm` mechanics');
  });

  it('dreamux-maintenance covers the teammate MCP and labels tm as fallback', () => {
    const skill = readBundledSkill('dreamux-maintenance');

    expect(skill).toContain('teammate-mcp/<dispatcher-id>.log');
    expect(skill).toContain('TeamMate MCP fails');
    expect(skill).toContain('fallback path');
  });

  it('injected base prompt makes the MCP default and executes for real', () => {
    const prompt = DREAMUX_DISPATCHER_BASE_INSTRUCTIONS;

    expect(prompt).toContain('# TeamMate Delegation');
    expect(prompt).toContain('server-hosted TeamMate MCP is the primary interface');
    expect(prompt).toContain('The tm CLI is the labeled fallback');
    expect(prompt).toContain('named, semi-resident TeamMate agents');
    for (const tool of TEAMMATE_MCP_TOOLS) {
      expect(prompt).toContain(tool);
    }

    // The stale Phase 1 / not-to-completion caveat must be gone (PR6, #126).
    expect(prompt).not.toContain('Phase 1 boundary');
    expect(prompt).not.toContain('may not run a scheduled task to completion');
    expect(prompt).not.toContain('run_task');
    expect(prompt).not.toContain('execute_task');
    expect(prompt).not.toContain('task id');
    // Anti-regression: the old tm-primary section heading must not return.
    expect(prompt).not.toContain('# tm Delegation');
    expect(prompt).not.toContain('await_completion');
  });

  it('does not present a dispatcher-facing await/poll tool (issue #126 PR8)', () => {
    expect(readBundledSkill('dispatcher')).not.toContain('await_completion');
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).not.toContain('await_completion');
  });
});

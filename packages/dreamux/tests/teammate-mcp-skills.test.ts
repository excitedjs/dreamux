import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bundledSkillDir } from '../src/runtime/paths.js';
import { DREAMUX_DISPATCHER_BASE_INSTRUCTIONS } from '../src/dispatcher/base-prompt.js';

/**
 * Guards the issue #124 alignment as updated by PR6 (issue #126): the bundled
 * dispatcher-facing skills and the injected dispatcher base prompt must present
 * the server-hosted TeamMate MCP as the DEFAULT orchestration interface that
 * executes work for real (run_task/execute_task), reads and waits without
 * polling (list_tasks/get_task/pull_result/await_completion), and controls a
 * worker (cancel_task/get_task_logs/get_capabilities) — and keep the `tm` CLI
 * only as the explicit fallback for resume, multi-turn, recovery, and isolated
 * worktrees. The stale "Phase 1 / may not run to completion" caveat must be
 * gone now that PR3-5 wired real workers.
 *
 * These read the SHIPPED skill files (via `bundledSkillDir`) so packaging drift
 * — a stale tm-primary skill slipping back into the npm package — is caught, not
 * just an in-repo copy.
 */

// The dispatcher-scoped `teammate` MCP tool names, owned by
// `src/mcp/teammate-mcp.ts`. Kept in sync with that file's `teammateTools()`.
const TEAMMATE_MCP_TOOLS = [
  'schedule',
  'run_task',
  'execute_task',
  'send_input',
  'await_completion',
  'cancel_task',
  'get_task_logs',
  'get_capabilities',
  'list_tasks',
  'get_task',
  'pull_result',
];

function readBundledSkill(name: string): string {
  return readFileSync(join(bundledSkillDir(name), 'SKILL.md'), 'utf8');
}

describe('TeamMate MCP is the default teammate interface (issue #124, #126 PR6)', () => {
  it('dispatcher skill presents the MCP as default and tm as the explicit fallback', () => {
    const skill = readBundledSkill('dispatcher');

    // Default framing names every MCP tool, including the execution and control
    // verbs wired by PR1-5.
    for (const tool of TEAMMATE_MCP_TOOLS) {
      expect(skill).toContain(tool);
    }
    expect(skill).toContain('the primary interface');
    expect(skill).toContain('the default interface');

    // The MCP executes for real now; the stale "Phase 1 / not to completion"
    // caveat must be gone (PR6, issue #126).
    expect(skill).toContain('executes');
    expect(skill).not.toContain('Phase 1 boundary');
    expect(skill).not.toContain('autonomous worker execution');
    expect(skill).not.toContain('may not run a scheduled task to completion');
    expect(skill).not.toContain('runs a repo-local teammate to completion today');

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
    expect(skill).toContain('TeamMate scheduling/retrieval fails');
    expect(skill).toContain('fallback path');
  });

  it('injected base prompt makes the MCP default and executes for real', () => {
    const prompt = DREAMUX_DISPATCHER_BASE_INSTRUCTIONS;

    expect(prompt).toContain('# TeamMate Delegation');
    expect(prompt).toContain('server-hosted TeamMate MCP is the primary interface');
    expect(prompt).toContain('The tm CLI is the labeled fallback');
    expect(prompt).toContain('executes work for real');
    for (const tool of TEAMMATE_MCP_TOOLS) {
      expect(prompt).toContain(tool);
    }

    // The stale Phase 1 / not-to-completion caveat must be gone (PR6, #126).
    expect(prompt).not.toContain('Phase 1 boundary');
    expect(prompt).not.toContain('may not run a scheduled task to completion');
    // Anti-regression: the old tm-primary section heading must not return.
    expect(prompt).not.toContain('# tm Delegation');
  });
});

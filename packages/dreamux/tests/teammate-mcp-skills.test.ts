import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bundledSkillDir } from '../src/runtime/paths.js';
import { DREAMUX_DISPATCHER_BASE_INSTRUCTIONS } from '../src/dispatcher/base-prompt.js';

/**
 * Guards the issue #124 alignment: the bundled dispatcher-facing skills and the
 * injected dispatcher base prompt must present the server-hosted TeamMate MCP as
 * the PRIMARY scheduled-task interface, keep the `tm` CLI only as a clearly
 * labeled fallback, and state the #110 Phase 1 boundary (scheduling accepts
 * ledger state; autonomous worker execution is runtime-specific follow-up).
 *
 * These read the SHIPPED skill files (via `bundledSkillDir`) so packaging drift
 * — a stale tm-primary skill slipping back into the npm package — is caught, not
 * just an in-repo copy.
 */

// The dispatcher-scoped `teammate` MCP tool names, owned by
// `src/mcp/teammate-mcp.ts`. Kept in sync with that file's `teammateTools()`.
const TEAMMATE_MCP_TOOLS = ['schedule', 'list_tasks', 'get_task', 'pull_result'];

function readBundledSkill(name: string): string {
  return readFileSync(join(bundledSkillDir(name), 'SKILL.md'), 'utf8');
}

describe('TeamMate MCP is the primary teammate interface (issue #124)', () => {
  it('dispatcher skill presents the MCP as primary and tm as a labeled fallback', () => {
    const skill = readBundledSkill('dispatcher');

    // Primary framing names every MCP tool.
    for (const tool of TEAMMATE_MCP_TOOLS) {
      expect(skill).toContain(tool);
    }
    expect(skill).toContain('the primary interface');
    expect(skill).toContain('primary scheduled-task interface');

    // Phase 1 boundary is stated, not implied.
    expect(skill).toContain('Phase 1 boundary');
    expect(skill).toContain('autonomous worker execution');

    // tm survives only as the labeled fallback.
    expect(skill).toContain('the labeled fallback');

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

  it('injected base prompt makes the MCP primary and keeps the Phase 1 boundary', () => {
    const prompt = DREAMUX_DISPATCHER_BASE_INSTRUCTIONS;

    expect(prompt).toContain('# TeamMate Delegation');
    expect(prompt).toContain('server-hosted TeamMate MCP is the primary interface');
    expect(prompt).toContain('Phase 1 boundary');
    expect(prompt).toContain('The tm CLI is the labeled fallback');
    for (const tool of TEAMMATE_MCP_TOOLS) {
      expect(prompt).toContain(tool);
    }

    // Anti-regression: the old tm-primary section heading must not return.
    expect(prompt).not.toContain('# tm Delegation');
  });
});

/**
 * Which `team.create` calls carry the Team dispatch reminder.
 *
 * `create` is two operations behind one name. With a `prompt` it is a hand-off:
 * the TeamLeader's first turn is submitted behind the receipt the caller reads,
 * and the result of that turn arrives later as a separate message — the exact
 * fact the reminder states, and the one a caller holding only the receipt
 * cannot see. Without a `prompt` nothing was submitted and no completion is
 * pending, so there is nothing to say. This MCP entry mints a fresh request id,
 * so every successful prompt-bearing call is a fresh accepted create.
 *
 * The reminder's wording is owned by `dispatch-reminders.ts` and imported here:
 * what this file proves is the attachment, not the text.
 */
import { describe, expect, it } from 'vitest';

import { TEAM_DISPATCH_SUCCESS_REMINDER } from '../src/service/mcp/dispatch-reminders.js';
import { createTeamMcpDelegate } from '../src/service/team-collection/mcp-delegate.js';
import type { McpDelegateResult } from '../src/service/mcp/types.js';
import {
  createFakeDispatcher,
  type FakeDispatcherOverrides,
} from './helpers/command-harness.js';

/** One `create` call on a Dispatcher-scoped Team delegate. */
async function create(
  args: Record<string, unknown>,
  overrides: FakeDispatcherOverrides = {},
): Promise<McpDelegateResult> {
  const delegate = createTeamMcpDelegate({
    dispatcher: createFakeDispatcher(overrides),
    caller: { kind: 'dispatcher' },
  });
  return delegate.call({
    name: 'create',
    arguments: {
      name_prefix: 'blue',
      intent: 'ship the refactor',
      leader_agent_runtime: 'r1',
      ...args,
    },
  });
}

describe('team.create dispatch reminder', () => {
  it('attaches the Team reminder when a prompt was handed down', async () => {
    const result = await create({ prompt: 'start on the design' });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ text: TEAM_DISPATCH_SUCCESS_REMINDER });
  });

  it('says nothing when no prompt was given', async () => {
    const result = await create({});

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('text');
  });

});

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
 * Shared reminder constants define the full wording; these checks cover
 * receipt attachment and the no-polling instruction.
 */
import { describe, expect, it } from 'vitest';

import {
  TEAM_DISPATCH_SUCCESS_REMINDER,
  TEAMMATE_DISPATCH_SUCCESS_REMINDER,
  WORKFLOW_RUN_SUCCESS_REMINDER,
} from '../src/service/mcp/dispatch-reminders.js';
import type { TeamLeaderHandle } from '../src/service/dispatcher-service/team-leader-handle.js';
import { createTeamMcpDelegate } from '../src/service/team-collection/mcp-delegate.js';
import { createTeamMateMcpDelegate } from '../src/service/teammate-collection/mcp-delegate.js';
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
    expect(result).toMatchObject({ text: expect.stringMatching(/do not poll.*completion/i) });
  });

  it('says nothing when no prompt was given', async () => {
    const result = await create({});

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('text');
  });

});

describe('team.send dispatch reminder', () => {
  it('preserves the admission receipt and tells the caller to wait for the push', async () => {
    const delegate = createTeamMcpDelegate({
      dispatcher: createFakeDispatcher(),
      caller: { kind: 'dispatcher' },
    });
    const result = await delegate.call({
      name: 'send',
      arguments: { team_name: 'harness-team', prompt: 'continue' },
    });
    expect(result).toEqual({
      ok: true,
      structured: { status: 'submitted', turn_id: 'harness-turn-1' },
      text: TEAM_DISPATCH_SUCCESS_REMINDER,
    });
    expect(result).toMatchObject({ text: expect.stringMatching(/automatically push.*Do not poll/) });
  });

  it.each(['duplicate', 'stopped', 'skipped', 'failed', 'ambiguous'])(
    'adds no reminder when admission is %s',
    async (status) => {
      const delegate = createTeamMcpDelegate({
        dispatcher: createFakeDispatcher({
          submitToTeamLeader: async () => ({ status, error: new Error('not admitted') }),
        }),
        caller: { kind: 'dispatcher' },
      });
      const result = await delegate.call({
        name: 'send',
        arguments: { team_name: 'harness-team', prompt: 'continue' },
      });
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('text');
    },
  );
});

describe.each(['dispatcher', 'team_leader'] as const)('%s TeamMate dispatch reminders', (kind) => {
  function delegateFor(overrides: FakeDispatcherOverrides = {}) {
    const dispatcher = createFakeDispatcher(overrides);
    return createTeamMateMcpDelegate(kind === 'dispatcher'
      ? { kind, dispatcher }
      : {
          kind,
          team: async () => ({
            teammates: dispatcher.teammates,
            spawnTeamMate: dispatcher.teammates.spawn,
            workflows: dispatcher.workflows,
          }) as unknown as TeamLeaderHandle,
        });
  }

  describe.each(['spawn', 'send'])('%s', (name) => {
    it.each(['submitted', 'duplicate', 'stopped', 'failed', 'ambiguous'])(
      'preserves the %s receipt and guides only submitted work',
      async (status) => {
        const receipt = { teammate: {}, status };
        const delegate = delegateFor({
          teammates: { spawn: async () => receipt, send: async () => receipt },
        });
        const result = await delegate.call({
          name,
          arguments: name === 'spawn'
            ? { name_prefix: 'reviewer', intent: 'review the change', prompt: 'review' }
            : { name: 'reviewer-1', prompt: 'continue' },
        });
        expect(result).toMatchObject({ ok: true, structured: receipt });
        if (status === 'submitted') {
          expect(result).toMatchObject({ text: TEAMMATE_DISPATCH_SUCCESS_REMINDER });
          expect(result).toMatchObject({ text: expect.stringMatching(/automatically push.*Do not poll/) });
        } else {
          expect(result).not.toHaveProperty('text');
        }
      },
    );
  });

  it('keeps the workflow run id and requires waiting for system completion', async () => {
    const result = await delegateFor().call({
      name: 'workflow_run',
      arguments: { script: 'export default async () => "done";' },
    });
    expect(result).toEqual({
      ok: true,
      structured: { run_id: 'harness-run-1' },
      text: WORKFLOW_RUN_SUCCESS_REMINDER,
    });
    expect(result).toMatchObject({ text: expect.stringMatching(/do not call or poll.*wait for the system push/) });
  });

  it('does not attach dispatch guidance to a read', async () => {
    const result = await delegateFor().call({ name: 'list', arguments: {} });
    expect(result).toEqual({ ok: true, structured: { teammates: [] } });
  });
});

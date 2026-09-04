import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { describe, expect, it } from 'vitest';

import { LegacyStateError } from '../src/service/legacy-state.js';
import { TeamCollectionReadModel } from '../src/service/team-collection/read-model.js';
import type { TeamStore } from '../src/service/team-collection/store.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';

const log = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as DreamuxLogger;

const record: TeamRecord = {
  dispatcher_id: 'd1',
  team_id: 'team-a',
  status: 'running',
  intent: null,
  source_repo: null,
  leader_name: 'lead-1',
  leader_agent_runtime: 'codex',
  created_at: 1,
  updated_at: 2,
  closed_at: null,
  close_note: null,
  worktree: {
    mode: 'reuse-cwd',
    path: '/tmp',
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  },
} as unknown as TeamRecord;

/** One Team whose leader identity file is exactly what the test planted. */
async function plantLeader(content: string): Promise<TeamCollectionReadModel> {
  const teamDir = await mkdtemp(join(tmpdir(), 'team-read-legacy-'));
  await writeFile(join(teamDir, 'identity.json'), content);
  return new TeamCollectionReadModel({
    dispatcherId: 'd1',
    store: {
      list: async () => [record],
      teamRoot: () => teamDir,
    } as unknown as TeamStore,
    log,
  });
}

const LEGACY_LEADER = JSON.stringify({
  version: 1,
  name: 'lead-1',
  dispatcher_id: 'd1',
  provider_ref: 'builtin:codex',
});

const CURRENT_LEADER = JSON.stringify({
  version: 1,
  name: 'lead-1',
  dispatcher_id: 'd1',
  team_id: 'team-a',
  agent_runtime: 'codex',
  status: 'running',
  session_id: null,
  skill_sources: [],
  cwd: '/tmp',
  runtime_cwd: '/tmp',
  source_cwd: '/tmp',
  source_repo: null,
  worktree: {
    mode: 'reuse-cwd',
    path: '/tmp',
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  },
  created_at: 1,
  updated_at: 1,
});

/**
 * A `session_ref` field is the same kind of legacy leader state as
 * `provider_ref`: `assertNoRemovedRecordFields` rejects it explicitly, because
 * the session id it carried sits one level below where the current reader looks
 * for `session_id`. Accepting the record would resume nothing and quietly start
 * a fresh session, so the loss has to surface here — where the read model must
 * raise it rather than downgrade it to "no leader state" the way it does for an
 * ordinary unreadable file.
 */
const REMOVED_FIELD_LEADER = JSON.stringify({
  ...JSON.parse(CURRENT_LEADER),
  session_ref: { id: 'provider-session-1' },
});

/**
 * A leftover `role` field, by contrast, is inert residue. Core decides an Agent
 * is a TeamLeader purely from where its identity lives (the Team root), so a
 * stale role label is a key nothing reads — rejecting it would cost the operator
 * a rebuild for no recovered fact.
 */
const ROLE_FIELD_LEADER = JSON.stringify({
  ...JSON.parse(CURRENT_LEADER),
  role: 'team_member',
});

describe('Team read projections and old leader state', () => {
  it('raises a legacy leader record through list, history, and status', async () => {
    const reads = await plantLeader(LEGACY_LEADER);

    await expect(reads.list()).rejects.toBeInstanceOf(LegacyStateError);
    await expect(reads.history({})).rejects.toBeInstanceOf(LegacyStateError);
    await expect(reads.summary(record)).rejects.toBeInstanceOf(LegacyStateError);
  });

  it('raises a leader record carrying a removed field the same way', async () => {
    const reads = await plantLeader(REMOVED_FIELD_LEADER);

    await expect(reads.list()).rejects.toBeInstanceOf(LegacyStateError);
    await expect(reads.summary(record)).rejects.toBeInstanceOf(LegacyStateError);
  });

  it('projects a leader carrying a leftover `role` field normally', async () => {
    const reads = await plantLeader(ROLE_FIELD_LEADER);

    const [row] = await reads.list();
    expect(row?.leader_agent_runtime).toBe('codex');
    expect(row?.leader_state).toBe('running');
    expect((await reads.summary(record)).leader?.status).toBe('running');
  });

  it('still reports an ordinary unreadable leader as no leader state', async () => {
    const reads = await plantLeader('{ not json');

    const [row] = await reads.list();
    expect(row?.leader_state).toBeNull();
    expect((await reads.summary(record)).leader).toBeNull();
  });

  it('keeps the response shape of a valid leader record', async () => {
    const reads = await plantLeader(CURRENT_LEADER);

    const [row] = await reads.list();
    expect(row?.leader_state).toBe('running');
    expect((await reads.summary(record)).leader?.status).toBe('running');
  });
});

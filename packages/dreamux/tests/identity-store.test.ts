import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentIdentityStore } from '../src/service/agent/store.js';
import { CronJobStore } from '../src/service/scheduler/store.js';
import { LegacyStateError } from '../src/platform/errors.js';
const log: DreamuxLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child: () => log,
};
describe('AgentIdentityStore.read() validates persisted identity and session facts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dreamux-identity-legacy-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function store(): AgentIdentityStore {
    return new AgentIdentityStore({
      dir,
      dispatcherId: 'flow',
      expectedName: 'reviewer',
      log,
    });
  }

  const CURRENT_SHAPE = {
    version: 1,
    dispatcher_id: 'flow',
    name: 'reviewer',
    team_id: null,
    agent_runtime: 'codex',
    session_id: null,
    source_cwd: '/tmp/src',
    source_repo: null,
    cwd: '/tmp/run',
    runtime_cwd: '/tmp/run',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/tmp/run',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    intent: null,
    identity_prompt: null,
    skill_sources: [],
    created_at: 1,
    updated_at: 1,
    status: 'running',
    last_error: null,
    closed_at: null,
    close_note: null,
  };

  it('accepts the current shape as a control (proves the fixture itself is valid)', async () => {
    await writeFile(join(dir, 'identity.json'), JSON.stringify(CURRENT_SHAPE));
    const identity = await store().read();
    expect(identity?.name).toBe('reviewer');
  });

  it('reads a leftover nested `session` object as no prior session, not a failure', async () => {
    // `session: { id }` only ever existed inside the unreleased provider-boundary
    // refactor, so no released build wrote it. Rejecting it would have been a
    // permanent gate for a shape that cannot reach a real upgrade — and it would
    // have gated the ONE outcome that is already correct: an id this reader
    // cannot find means "no prior session", so the Agent starts a fresh one.
    // That is exactly what a record whose id was written under another key
    // deserves. `session_id`'s own type check stays the only gate.
    await writeFile(
      join(dir, 'identity.json'),
      JSON.stringify({
        ...CURRENT_SHAPE,
        session_id: undefined,
        session: { id: 'provider-session-1' },
      }),
    );
    const identity = await store().read();
    expect(identity?.session_id).toBeNull();
    expect(identity as unknown as Record<string, unknown>).not.toHaveProperty(
      'session',
    );
  });

  it('treats a present-but-unusable `session_id` as an unreadable record, never as "no session"', async () => {
    // The type check is the contract, and the two outcomes must stay distinct.
    // A leftover nested `session` yields a VALID identity whose session_id is
    // null (above). A corrupt `session_id` is not an older layout, so it must
    // never reach that same null through coercion: the record fails validation
    // and is skipped as unreadable, exactly like a bad `version` or `cwd`.
    for (const bad of [42, { id: 'x' }, '', []] as const) {
      const warnings: string[] = [];
      const store = new AgentIdentityStore({
        dir,
        dispatcherId: 'flow',
        expectedName: 'reviewer',
        log: {
          ...log,
          warn: (fields: unknown) =>
            warnings.push(String((fields as { error?: string }).error)),
        } as unknown as DreamuxLogger,
      });
      await writeFile(
        join(dir, 'identity.json'),
        JSON.stringify({ ...CURRENT_SHAPE, session_id: bad }),
      );

      const identity = await store.read();
      expect(identity, `session_id ${JSON.stringify(bad)}`).toBeNull();
      expect(warnings.join('\n')).toMatch(
        /session_id that is not a non-empty string/,
      );
    }
  });

  it('tolerates a leftover `role` field: role is derived from the directory, never read', async () => {
    // A record's own role claim was never load-bearing — the owning Service,
    // Collection, and directory decide it. Rejecting the leftover key would gate
    // an upgrade on a fact this version does not read, so it stays inert
    // residue: no path creates, validates, or deletes it.
    await writeFile(
      join(dir, 'identity.json'),
      JSON.stringify({ ...CURRENT_SHAPE, role: 'team_member' }),
    );
    const identity = await store().read();
    expect(identity?.name).toBe('reviewer');
    expect(identity as unknown as Record<string, unknown>).not.toHaveProperty(
      'role',
    );
  });

  it('tolerates a leftover `transcript_locator` field: the Activity read never uses it', async () => {
    // The neutral Activity seam addresses a session by its opaque id, so a
    // persisted native transcript path has no reader left. Same reasoning as
    // `role`: inert residue, not an upgrade blocker.
    await writeFile(
      join(dir, 'identity.json'),
      JSON.stringify({
        ...CURRENT_SHAPE,
        transcript_locator: '/tmp/session.jsonl',
      }),
    );
    const identity = await store().read();
    expect(identity?.name).toBe('reviewer');
    expect(identity as unknown as Record<string, unknown>).not.toHaveProperty(
      'transcript_locator',
    );
  });

  it('fails loud on a legacy `provider_ref` identity (pre-#148, before agent_runtime existed)', async () => {
    await writeFile(
      join(dir, 'identity.json'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'reviewer',
        provider_ref: 'builtin:codex',
      }),
    );
    await expect(store().read()).rejects.toThrow(LegacyStateError);
    await expect(store().read()).rejects.toThrow(/legacy provider_ref format/);
  });
});

describe('CronJobStore validates persisted action shapes', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dreamux-cron-legacy-'));
    path = join(dir, 'cron-jobs.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function store(): CronJobStore {
    return new CronJobStore(path);
  }

  it('accepts a current prompt-agent job as a control', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            dispatcher_id: 'flow',
            cron: '0 9 * * *',
            tz: 'UTC',
            recurring: true,
            action: { kind: 'prompt-agent', prompt: 'stand up' },
            enabled: true,
            created_at: 1,
            updated_at: 1,
            next_run_at: null,
            last_fired_at: null,
          },
        ],
      }),
    );
    const jobs = await store().list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.action).toEqual({
      kind: 'prompt-agent',
      prompt: 'stand up',
    });
  });

  it('fails loud on the removed `spawn-teammate` action kind', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            dispatcher_id: 'flow',
            cron: '0 9 * * *',
            tz: 'UTC',
            recurring: true,
            action: { kind: 'spawn-teammate', name: 'reviewer' },
            enabled: true,
            created_at: 1,
            updated_at: 1,
            next_run_at: null,
            last_fired_at: null,
          },
        ],
      }),
    );
    await expect(store().list()).rejects.toThrow(
      /removed spawn-teammate action/,
    );
  });

  it('assertCurrent() surfaces the same fail-loud verdict used by the startup doctor path', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'job-1',
            dispatcher_id: 'flow',
            cron: '0 9 * * *',
            tz: 'UTC',
            recurring: true,
            action: { kind: 'spawn-teammate', name: 'reviewer' },
            enabled: true,
            created_at: 1,
            updated_at: 1,
            next_run_at: null,
            last_fired_at: null,
          },
        ],
      }),
    );
    await expect(store().assertCurrent()).rejects.toThrow(LegacyStateError);
  });
});

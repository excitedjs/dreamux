import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoRemovedRecordFields,
  detectLegacyDispatcherState,
  legacyDispatcherStateMessage,
  LegacyStateError,
} from '../src/service/legacy-state.js';
import {
  dispatcherDir,
  dispatcherTeamDir,
  dispatcherTeamMateDir,
  resetRuntimeConfig,
  setRuntimeConfig,
} from '../src/platform/paths.js';
import { BUILT_IN_DEFAULTS } from '../src/config/config.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { CronJobStore } from '../src/service/scheduler/store.js';

const log = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as DreamuxLogger;

/**
 * Fail-loud coverage for every state shape the minimize-provider-boundaries
 * refactor removed (issue #199 / #233). Dreamux 0.x never migrates: a leftover
 * from an older layout, or a persisted field/value/action this version no
 * longer accepts, must throw a NAMED incompatible-state error (LegacyStateError
 * or a doctor-formatted message the operator can act on) rather than being
 * silently skipped, coerced, migrated, or dual-written.
 *
 * "No longer accepts" is narrower than "no longer writes". A removed field is
 * rejected only when accepting the record would LOSE something the reader cannot
 * see — a checkpoint whose absence would silently discard delivery state. A
 * leftover field this version simply never consults (`role`, derived from the
 * owning directory; `transcript_locator`, replaced by the neutral Activity
 * seam's opaque session id) is inert residue: gating an upgrade on it would cost
 * the operator a rebuild to delete a key nothing reads.
 *
 * Session identity is the sharpest case, and it needs NO removed-field entry at
 * all. `session_id`'s own type check (`string | null`) is the whole contract: an
 * id this reader cannot find means "no prior session", so the Agent starts a
 * fresh one — the only correct outcome for a record whose id sat under a
 * different key. A present-but-unusable value is corruption, not an old layout,
 * and fails loud there. All three directions are pinned below.
 *
 * The corresponding ABSENCE checks (no importer/backfill/dual-write for the old
 * shape) live in the "no migration path" describe block below, as source-shape
 * guards — the one place absence-as-contract belongs per this node's TEST STYLE.
 */
describe('legacy dispatcher-root state detection (fail-loud, never migrated)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-legacy-state-'));
    process.env['DREAMUX_ROOT'] = root;
    setRuntimeConfig(BUILT_IN_DEFAULTS);
  });

  afterEach(async () => {
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    await rm(root, { recursive: true, force: true });
  });

  it('reports no findings for a fresh dispatcher directory', async () => {
    await mkdir(dispatcherDir('flow'), { recursive: true });
    expect(await detectLegacyDispatcherState('flow')).toEqual([]);
  });

  it('detects the removed Core channel-binding store at the dispatcher root', async () => {
    await mkdir(dispatcherDir('flow'), { recursive: true });
    await writeFile(join(dispatcherDir('flow'), 'channel-bindings.json'), '{}');
    const findings = await detectLegacyDispatcherState('flow');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.what).toMatch(/Core channel-binding store/);
    const message = legacyDispatcherStateMessage('flow', findings);
    expect(message).toMatch(/does not migrate old state/);
    expect(message).toMatch(/channel-bindings\.json/);
  });

  it('detects the removed Core Collaboration Space state file', async () => {
    await mkdir(dispatcherDir('flow'), { recursive: true });
    await writeFile(
      join(dispatcherDir('flow'), 'collaboration-spaces.json'),
      '{}',
    );
    const findings = await detectLegacyDispatcherState('flow');
    expect(findings.map((f) => f.what)).toEqual([
      expect.stringMatching(/Core Collaboration Space state, removed/),
    ]);
  });

  it('detects every pre-#233 flat TeamMate/Team leaf, leaving teammate/ and team/ themselves valid', async () => {
    const teammate = dispatcherTeamMateDir('flow');
    const team = dispatcherTeamDir('flow');
    await mkdir(join(teammate, 'records'), { recursive: true });
    await mkdir(join(teammate, 'turns'), { recursive: true });
    await mkdir(join(teammate, 'history'), { recursive: true });
    await mkdir(join(teammate, 'identities'), { recursive: true });
    await writeFile(join(teammate, 'sessions.jsonl'), '');
    await mkdir(join(team, 'records'), { recursive: true });
    await mkdir(join(team, 'ledger'), { recursive: true });
    await writeFile(join(team, 'channel-bindings.json'), '{}');
    // A real, current-shape entity dir sits beside the legacy leaves. Its
    // presence must not itself be flagged: only the specific removed leaf
    // names are probed, never the `teammate/`/`team/` collection roots.
    await mkdir(join(teammate, 'reviewer-abcd'), { recursive: true });

    const findings = await detectLegacyDispatcherState('flow');
    const paths = findings.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        join(teammate, 'identities'),
        join(teammate, 'records'),
        join(teammate, 'turns'),
        join(teammate, 'sessions.jsonl'),
        join(teammate, 'history'),
        join(team, 'records'),
        join(team, 'channel-bindings.json'),
        join(team, 'ledger'),
      ].sort(),
    );
    expect(paths).not.toContain(join(teammate, 'reviewer-abcd'));
  });

  it('propagates a real access error (ENOTDIR) instead of treating it as "not present"', async () => {
    // A non-ENOENT access failure is a real operational problem the operator
    // must see; detection must not swallow it as "no legacy state" the way
    // `pathExists` (the best-effort probe used elsewhere) deliberately does.
    // Forcing ENOTDIR is portable (no chmod/root needed): make the `teammate/`
    // collection root itself a plain FILE, so probing any leaf underneath it
    // (e.g. `teammate/records`) fails with ENOTDIR, not ENOENT.
    await mkdir(dispatcherDir('flow'), { recursive: true });
    const teammate = dispatcherTeamMateDir('flow');
    await writeFile(teammate, 'not a directory');
    await expect(detectLegacyDispatcherState('flow')).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});

describe('assertNoRemovedRecordFields (shared chokepoint)', () => {
  it('passes a record that carries none of the removed fields', () => {
    expect(() =>
      assertNoRemovedRecordFields(
        'agent record "x"',
        { name: 'x', agent_runtime: 'codex' },
        ['session_ref', 'checkpoint'],
        'delete and rebuild',
      ),
    ).not.toThrow();
  });

  it('names every present removed field in one loud LegacyStateError', () => {
    expect(() =>
      assertNoRemovedRecordFields(
        'agent record "x"',
        { name: 'x', session_ref: { id: 's1' }, checkpoint: { id: 'c1' } },
        ['session_ref', 'checkpoint', 'close_status'],
        'close and respawn this teammate, or delete its identity directory',
      ),
    ).toThrow(LegacyStateError);
    try {
      assertNoRemovedRecordFields(
        'agent record "x"',
        { session_ref: {}, checkpoint: {} },
        ['session_ref', 'checkpoint', 'close_status'],
        'rebuild-hint',
      );
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(LegacyStateError);
      const message = (err as Error).message;
      expect(message).toContain('session_ref');
      expect(message).toContain('checkpoint');
      // Only the fields actually present are named: an absent entry from the
      // caller's list never appears in the message.
      expect(message).not.toContain('close_status');
      expect(message).toContain('rebuild-hint');
    }
  });

  it('a field the caller did not list is left alone, however legacy-looking', () => {
    // The chokepoint rejects exactly the list its caller supplies. Nothing here
    // recognizes a field by name pattern, so a leftover key a reader chose not
    // to reject stays inert residue rather than becoming a hidden upgrade gate.
    expect(() =>
      assertNoRemovedRecordFields(
        'agent record "x"',
        { name: 'x', role: 'team_leader', transcript_locator: '/tmp/x.jsonl' },
        ['session_ref', 'checkpoint'],
        'delete and rebuild',
      ),
    ).not.toThrow();
  });
});

describe('AgentIdentityStore.read() rejects a persisted identity carrying a removed field', () => {
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
    expect(identity as unknown as Record<string, unknown>).not.toHaveProperty('session');
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
      expect(warnings.join('\n')).toMatch(/session_id that is not a non-empty string/);
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
    expect(identity as unknown as Record<string, unknown>).not.toHaveProperty('role');
  });

  it('tolerates a leftover `transcript_locator` field: the Activity read never uses it', async () => {
    // The neutral Activity seam addresses a session by its opaque id, so a
    // persisted native transcript path has no reader left. Same reasoning as
    // `role`: inert residue, not an upgrade blocker.
    await writeFile(
      join(dir, 'identity.json'),
      JSON.stringify({ ...CURRENT_SHAPE, transcript_locator: '/tmp/session.jsonl' }),
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

  it('fails loud on other removed fields: checkpoint, session_ref, display_name, close_status', async () => {
    for (const field of [
      'checkpoint',
      'checkpoint_kind',
      'session_ref',
      'display_name',
      'close_status',
    ] as const) {
      await writeFile(
        join(dir, 'identity.json'),
        JSON.stringify({ ...CURRENT_SHAPE, [field]: 'x' }),
      );
      await expect(store().read(), `field ${field}`).rejects.toThrow(LegacyStateError);
    }
  });
});

describe('CronJobStore rejects the removed cron deliver/spawn-teammate shapes', () => {
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
    return new CronJobStore({ cronJobsPath: path, dispatcherId: 'flow' });
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
    expect(jobs[0]!.action).toEqual({ kind: 'prompt-agent', prompt: 'stand up' });
  });

  it('fails loud on a job carrying the removed `deliver` field', async () => {
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
            deliver: { channel_id: 'primary', target: 'chat-1' },
            enabled: true,
            created_at: 1,
            updated_at: 1,
            next_run_at: null,
            last_fired_at: null,
          },
        ],
      }),
    );
    await expect(store().list()).rejects.toThrow(/removed deliver field/);
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
    await expect(store().list()).rejects.toThrow(/removed spawn-teammate action/);
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

/**
 * ABSENCE-as-contract: prove there is no reader anywhere in `src/` that still
 * knows how to interpret the removed shapes (no migration, no lazy backfill,
 * no dual-write, no compatibility alias). This is a source-shape guard,
 * appropriate per this node's brief only because the fact being asserted IS an
 * absence — a behavioral test cannot observe "no code path exists".
 */
describe('no migration path exists for any removed state shape (source-shape guard)', () => {
  it('no src file reads channel-bindings.json or collaboration-spaces.json for anything but fail-loud detection', async () => {
    const { execFileSync } = await import('node:child_process');
    const packageRoot = new URL('..', import.meta.url).pathname;
    const out = execFileSync(
      'grep',
      [
        '-rl',
        '--include=*.ts',
        '-e',
        'channel-bindings.json',
        '-e',
        'collaboration-spaces.json',
        join(packageRoot, 'src'),
      ],
      { encoding: 'utf8' },
    ).trim();
    const hits = out === '' ? [] : out.split('\n').map((p) => p.trim());
    // Only the fail-loud detector itself is allowed to name these leaf files.
    expect(hits.every((p) => p.endsWith('src/service/legacy-state.ts'))).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('no src file spells the retired `team_member` role vocabulary', async () => {
    const { execFileSync } = await import('node:child_process');
    const packageRoot = new URL('..', import.meta.url).pathname;
    let out = '';
    try {
      out = execFileSync(
        'grep',
        ['-rl', '--include=*.ts', 'team_member', join(packageRoot, 'src')],
        { encoding: 'utf8' },
      ).trim();
    } catch (err) {
      // grep exits 1 with no output when there are zero matches — that is the
      // success case this test wants, not a real command failure.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    expect(out).toBe('');
  });

  it('no src file re-derives Core binding/target_key/binding_fallbacks state', async () => {
    const { execFileSync } = await import('node:child_process');
    const packageRoot = new URL('..', import.meta.url).pathname;
    let out = '';
    try {
      out = execFileSync(
        'grep',
        [
          '-rlE',
          '--include=*.ts',
          'binding_fallbacks|target_key|resolveInboundBinding',
          join(packageRoot, 'src'),
        ],
        { encoding: 'utf8' },
      ).trim();
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
    }
    expect(out).toBe('');
  });
});

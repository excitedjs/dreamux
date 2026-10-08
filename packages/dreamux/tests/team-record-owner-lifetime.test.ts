import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpLeaseRegistry } from '../src/service/mcp/leases.js';
import { AgentNameRegistry } from '../src/service/agent/store.js';
import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { createLeaderTeamMcpDelegate } from '../src/service/team/leader-mcp.js';
import { TeamService } from '../src/service/team/service.js';
import { TeamStore, type TeamRecordHandle } from '../src/service/team/store.js';
import type { TeamRecord } from '../src/service/team/types.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import * as nameAllocation from '../src/service/name-allocator.js';
import {
  deferred,
  type Deferred,
} from './helpers/controlled-runtime-provider.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

// Observe actual record reads without replacing filesystem behavior.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

afterEach(() => vi.restoreAllMocks());
type Fixture = Awaited<ReturnType<typeof dispatcherFixture>>;
const execFileAsync = promisify(execFile);
interface ObservedHold {
  record: TeamRecordHandle;
  releases: number;
  released: Deferred<void>;
  children: ObservedHold[];
}

// Count actual owner acquisitions without replacing any record operation.
function observeHold(record: TeamRecordHandle): ObservedHold {
  const observed: ObservedHold = {
    record,
    releases: 0,
    released: deferred<void>(),
    children: [],
  };
  const release = record.release.bind(record);
  vi.spyOn(record, 'release').mockImplementation(async () => {
    observed.releases++;
    await release();
    observed.released.resolve();
  });
  const retain = record.retain.bind(record);
  vi.spyOn(record, 'retain').mockImplementation(() => {
    const child = observeHold(retain());
    observed.children.push(child);
    return child.record;
  });
  return observed;
}
function observeConstruction() {
  const holds: ObservedHold[] = [];
  const create = TeamService.createNew;
  vi.spyOn(TeamService, 'createNew').mockImplementation((deps, input) => {
    holds.push(observeHold(deps.record));
    return create(deps, input);
  });
  return holds;
}
async function editIntent(fixture: Fixture, teamId: string, intent: string) {
  const path = join(fixture.teamRoot, teamId, 'record.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as TeamRecord;
  await writeFile(path, JSON.stringify({ ...record, intent }));
}
async function managedRequest(fixture: Fixture, id: string) {
  const repo = join(fixture.host.cwd, 'source-repo');
  await mkdir(repo);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.com'],
  ])
    await execFileAsync('git', args, { cwd: repo });
  await writeFile(join(repo, 'tracked.txt'), 'initial\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
  const request = teamRequest(id, 'Start review');
  const command = {
    ...request.command,
    repo: {
      mode: 'managed' as const,
      path: repo,
      cleanup: 'delete-on-close' as const,
    },
  };
  return { ...request, command, payloadHash: teamCreatePayloadHash(command) };
}

describe('R74 record holds through actual Team owners', () => {
  it('loads an absent construction candidate once and reserves it before workspace awaits', async () => {
    const fixture = await dispatcherFixture();
    const entered = deferred<void>();
    const unblock = deferred<void>();
    fixture.releases.push(() => unblock.resolve());
    const allocate = nameAllocation.allocateConcreteNameAsync;
    vi.spyOn(nameAllocation, 'allocateConcreteNameAsync').mockImplementation(
      async (input) => {
        if (input.kind === 'team' && (await input.accept('shared-candidate')))
          return 'shared-candidate';
        return allocate(input);
      },
    );
    const prepare = WorktreeManager.prototype.prepareDefaultWorkspace;
    const prepared: string[] = [];
    vi.spyOn(
      WorktreeManager.prototype,
      'prepareDefaultWorkspace',
    ).mockImplementation(async function (this: WorktreeManager, input) {
      prepared.push(input.slug);
      if (input.slug === 'shared-candidate') {
        entered.resolve();
        await unblock.promise;
      }
      return prepare.call(this, input);
    });
    const reads = vi.mocked(fs.readFile);
    reads.mockClear();
    let firstSettled = false;
    const first = fixture.teams
      .createFromRequest(teamRequest('first-construction'))
      .finally(() => {
        firstSettled = true;
      });
    try {
      await entered.promise;
      const path = join(fixture.teamRoot, 'shared-candidate', 'record.json');
      expect(
        reads.mock.calls.filter(([file]) => String(file) === path),
      ).toHaveLength(1);
      const second = await fixture.teams.createFromRequest(
        teamRequest('second-construction'),
      );
      expect(second.team_name).not.toBe('shared-candidate');
      expect(firstSettled).toBe(false);
      expect(prepared).toEqual(['shared-candidate', second.team_name]);
      expect(
        reads.mock.calls.filter(([file]) => String(file) === path),
      ).toHaveLength(1);
      unblock.resolve();
      expect((await first).team_name).toBe('shared-candidate');
      for (const [team, request] of [
        ['shared-candidate', 'first-construction'],
        [second.team_name, 'second-construction'],
      ])
        expect(
          JSON.parse(
            await readFile(
              join(fixture.teamRoot, team!, 'record.json'),
              'utf8',
            ),
          ).create_request_id,
        ).toBe(request);
      expect(
        (await fixture.teams.list()).map((row) => row.team_name).sort(),
      ).toEqual(['shared-candidate', second.team_name].sort());
      expect(fixture.provider.runtimes).toHaveLength(0);
    } finally {
      unblock.resolve();
      await first;
    }
  });

  it('keeps the construction owner through initial leader MCP self-dissolve before tracking, then reads retired history from disk', async () => {
    const fixture = await dispatcherFixture();
    const holds = observeConstruction();
    const started = deferred<TeamService>();
    const finishConstruction = deferred<void>();
    fixture.releases.push(() => finishConstruction.resolve());
    const start = TeamService.prototype.startCreated;
    vi.spyOn(TeamService.prototype, 'startCreated').mockImplementation(
      async function (this: TeamService, input) {
        await start.call(this, input);
        started.resolve(this);
        await finishConstruction.promise;
      },
    );
    let hookedTeam: unknown;
    fixture.host.hooks.team.tap('capture-real-owner', (team) => {
      hookedTeam = team;
    });
    const request = teamRequest(
      'initial-self-dissolve',
      'Finish the initial task',
    );
    let constructionSettled = false;
    const creating = fixture.teams.createFromRequest(request).finally(() => {
      constructionSettled = true;
    });
    const service = await started.promise;
    expect(service).toBe(hookedTeam);
    expect(fixture.provider.runtimes).toHaveLength(1);
    expect(fixture.provider.runtimes[0]!.inputs).toEqual([
      '<task>Finish the initial task</task>',
    ]);
    const result = await createLeaderTeamMcpDelegate(service).call({
      name: 'dissolve',
      arguments: { note: 'Initial task complete', force: false },
    });
    expect(result).toMatchObject({
      ok: true,
      structured: {
        accepted: true,
        team_name: service.id,
        status: 'submitted',
      },
    });
    await service.closed;
    const hold = holds[0]!;
    expect(hold.children).toHaveLength(1);
    await hold.children[0]!.released.promise;
    expect(constructionSettled).toBe(false);
    expect(hold.releases).toBe(0);
    await editIntent(
      fixture,
      service.id,
      'Edited while construction owns the record',
    );
    expect(await fixture.teams.summary(service.id)).toMatchObject({
      status: 'closed',
      intent: request.command.intent,
    });
    finishConstruction.resolve();
    expect(await creating).toMatchObject({
      status: 'closed',
      team_name: service.id,
      intent: request.command.intent,
    });
    await hold.released.promise;
    expect(hold.releases).toBe(1);
    expect(hold.children[0]!.releases).toBe(1);
    expect(await fixture.teams.summary(service.id)).toMatchObject({
      status: 'closed',
      intent: 'Edited while construction owns the record',
    });
    expect(await fixture.teams.createFromRequest(request)).toMatchObject({
      status: 'closed',
      team_name: service.id,
      intent: 'Edited while construction owns the record',
    });
    expect(fixture.provider.runtimes).toHaveLength(1);
  });

  it('holds the captured record through a direct leader precheck when the initial submission fails and construction retires', async () => {
    const fixture = await dispatcherFixture();
    const holds = observeConstruction();
    const request = await managedRequest(fixture, 'initial-precheck-failure');
    const admission = deferred<{ status: 'ambiguous'; error: Error }>();
    fixture.provider.planNext({ delayedAdmission: admission.promise });
    const runtimeCreated = deferred<void>();
    const createRuntime = fixture.provider.createRuntime.bind(fixture.provider);
    vi.spyOn(fixture.provider, 'createRuntime').mockImplementation(
      async (context) => {
        const runtime = await createRuntime(context);
        runtimeCreated.resolve();
        return runtime;
      },
    );
    let store!: TeamStore;
    const acquire = TeamStore.prototype.acquire;
    vi.spyOn(TeamStore.prototype, 'acquire').mockImplementation(function (
      this: TeamStore,
      id,
    ) {
      store = this;
      return acquire.call(this, id);
    });
    let mintedTeam: { registry: McpLeaseRegistry; token: string } | undefined;
    const mint = McpLeaseRegistry.prototype.mint;
    vi.spyOn(McpLeaseRegistry.prototype, 'mint').mockImplementation(function (
      this: McpLeaseRegistry,
      lease,
      delegate,
    ) {
      const minted = mint.call(this, lease, delegate);
      if (minted?.name === 'team')
        mintedTeam = { registry: this, token: minted.token };
      return minted;
    });
    const hooked = deferred<TeamService>();
    fixture.host.hooks.team.tap('capture-precheck-owner', (team) => {
      if (team instanceof TeamService) hooked.resolve(team);
    });
    const precheckStarted = deferred<void>();
    const resumePrecheck = deferred<void>();
    fixture.releases.push(() => resumePrecheck.resolve());
    const assess = WorktreeManager.prototype.assessCleanup;
    let assessments = 0;
    let resumedAssessment: Awaited<ReturnType<typeof assess>> | undefined;
    vi.spyOn(WorktreeManager.prototype, 'assessCleanup').mockImplementation(
      async function (this: WorktreeManager, input) {
        const first = assessments++ === 0;
        if (first) {
          precheckStarted.resolve();
          await resumePrecheck.promise;
        }
        const result = await assess.call(this, input);
        if (first) resumedAssessment = result;
        return result;
      },
    );
    const creating = fixture.teams.createFromRequest(request);
    const creationResult = creating.catch((error: unknown) => error);
    const service = await hooked.promise;
    await runtimeCreated.promise;
    await fixture.provider.runtimes[0]!.submitStarted.promise;
    if (mintedTeam === undefined) throw new Error('missing actual Team lease');
    const { registry, token } = mintedTeam;
    let callSettled = false;
    const dissolving = registry
      .invoke(token, {
        name: 'dissolve',
        arguments: {
          note: 'Initial leader completed before acknowledgement',
          force: false,
        },
      })
      .finally(() => {
        callSettled = true;
      });
    let acquired: TeamRecordHandle | undefined;
    try {
      await precheckStarted.promise;
      admission.resolve({
        status: 'ambiguous',
        error: new Error('initial turn/start response lost'),
      });
      expect(await creationResult).toEqual(
        new Error('initial turn/start response lost'),
      );
      const construction = holds[0]!;
      await construction.released.promise;
      expect(construction.releases).toBe(1);
      expect(construction.record.current).toMatchObject({
        status: 'closed',
        worktree: { cleanup_state: 'deleted' },
      });
      await expect(access(service.workspace)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(callSettled).toBe(false);
      expect(
        await registry.invoke(token, {
          name: 'dissolve',
          arguments: { note: 'Too late', force: false },
        }),
      ).toMatchObject({ ok: false });
      const path = join(fixture.teamRoot, service.id, 'record.json');
      const reads = vi.mocked(fs.readFile);
      reads.mockClear();
      acquired = await store.acquire(service.id);
      const readsDuringAcquire = reads.mock.calls.filter(
        ([file]) => String(file) === path,
      ).length;
      const sharedBeforeResume =
        acquired.current === construction.record.current;
      resumePrecheck.resolve();
      expect(await dissolving).toMatchObject({
        ok: true,
        structured: {
          accepted: true,
          team_name: service.id,
          status: 'submitted',
        },
      });
      expect(construction.children).toHaveLength(1);
      await construction.children[0]!.released.promise;
      const disk = JSON.parse(await readFile(path, 'utf8')) as TeamRecord;
      // Assert outside MCP error isolation, after the late publication actually settled.
      expect(resumedAssessment).toMatchObject({
        status: 'terminal',
        worktree: { cleanup_state: 'deleted' },
      });
      expect(disk.close_note).toBe(
        'Initial leader completed before acknowledgement',
      );
      const summary = await fixture.teams.summary(service.id);
      expect({
        sharedBeforeResume,
        readsDuringAcquire,
        heldNote: acquired.current?.close_note,
        publicNote: summary.close_note,
        diskNote: disk.close_note,
      }).toEqual({
        sharedBeforeResume: true,
        readsDuringAcquire: 0,
        heldNote: disk.close_note,
        publicNote: disk.close_note,
        diskNote: 'Initial leader completed before acknowledgement',
      });
      expect(acquired.current).toEqual(disk);
      expect(sharedBeforeResume).toBe(true);
      expect(readsDuringAcquire).toBe(0);
      expect(construction.children[0]!.releases).toBe(1);
      await acquired.release();
      acquired = undefined;
      await editIntent(
        fixture,
        service.id,
        'Cold history after the last precheck owner released',
      );
      expect(await fixture.teams.summary(service.id)).toMatchObject({
        status: 'closed',
        intent: 'Cold history after the last precheck owner released',
      });
    } finally {
      admission.resolve({
        status: 'ambiguous',
        error: new Error('initial turn/start response lost'),
      });
      resumePrecheck.resolve();
      await creationResult;
      await dissolving;
      await holds[0]?.children[0]?.released.promise;
      await acquired?.release();
    }
  });

  it('releases refused prechecks and concurrent join holds while one accepted dissolve owns cleanup', async () => {
    const fixture = await dispatcherFixture();
    const holds = observeConstruction();
    const request = await managedRequest(fixture, 'precheck-refusal-join');
    const created = await fixture.teams.createFromRequest(request);
    const service = await fixture.teams.open(created.team_name);
    const hold = holds[0]!;
    const dirty = join(service.workspace, 'untracked.txt');
    await writeFile(dirty, 'keep until approved');
    const delegate = createLeaderTeamMcpDelegate(service);
    const call = () =>
      delegate.call({
        name: 'dissolve',
        arguments: { note: 'Clean workspace complete', force: false },
      });
    await expect(call()).rejects.toThrow('managed worktree is dirty');
    expect(hold.children).toHaveLength(1);
    await hold.children[0]!.released.promise;
    expect(hold.children[0]!.releases).toBe(1);
    expect(hold.releases).toBe(0);
    expect(await readFile(dirty, 'utf8')).toBe('keep until approved');
    expect((await fixture.teams.summary(service.id)).status).toBe('running');
    await fs.unlink(dirty);
    const prechecksEntered = deferred<void>();
    const resume = deferred<void>();
    fixture.releases.push(() => resume.resolve());
    const assess = WorktreeManager.prototype.assessCleanup;
    let assessments = 0;
    let completedPrechecks = 0;
    vi.spyOn(WorktreeManager.prototype, 'assessCleanup').mockImplementation(
      async function (this: WorktreeManager, input) {
        const concurrentPrecheck = ++assessments <= 2;
        const result = await assess.call(this, input);
        if (concurrentPrecheck) {
          if (++completedPrechecks === 2) prechecksEntered.resolve();
          await resume.promise;
        }
        return result;
      },
    );
    const first = call();
    const second = call();
    try {
      await prechecksEntered.promise;
      expect(hold.children).toHaveLength(3);
      resume.resolve();
      const receipt = {
        ok: true,
        structured: {
          accepted: true,
          team_name: service.id,
          status: 'submitted',
        },
      };
      expect(await first).toMatchObject(receipt);
      expect(await second).toMatchObject(receipt);
      await Promise.all(hold.children.map((child) => child.released.promise));
      expect(hold.children.map((child) => child.releases)).toEqual([1, 1, 1]);
      expect(hold.releases).toBe(1);
      expect(await fixture.teams.summary(service.id)).toMatchObject({
        status: 'closed',
        close_note: 'Clean workspace complete',
      });
      expect(hold.record.current?.worktree.cleanup_state).toBe('deleted');
      await expect(access(service.workspace)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      resume.resolve();
      await Promise.all([first, second]);
      await Promise.all(hold.children.map((child) => child.released.promise));
    }
  });

  it('releases a construction that fails before the factory inner try only after its unclaimed Git checkout is discarded', async () => {
    const fixture = await dispatcherFixture();
    const holds = observeConstruction();
    const request = await managedRequest(fixture, 'early-name-failure');
    const failed = new Error(
      'identity namespace read failed before leader creation',
    );
    const allocate = vi
      .spyOn(AgentNameRegistry.prototype, 'allocate')
      .mockRejectedValueOnce(failed);
    const cleanupStarted = deferred<string>();
    const finishCleanup = deferred<void>();
    fixture.releases.push(() => finishCleanup.resolve());
    const cleanup = WorktreeManager.prototype.cleanup;
    vi.spyOn(WorktreeManager.prototype, 'cleanup').mockImplementation(
      async function (this: WorktreeManager, input, options) {
        if (typeof input.worktree.path !== 'string')
          throw new Error('expected managed checkout');
        cleanupStarted.resolve(input.worktree.path);
        await finishCleanup.promise;
        return cleanup.call(this, input, options);
      },
    );
    const creating = fixture.teams.createFromRequest(request).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    const checkout = await cleanupStarted.promise;
    const hold = holds[0]!;
    expect(hold.record.current).toBeNull();
    expect(hold.releases).toBe(0);
    expect(hold.children).toHaveLength(0);
    expect(await access(checkout)).toBeUndefined();
    expect(fixture.provider.runtimes).toHaveLength(0);
    finishCleanup.resolve();
    expect((await creating).error).toBe(failed);
    await hold.released.promise;
    expect(hold.releases).toBe(1);
    await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fixture.teams.list()).toEqual([]);
    allocate.mockRestore();
    expect(await fixture.teams.createFromRequest(request)).toMatchObject({
      status: 'running',
    });
    expect(fixture.provider.runtimes).toHaveLength(1);
  });

  it('does not release twice when the dispatcher closes after construction transfers its hold to the tracked service', async () => {
    const fixture = await dispatcherFixture();
    const holds = observeConstruction();
    const captured = deferred<TeamService>();
    const start = TeamService.prototype.startCreated;
    vi.spyOn(TeamService.prototype, 'startCreated').mockImplementation(
      async function (this: TeamService, input) {
        await start.call(this, input);
        captured.resolve(this);
        fixture.host.fence.close();
      },
    );
    await expect(
      fixture.teams.createFromRequest(teamRequest('tracked-close-race')),
    ).rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
    const service = await captured.promise;
    const hold = holds[0]!;
    expect(hold.record.current?.status).toBe('running');
    expect(hold.releases).toBe(0);
    // Host stop leaves the tracked nonclosed service and its owner intact.
    await service.stopForHost();
    expect(hold.releases).toBe(0);
    await service.dissolve({
      note: 'Close the already admitted Team',
      force: true,
    });
    await service.closed;
    await hold.released.promise;
    expect(hold.children).toHaveLength(1);
    await hold.children[0]!.released.promise;
    expect(hold.releases).toBe(1);
    expect(hold.children[0]!.releases).toBe(1);
    expect(hold.record.current?.status).toBe('closed');
  });

  it('holds the same record after service.closed until detached physical cleanup settles, with one hold for repeated dissolve receipts', async () => {
    const fixture = await dispatcherFixture();
    const holds = observeConstruction();
    const request = await managedRequest(fixture, 'detached-cleanup-owner');
    const created = await fixture.teams.createFromRequest(request);
    const service = await fixture.teams.open(created.team_name);
    const hold = holds[0]!;
    const cleanupStarted = deferred<void>();
    const finishCleanup = deferred<void>();
    fixture.releases.push(() => finishCleanup.resolve());
    const cleanup = WorktreeManager.prototype.cleanup;
    vi.spyOn(WorktreeManager.prototype, 'cleanup').mockImplementation(
      async function (this: WorktreeManager, input, options) {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        return cleanup.call(this, input, options);
      },
    );
    const receipt = await fixture.teams.dissolve(created.team_name, {
      note: 'Finish managed work',
      force: false,
    });
    await cleanupStarted.promise;
    await service.closed;
    await hold.released.promise;
    expect(hold.releases).toBe(1);
    expect(hold.children).toHaveLength(1);
    expect(hold.children[0]!.releases).toBe(0);
    expect(hold.record.current).toMatchObject({
      status: 'closed',
      worktree: { cleanup_state: 'cleanup-pending' },
    });
    expect(await access(created.runtime_cwd)).toBeUndefined();
    expect(
      await service.dissolve({ note: 'Repeated receipt', force: false }),
    ).toEqual(receipt);
    expect(hold.children).toHaveLength(1);
    await editIntent(
      fixture,
      created.team_name,
      'Foreign edit during detached cleanup',
    );
    expect(await fixture.teams.summary(created.team_name)).toMatchObject({
      status: 'closed',
      intent: request.command.intent,
      worktree_cleanup: 'cleanup-pending',
    });
    finishCleanup.resolve();
    await hold.children[0]!.released.promise;
    expect(hold.children[0]!.releases).toBe(1);
    await expect(access(created.runtime_cwd)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const path = join(fixture.teamRoot, created.team_name, 'record.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      status: 'closed',
      intent: request.command.intent,
      worktree: { cleanup_state: 'deleted' },
    });
    await editIntent(
      fixture,
      created.team_name,
      'Edited after physical cleanup settled',
    );
    expect(await fixture.teams.summary(created.team_name)).toMatchObject({
      status: 'closed',
      intent: 'Edited after physical cleanup settled',
      worktree_cleanup: 'deleted',
    });
    expect(await fixture.teams.createFromRequest(request)).toMatchObject({
      status: 'closed',
      team_name: created.team_name,
      intent: 'Edited after physical cleanup settled',
    });
    expect(fixture.provider.runtimes).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import {
  dispatcherAgentIdentityPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import type { AgentEntityWorktreeIdentity } from '../src/service/agent-entity/types.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(TEST_DIR);
const SRC_ROOT = join(PACKAGE_ROOT, 'src');
const SERVICE_ROOT = join(SRC_ROOT, 'service');

interface SourceHit {
  file: string;
  line: number;
  text: string;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function sourceRelativePath(file: string): string {
  return toPosixPath(relative(SRC_ROOT, file));
}

function packagePath(file: string): string {
  return `/packages/dreamux/${toPosixPath(relative(PACKAGE_ROOT, file))}`;
}

async function sourceFilesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFilesUnder(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

function hitsInSource(file: string, source: string, pattern: RegExp): SourceHit[] {
  // Scan the WHOLE file (not line-by-line) so a match spanning a newline — e.g.
  // `new\n  SchedulerService(` — cannot evade the gate; map each match offset
  // back to its starting line for diagnostics.
  const scan = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
  );
  const lines = source.split(/\r?\n/);
  const hits: SourceHit[] = [];
  for (let m = scan.exec(source); m !== null; m = scan.exec(source)) {
    const line = source.slice(0, m.index).split(/\r?\n/).length;
    hits.push({ file, line, text: (lines[line - 1] ?? '').trim() });
    if (m.index === scan.lastIndex) scan.lastIndex += 1; // never loop on a zero-width match
  }
  return hits;
}

async function findSourceHits(root: string, pattern: RegExp): Promise<SourceHit[]> {
  const hits: SourceHit[] = [];
  for (const file of await sourceFilesUnder(root)) {
    hits.push(...hitsInSource(file, await readFile(file, 'utf8'), pattern));
  }
  return hits;
}

function formatHits(hits: SourceHit[]): string {
  return hits
    .map((hit) => `${packagePath(hit.file)}:${hit.line}: ${hit.text}`)
    .join('\n');
}

function failInvariant(invariant: string, detail: string): never {
  throw new Error(`${invariant}\n${detail}`);
}

function assertNoHits(invariant: string, hits: SourceHit[]): void {
  if (hits.length > 0) {
    failInvariant(invariant, `Offending file(s):\n${formatHits(hits)}`);
  }
}

async function assertConstructedOnlyIn(input: {
  invariant: string;
  pattern: RegExp;
  allowedFiles: readonly string[];
}): Promise<void> {
  const hits = await findSourceHits(SRC_ROOT, input.pattern);
  const allowed = new Set(input.allowedFiles);
  const unexpected = hits.filter((hit) => !allowed.has(sourceRelativePath(hit.file)));
  if (unexpected.length > 0) {
    failInvariant(
      input.invariant,
      `Offending constructor site(s):\n${formatHits(unexpected)}`,
    );
  }

  const present = new Set(hits.map((hit) => sourceRelativePath(hit.file)));
  const missing = input.allowedFiles.filter((file) => !present.has(file));
  if (missing.length > 0) {
    failInvariant(
      input.invariant,
      `Expected constructor site missing from: ${missing.join(', ')}`,
    );
  }
}

async function readServiceSource(relativeFile: string): Promise<string> {
  return readFile(join(SERVICE_ROOT, relativeFile), 'utf8');
}

async function readSource(relativeFile: string): Promise<string> {
  return readFile(join(SRC_ROOT, relativeFile), 'utf8');
}

function assertContains(
  source: string,
  pattern: RegExp,
  invariant: string,
  file: string,
): void {
  if (!pattern.test(source)) {
    failInvariant(invariant, `Offending file: /packages/dreamux/src/service/${file}`);
  }
}

function noopLog(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

function fakeRuntimeCatalog(): AgentRuntimeProviderCatalog {
  return {
    list: () => [],
    resolve(ref: string) {
      throw new Error(`unexpected runtime provider ${JSON.stringify(ref)}`);
    },
  } as unknown as AgentRuntimeProviderCatalog;
}

describe('architecture ownership gate (#233)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-ownership-gate-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    await mkdir(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps TeammateService free of scheduler ownership', async () => {
    assertNoHits(
      'T1/cron-ownership invariant violated: TeammateService must carry no SchedulerService field/type or constructor.',
      await findSourceHits(join(SERVICE_ROOT, 'teammate-service'), /\bSchedulerService\b/),
    );
  });

  it('constructs SchedulerService only in dispatcher and team containers', async () => {
    await assertConstructedOnlyIn({
      invariant:
        'cron-per-conversational-agent invariant violated: new SchedulerService(...) is allowed only in dispatcher-service/index.ts and team-service/index.ts.',
      pattern: /new\s+SchedulerService\s*\(/,
      allowedFiles: [
        'service/dispatcher-service/index.ts',
        'service/team-service/index.ts',
      ],
    });
  });

  it('constructs TeammateService only through the single factory', async () => {
    await assertConstructedOnlyIn({
      invariant:
        'T2 single-factory invariant violated: new TeammateService(...) must occur only in teammate-service/factory.ts.',
      pattern: /new\s+TeammateService\s*\(/,
      allowedFiles: ['service/teammate-service/factory.ts'],
    });
  });

  it('keeps core free of a parallel worker/runtime provider tree', async () => {
    assertNoHits(
      'T2 runtime-tree invariant violated: dreamux core has one AgentRuntime seam, backed by AgentRuntimeProviderCatalog and ProviderRegistry; do not reintroduce a parallel worker/runtime/provider tree.',
      await findSourceHits(
        SRC_ROOT,
        /\b(?:class|interface|type)\s+(?!(?:AgentRuntimeProvider|AgentRuntimeProviderCatalog)\b)[A-Za-z_$][\w$]*(?:Worker(?:Provider|Runtime|Service|Catalog)|RuntimeProvider(?:Catalog)?|RuntimeService|RuntimeCatalog)\b/,
      ),
    );
  });

  it('keeps the team leader out of the members collection', async () => {
    const file = 'teammate-collection/index.ts';
    const source = await readServiceSource(file);
    const forbidden = hitsInSource(
      join(SERVICE_ROOT, file),
      source,
      /\b(createTeamLeader|allocateLeaderName)\b|\bleader\s*\(/,
    );
    assertNoHits(
      '#247 ownership invariant violated: TeammateCollection must expose no createTeamLeader/leader/allocateLeaderName path.',
      forbidden,
    );

    // Extract ONLY the `assertInCollection` method body, anchored on the
    // method's OWN closing brace (`\n  }` at class-member indent) — not on the
    // formatting of whatever method happens to follow it — so a legitimate
    // reflow of a neighbour can't false-fail this gate.
    const guard = source.match(
      /private assertInCollection\([^)]*\)[^{]*\{[\s\S]*?\n {2}\}/,
    )?.[0];
    if (guard === undefined) {
      failInvariant(
        '#247 ownership invariant violated: TeammateCollection.assertInCollection must remain the members-collection scope guard.',
        `Offending file: /packages/dreamux/src/service/${file}`,
      );
    }
    assertContains(
      guard,
      /identity\.role\s*===\s*'teammate'/,
      '#247 ownership invariant violated: dispatcher-scope collection must admit only role teammate.',
      file,
    );
    assertContains(
      guard,
      /identity\.role\s*===\s*'team_member'/,
      '#247 ownership invariant violated: team-scope members collection must admit only role team_member.',
      file,
    );
    assertNoHits(
      '#247 ownership invariant violated: TeammateCollection.assertInCollection must not admit role team_leader.',
      hitsInSource(join(SERVICE_ROOT, file), guard, /team_leader/),
    );
  });

  it('does not resolve a team leader through a team-scoped members collection', async () => {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const log = noopLog();
    const identities = new AgentIdentityStore({ warn: log.warn.bind(log) });
    const turnsStore = new AgentTurnsStore({ warn: log.warn.bind(log) });
    const worktree = {
      mode: 'reuse-cwd',
      slug: null,
      path: workspace,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    } satisfies AgentEntityWorktreeIdentity;

    await identities.create({
      dispatcherId: 'dispatcher-a',
      name: 'tl-alpha',
      role: 'team_leader',
      teamId: 'alpha',
      agentRuntime: 'agent-a',
      sourceCwd: workspace,
      sourceRepo: null,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree,
      intent: 'lead alpha',
      status: 'running',
    });

    const collection = new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: 'alpha',
      config: testDreamuxConfig([
        testDispatcherConfig({
          id: 'dispatcher-a',
          cwd: workspace,
          agentRuntime: 'agent-a',
        }),
      ]),
      agentRuntimeProviders: fakeRuntimeCatalog(),
      worktrees: new WorktreeManager(),
      identities,
      turnsStore,
      log,
    });

    await expect(collection.status('tl-alpha')).rejects.toThrow(
      'TeamMate "tl-alpha" does not exist',
    );
  });

  it('reads old TeamMate identity records with identity_prompt as null', async () => {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const log = noopLog();
    const identities = new AgentIdentityStore({ warn: log.warn.bind(log) });
    const worktree = {
      mode: 'reuse-cwd',
      slug: null,
      path: workspace,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    } satisfies AgentEntityWorktreeIdentity;
    const path = dispatcherAgentIdentityPath({
      dispatcherId: 'dispatcher-a',
      name: 'legacy-worker',
      teamId: null,
      role: 'teammate',
    });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        dispatcher_id: 'dispatcher-a',
        name: 'legacy-worker',
        role: 'teammate',
        team_id: null,
        agent_runtime: 'agent-a',
        session_id: null,
        source_cwd: workspace,
        source_repo: null,
        cwd: workspace,
        runtime_cwd: workspace,
        worktree,
        intent: 'old work',
        created_at: 1,
        updated_at: 1,
        status: 'running',
        last_error: null,
        closed_at: null,
        close_note: null,
        turn_count: 0,
        last_seen_at: 1,
        last_prompt_preview: null,
        last_assistant_preview: null,
      })}\n`,
    );

    await expect(
      identities.get('dispatcher-a', 'legacy-worker'),
    ).resolves.toMatchObject({ identity_prompt: null });
  });

  it('builds conversational agents through the factory without launch forks', async () => {
    const leaderAgent = await readServiceSource('team-service/leader-agent.ts');
    assertContains(
      leaderAgent,
      /createTeamLeaderAgent[\s\S]*return\s+createTeammateService\s*\(/,
      'T2 leader factory invariant violated: createTeamLeaderAgent must call createTeammateService.',
      'team-service/leader-agent.ts',
    );
    assertNoHits(
      'T2 leader factory invariant violated: createTeamLeaderAgent must not pass a launch strategy.',
      hitsInSource('team-service/leader-agent.ts', leaderAgent, /launch:/),
    );

    const dispatcherAgent = await readServiceSource('dispatcher-service/agent.ts');
    assertContains(
      dispatcherAgent,
      /createDispatcherAgent[\s\S]*createTeammateService\s*\(/,
      'T2 dispatcher factory invariant violated: createDispatcherAgent must call createTeammateService.',
      'dispatcher-service/agent.ts',
    );
    assertNoHits(
      'T2 dispatcher factory invariant violated: createDispatcherAgent must not pass a launch strategy.',
      hitsInSource('dispatcher-service/agent.ts', dispatcherAgent, /launch:|buildDispatcherLaunch/),
    );
  });

  it('keeps channel binding ownership and summary composition out of TeamService and TeamCollection', async () => {
    const teamServiceFile = join(SERVICE_ROOT, 'team-service/index.ts');
    const teamService = await readFile(teamServiceFile, 'utf8');
    assertNoHits(
      'Channel binding ownership invariant violated: TeamService must not import, access, or compose channel binding facts.',
      hitsInSource(
        teamServiceFile,
        teamService,
        /ChannelBindingStore|ChannelBindingSummary|TeamBindingSummaryResolver|bindingSummaryForOwner|bindChannel|resolveLeaderChannel|activeGroupBindingFor|\bbinding\s*:/,
      ),
    );

    const teamCollectionFile = join(SERVICE_ROOT, 'team-collection/index.ts');
    const teamCollection = await readFile(teamCollectionFile, 'utf8');
    assertNoHits(
      'Channel binding ownership invariant violated: TeamCollection must expose Team facts only, not binding-store access or binding summary composition.',
      hitsInSource(
        teamCollectionFile,
        teamCollection,
        /ChannelBindingStore|ChannelBindingSummary|TeamBindingSummaryResolver|bindingSummaryForOwner|bindings:\s|transferChannelBack|resolveChannel|\bbound_target\s*:|\bbinding\s*:/,
      ),
    );

    assertNoHits(
      'Channel binding ownership invariant violated: Team service directories must not import the binding store or define binding-summary resolver callbacks.',
      (
        await Promise.all(
          ['team-service', 'team-collection'].map((dir) =>
            findSourceHits(
              join(SERVICE_ROOT, dir),
              /from\s+['"][^'"]*channel-binding\/store\.js['"]|TeamBindingSummaryResolver|bindingSummaryForOwner/,
            ),
          ),
        )
      ).flat(),
    );
  });

  it('keeps Team read binding summaries composed in admin methods', async () => {
    const adminMethods = await readSource('admin/methods.ts');
    assertContains(
      adminMethods,
      /'mcp\.team\.list'[\s\S]*bound_target:\s*await dispatcher\.activeTeamBindingSummary/,
      'Team read composition invariant violated: mcp.team.list must add bound_target in admin/methods.ts.',
      '../admin/methods.ts',
    );
    assertContains(
      adminMethods,
      /'mcp\.team\.status'[\s\S]*bound_target:\s*await dispatcher\.activeTeamBindingSummary/,
      'Team read composition invariant violated: mcp.team.status must add bound_target in admin/methods.ts.',
      '../admin/methods.ts',
    );
    assertContains(
      adminMethods,
      /'mcp\.team\.history'[\s\S]*bound_target:\s*await dispatcher\.activeTeamBindingSummary/,
      'Team read composition invariant violated: mcp.team.history must add bound_target in admin/methods.ts.',
      '../admin/methods.ts',
    );
  });
});

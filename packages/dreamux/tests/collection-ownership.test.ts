/**
 * Architecture guard: Collections and Services own different things
 * (service/CLAUDE.md "Collections and Services"; minimize-provider-boundaries
 * §4.5 "Service and Collection ownership"):
 *
 *   - A Collection (TeamCollection, TeammateCollection) owns the store, the
 *     factory, lookup/list, the live instances this process holds,
 *     materialization dedupe, and exact-instance eviction.
 *   - A Service (TeamService, TeammateService) owns exactly one entity: its
 *     record, its operations, its runtime, and its close. It publishes a
 *     terminal fact (`onClosed`) and NEVER calls back into its owning
 *     Collection to evict itself — the owner subscribes and evicts on its own
 *     side, so a held/reopened entity can never be evicted out from under a
 *     caller still holding it.
 *
 * These are proven structurally (import-graph + declared-member shape), which
 * the repo's CLAUDE.md sanctions here: for this class of invariant, absence of
 * a call site or an import edge IS the contract, not an implementation detail
 * a behavioral test would exercise more reliably.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

function walkTs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function rel(file: string): string {
  return relative(src, file);
}

const teamServiceFiles = walkTs(join(src, 'service/team-service'));
const teammateServiceFiles = walkTs(join(src, 'service/teammate-service'));

describe('a Service never calls an eviction callback into its owning Collection', () => {
  // The pattern is a CALL site (`.evict(`), not a bare "evict" token: a
  // Service is allowed to use "evict" in its own unrelated vocabulary (e.g.
  // admission-ledger.ts's bounded FIFO window discards a key it calls
  // "evicted" — a completely different data structure with no owning
  // Collection in sight). What must stay absent is a Service actually
  // INVOKING an eviction method on some other object, which is what a reach
  // into its owning Collection would look like.
  it('team-service/** never calls a ".evict(" method (no reach into an owning Collection)', () => {
    const offenders = teamServiceFiles.filter((file) =>
      /\.evict\(/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('teammate-service/** never calls a ".evict(" method (no reach into an owning Collection)', () => {
    const offenders = teammateServiceFiles.filter((file) =>
      /\.evict\(/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('team-service/** never imports the Collection cache/materialization owner', () => {
    // TeamService legitimately shares the TeamRecord/error/store TYPES with
    // team-collection (they are the same domain's persisted shape), so a
    // blanket "no team-collection import" ban would be wrong. What must stay
    // absent is an import of the CACHE OWNER itself
    // (runtime-registry.ts) or the TeamCollection facade (index.ts) — either
    // would let a Service reach back into its owner's live-instance table.
    const forbiddenImport =
      /from\s+['"]\.\.\/team-collection\/(runtime-registry|index)\.js['"]/;
    const offenders = teamServiceFiles.filter((file) =>
      forbiddenImport.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('teammate-service/** never imports the teammate-collection module at all', () => {
    const forbiddenImport = /from\s+['"]\.\.\/teammate-collection\//;
    const offenders = teammateServiceFiles.filter((file) =>
      forbiddenImport.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('TeamService publishes a close FACT (onClosed) rather than owning eviction', () => {
    const indexSrc = readFileSync(join(src, 'service/team-service/index.ts'), 'utf8');
    expect(indexSrc).toMatch(/onClosed\(listener: TeamClosedListener\)/);
  });

  it('TeammateService publishes a close FACT (onClosed) rather than owning eviction', () => {
    const indexSrc = readFileSync(
      join(src, 'service/teammate-service/index.ts'),
      'utf8',
    );
    expect(indexSrc).toMatch(/onClosed\(/);
  });
});

describe('a Collection is the sole eviction owner: it subscribes to onClosed and evicts on its own side', () => {
  it('TeamCollection (runtime-registry.ts) both subscribes to onClosed and owns the private evict()', () => {
    const registrySrc = readFileSync(
      join(src, 'service/team-collection/runtime-registry.ts'),
      'utf8',
    );
    expect(registrySrc).toMatch(/service\.onClosed\(\(\) => this\.evict\(/);
    expect(registrySrc).toMatch(/private evict\(/);
  });

  it('TeammateCollection (index.ts) both subscribes to onClosed and owns eviction', () => {
    const collectionSrc = readFileSync(
      join(src, 'service/teammate-collection/index.ts'),
      'utf8',
    );
    expect(collectionSrc).toMatch(/entity\.onClosed\(/);
    // TeammateCollection's eviction is folded into its close-subscription
    // handler rather than a separate named method, but it must still mutate
    // its OWN live-instance table (`entities`) from inside that handler, not
    // delegate the decision elsewhere.
    expect(collectionSrc).toMatch(/this\.entities\.delete\(/);
  });
});

describe('Collections own the store, the factory, and the materialization cache; Services do not duplicate it', () => {
  it('TeamCollection (runtime-registry.ts) is the sole holder of the live TeamService cache and its construction dedupe', () => {
    const registrySrc = readFileSync(
      join(src, 'service/team-collection/runtime-registry.ts'),
      'utf8',
    );
    expect(registrySrc).toMatch(/private readonly cache = new Map<string, TeamService>/);
    expect(registrySrc).toMatch(
      /private readonly constructing = new Map<string, Promise<TeamService \| null>>/,
    );
  });

  it('TeammateCollection (index.ts) is the sole holder of the live TeammateService cache and its materialization dedupe', () => {
    const collectionSrc = readFileSync(
      join(src, 'service/teammate-collection/index.ts'),
      'utf8',
    );
    expect(collectionSrc).toMatch(
      /private readonly entities = new Map<string, TeammateService>/,
    );
    // The dedupe map resolves to `ResolvedTeamMate`, the union declared in this
    // same file: a materialization answers with the live entity, or with the
    // durable record that already settled it. Both halves are pinned, so the
    // union cannot quietly stop covering the live entity it dedupes.
    expect(collectionSrc).toMatch(
      /type ResolvedTeamMate = TeammateService \| AgentEntityIdentity/,
    );
    expect(collectionSrc).toMatch(
      /private readonly materializations = new Map<string, Promise<ResolvedTeamMate>>/,
    );
  });

  it('no file under team-service/** declares a Map keyed to a TeamService (that cache belongs to the Collection alone)', () => {
    const cacheShape = /Map<\s*string\s*,\s*(Promise<)?TeamService/;
    const offenders = teamServiceFiles.filter((file) =>
      cacheShape.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('no file under teammate-service/** declares a Map keyed to a TeammateService (that cache belongs to the Collection alone)', () => {
    const cacheShape = /Map<\s*string\s*,\s*(Promise<)?TeammateService/;
    const offenders = teammateServiceFiles.filter((file) =>
      cacheShape.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe('WorkflowService is a combined collection+service for workflow runs, not a Collection-owned entity', () => {
  it('has no owning WorkflowCollection to reach into, so its own private evict() is the whole story', () => {
    // Unlike Team/TeamMate, there is no separate "WorkflowCollection" — the
    // service/CLAUDE.md facade list names `TeamService` and `WorkflowService`
    // side by side with no `WorkflowCollection` at all. WorkflowService owning
    // BOTH the live-run cache and its own eviction is therefore correct, not
    // a violation of the Service/Collection split: there is nothing else for
    // it to delegate to.
    const noOwningCollectionDir = walkTs(join(src, 'service/workflow-collection'));
    expect(noOwningCollectionDir).toEqual([]);
    const indexSrc = readFileSync(join(src, 'service/workflow-service/index.ts'), 'utf8');
    expect(indexSrc).toMatch(/private evict\(runId: string, expected: WorkflowRun\)/);
  });
});

describe('domain vocabulary: team.* / teammate.* Commands originate only in their owning Collection', () => {
  // Scoped to ALL of dreamux/src, not just the four Team/TeamMate
  // service/collection dirs: a `name: 'team.foo'` Command declared anywhere
  // else (channel-service, dispatcher-service, ...) would just as much be a
  // Collection violating its ownership of that vocabulary, and a scan
  // narrowed to the "usual suspect" dirs could never catch it appearing
  // somewhere new.
  const allSrcFiles = walkTs(src);

  it('every "team.<x>" Command name is declared in team-collection/commands.ts, nowhere else', () => {
    const pattern = /name:\s*'team\.[a-z_]+'/g;
    const hits = new Map<string, number>();
    for (const file of allSrcFiles) {
      const matches = readFileSync(file, 'utf8').match(pattern) ?? [];
      if (matches.length > 0) hits.set(rel(file), matches.length);
    }
    expect([...hits.keys()]).toEqual(['service/team-collection/commands.ts']);
  });

  it('every "teammate.<x>" Command name is declared in teammate-collection/commands.ts, nowhere else', () => {
    const pattern = /name:\s*'teammate\.[a-z_]+'/g;
    const hits = new Map<string, number>();
    for (const file of allSrcFiles) {
      const matches = readFileSync(file, 'utf8').match(pattern) ?? [];
      if (matches.length > 0) hits.set(rel(file), matches.length);
    }
    expect([...hits.keys()]).toEqual(['service/teammate-collection/commands.ts']);
  });
});

describe('domain vocabulary: Channel/transport modules own no Team or TeamMate policy', () => {
  const channelFiles = [
    ...walkTs(join(src, 'channel')),
    ...walkTs(join(src, 'service/channel-service')),
  ];

  it('Core Channel modules never import team-service, teammate-service, team-collection, or teammate-collection internals', () => {
    // The Channel layer decides WHERE a message goes and says so by naming a
    // Team (service/CLAUDE.md "channel-service/"); it never reaches into a
    // Team/TeamMate owner's internals to implement lifecycle policy itself.
    const forbidden =
      /from\s+['"](\.\.\/)+(team-service|teammate-service|team-collection|teammate-collection)\//;
    const offenders = channelFiles.filter((file) =>
      forbidden.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
});

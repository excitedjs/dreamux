import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

interface MovedDeclaration {
  name: string;
  owner: string;
  implementationImport: './index.js' | './service.js';
}

const MOVED_DECLARATIONS: readonly MovedDeclaration[] = [
  { name: 'TeamAvailability', owner: 'service/team-service/types.ts', implementationImport: './index.js' },
  { name: 'TeamLiveWriter', owner: 'service/team-service/types.ts', implementationImport: './index.js' },
  { name: 'TeamServiceCreateInput', owner: 'service/team-service/types.ts', implementationImport: './index.js' },
  { name: 'TeamSchedulerLifecycle', owner: 'service/team-service/types.ts', implementationImport: './index.js' },
  { name: 'TeamCollectionOptions', owner: 'service/team-collection/types.ts', implementationImport: './index.js' },
  { name: 'TeamMateSharedWorkspace', owner: 'service/teammate-collection/types.ts', implementationImport: './index.js' },
  { name: 'SpawnTeamMateRequest', owner: 'service/teammate-collection/types.ts', implementationImport: './index.js' },
  { name: 'TeammateOps', owner: 'service/teammate-collection/types.ts', implementationImport: './index.js' },
  { name: 'CronCreateRequest', owner: 'service/scheduler/types.ts', implementationImport: './service.js' },
  { name: 'CronUpdateRequest', owner: 'service/scheduler/types.ts', implementationImport: './service.js' },
  { name: 'SchedulerServiceOptions', owner: 'service/scheduler/types.ts', implementationImport: './service.js' },
  { name: 'SchedulerCommands', owner: 'service/scheduler/types.ts', implementationImport: './service.js' },
  { name: 'TeammateServiceDeps', owner: 'service/teammate-service/types.ts', implementationImport: './index.js' },
  { name: 'SettledCompletionRoute', owner: 'service/teammate-service/types.ts', implementationImport: './index.js' },
  { name: 'TeammateServiceOptions', owner: 'service/teammate-service/types.ts', implementationImport: './index.js' },
];

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

function parseSource(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

interface MovedDeclarationScan {
  definitions: Map<string, SourceHit[]>;
  importViolations: SourceHit[];
  compatibilityReexports: SourceHit[];
}

function sourceModulePath(file: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('.')) return null;
  const resolved = resolve(dirname(file), moduleSpecifier);
  return resolved.endsWith('.js')
    ? resolved.slice(0, -'.js'.length) + '.ts'
    : resolved;
}

function sourceHit(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  text = node.getText(sourceFile),
): SourceHit {
  return {
    file: sourceFile.fileName,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    text,
  };
}

function namespaceMovedDeclarations(
  sourceFile: ts.SourceFile,
  namespaceName: string,
): MovedDeclaration[] {
  const declarations = new Map<string, MovedDeclaration>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isQualifiedName(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === namespaceName
    ) {
      const declaration = MOVED_DECLARATIONS.find(
        (candidate) => candidate.name === node.right.text,
      );
      if (declaration !== undefined) declarations.set(declaration.name, declaration);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === namespaceName
    ) {
      const declaration = MOVED_DECLARATIONS.find(
        (candidate) => candidate.name === node.name.text,
      );
      if (declaration !== undefined) declarations.set(declaration.name, declaration);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return [...declarations.values()];
}

function scanMovedDeclarationSource(
  file: string,
  source: string,
): MovedDeclarationScan {
  const sourceFile = parseSource(file, source);
  const movedByName = new Map(
    MOVED_DECLARATIONS.map((declaration) => [declaration.name, declaration]),
  );
  const declarationsByOwner = new Map<string, MovedDeclaration[]>();
  for (const declaration of MOVED_DECLARATIONS) {
    const owner = join(SRC_ROOT, declaration.owner);
    const declarations = declarationsByOwner.get(owner) ?? [];
    declarations.push(declaration);
    declarationsByOwner.set(owner, declarations);
  }
  const definitions = new Map<string, SourceHit[]>();
  const importViolations: SourceHit[] = [];
  const compatibilityReexports: SourceHit[] = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      movedByName.has(statement.name.text)
    ) {
      const name = statement.name.text;
      const hits = definitions.get(name) ?? [];
      hits.push(sourceHit(sourceFile, statement.name, name));
      definitions.set(name, hits);
    }

    if (ts.isImportDeclaration(statement)) {
      const importClause = statement.importClause;
      if (
        importClause === undefined ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const importedFile = sourceModulePath(
        file,
        statement.moduleSpecifier.text,
      );
      const namedBindings = importClause.namedBindings;
      if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
        for (const specifier of namedBindings.elements) {
          const importedName = (specifier.propertyName ?? specifier.name).text;
          const declaration = movedByName.get(importedName);
          if (declaration === undefined) continue;
          const expectedOwner = join(SRC_ROOT, declaration.owner);
          if (
            importedFile !== expectedOwner ||
            (!importClause.isTypeOnly && !specifier.isTypeOnly)
          ) {
            importViolations.push(sourceHit(sourceFile, specifier));
          }
        }
      } else if (
        namedBindings !== undefined &&
        ts.isNamespaceImport(namedBindings)
      ) {
        const referencedDeclarations = namespaceMovedDeclarations(
          sourceFile,
          namedBindings.name.text,
        );
        const ownerDeclarations =
          importedFile === null
            ? []
            : declarationsByOwner.get(importedFile) ?? [];
        const relevantDeclarations = new Map(
          [...referencedDeclarations, ...ownerDeclarations].map((declaration) => [
            declaration.name,
            declaration,
          ]),
        );
        for (const declaration of relevantDeclarations.values()) {
          if (
            importedFile !== join(SRC_ROOT, declaration.owner) ||
            !importClause.isTypeOnly
          ) {
            importViolations.push(
              sourceHit(
                sourceFile,
                namedBindings,
                `${namedBindings.getText(sourceFile)} (${declaration.name})`,
              ),
            );
          }
        }
      }
    }

    if (!ts.isExportDeclaration(statement)) continue;
    const exportClause = statement.exportClause;
    if (exportClause !== undefined && ts.isNamedExports(exportClause)) {
      for (const specifier of exportClause.elements) {
        const exportedName = (specifier.propertyName ?? specifier.name).text;
        if (movedByName.has(exportedName)) {
          compatibilityReexports.push(sourceHit(sourceFile, specifier));
        }
      }
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (
      moduleSpecifier !== undefined &&
      ts.isStringLiteral(moduleSpecifier) &&
      declarationsByOwner.has(
        sourceModulePath(file, moduleSpecifier.text) ?? '',
      )
    ) {
      compatibilityReexports.push(sourceHit(sourceFile, statement));
    }
  }

  return { definitions, importViolations, compatibilityReexports };
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
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    await mkdir(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps extracted service contracts single-owned and type-only at every consumer', async () => {
    const definitions = new Map<string, SourceHit[]>();
    const importViolations: SourceHit[] = [];
    const compatibilityReexports: SourceHit[] = [];
    const files = await sourceFilesUnder(SRC_ROOT);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const scan = scanMovedDeclarationSource(file, source);
      for (const [name, hits] of scan.definitions) {
        definitions.set(name, [...(definitions.get(name) ?? []), ...hits]);
      }
      importViolations.push(...scan.importViolations);
      compatibilityReexports.push(...scan.compatibilityReexports);
    }

    for (const declaration of MOVED_DECLARATIONS) {
      const hits = definitions.get(declaration.name) ?? [];
      const expectedOwner = join(SRC_ROOT, declaration.owner);
      if (hits.length !== 1 || hits[0]?.file !== expectedOwner) {
        failInvariant(
          'Extracted service contract ownership invariant violated: each moved declaration must have exactly one owner-local definition.',
          `${declaration.name} expected at ${packagePath(expectedOwner)}; found:\n${formatHits(hits) || '(none)'}`,
        );
      }
    }
    assertNoHits(
      'Extracted service contract import invariant violated: moved declarations must be imported type-only and directly from their owner.',
      importViolations,
    );
    assertNoHits(
      'Extracted service contract export invariant violated: moved declarations must not have compatibility re-exports.',
      compatibilityReexports,
    );

    for (const owner of new Set(
      MOVED_DECLARATIONS.map((declaration) => declaration.owner),
    )) {
      const declaration = MOVED_DECLARATIONS.find(
        (candidate) => candidate.owner === owner,
      );
      if (declaration === undefined) continue;
      const file = join(SRC_ROOT, owner);
      const sourceFile = parseSource(file, await readFile(file, 'utf8'));
      const reverseImport = sourceFile.statements.find((statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === declaration.implementationImport,
      );
      if (reverseImport !== undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(
          reverseImport.getStart(sourceFile),
        ).line + 1;
        failInvariant(
          'Extracted service contract layering invariant violated: a type owner must not import its corresponding implementation.',
          `${packagePath(file)}:${line}: ${reverseImport.getText(sourceFile)}`,
        );
      }
    }
  });

  it('detects duplicate definitions and invalid access to moved contracts', () => {
    const fixture = join(SRC_ROOT, 'service/fixture/consumer.ts');
    const duplicateDefinitions = scanMovedDeclarationSource(
      join(SRC_ROOT, 'service/scheduler/types.ts'),
      'export interface SchedulerCommands {}\nexport interface SchedulerCommands {}\n',
    );
    expect(
      duplicateDefinitions.definitions.get('SchedulerCommands'),
    ).toHaveLength(2);

    const directNamespace = scanMovedDeclarationSource(
      fixture,
      "import * as Contracts from '../scheduler/types.js';\ntype Commands = Contracts.SchedulerCommands;\n",
    );
    expect(directNamespace.importViolations).toHaveLength(4);

    const indirectImports = scanMovedDeclarationSource(
      fixture,
      "import type * as Contracts from '../scheduler/service.js';\nimport type { SchedulerCommands } from '../scheduler/service.js';\ntype Commands = Contracts.SchedulerCommands;\n",
    );
    expect(indirectImports.importViolations).toHaveLength(2);

    const compatibilityReexport = scanMovedDeclarationSource(
      join(SRC_ROOT, 'service/scheduler/service.ts'),
      "export type { SchedulerCommands } from './types.js';\n",
    );
    expect(compatibilityReexport.compatibilityReexports).toHaveLength(1);

    const validNamespace = scanMovedDeclarationSource(
      fixture,
      "import type * as Contracts from '../scheduler/types.js';\ntype Commands = Contracts.SchedulerCommands;\n",
    );
    expect(validNamespace.importViolations).toEqual([]);
  });

  it('keeps Team dissolve settlement and generation authority in its controller', async () => {
    const controller = await readServiceSource(
      'team-collection/dissolve-controller.ts',
    );
    const runner = await readServiceSource('team-collection/dissolve-runner.ts');
    expect(runner).not.toMatch(
      /operation\.logical\.(?:resolve|reject)\s*\(/,
    );
    expect(runner).not.toMatch(/\.operations\.delete\s*\(/);
    expect(runner).not.toMatch(/operation_id\s*(?:===|!==)/);
    assertContains(
      controller,
      /private async loadCurrentOperation\s*\(/,
      'Team dissolve ownership invariant violated: current-operation generation checks must stay in TeamDissolveController.',
      'team-collection/dissolve-controller.ts',
    );
    for (const operation of [
      'failOpen',
      'markLogicalClosed',
      'finishClosed',
      'suspend',
    ]) {
      assertContains(
        controller,
        new RegExp(`private (?:async )?${operation}\\s*\\(`),
        `Team dissolve ownership invariant violated: ${operation} settlement must stay in TeamDissolveController.`,
        'team-collection/dissolve-controller.ts',
      );
    }
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

  it('exposes scheduler commands without leaking owner lifecycle verbs', async () => {
    const dispatcherSource = await readServiceSource('dispatcher-service/index.ts');
    const teamHandleSource = await readServiceSource(
      'dispatcher-service/team-leader-handle.ts',
    );
    const teamSource = await readServiceSource('team-service/index.ts');
    const adminSource = await readSource('admin/methods.ts');
    assertContains(
      teamHandleSource,
      /export interface TeamLeaderHandle\s*\{[\s\S]*spawnTeamMate/,
      'scheduler command invariant violated: DispatcherService must expose a narrow TeamLeaderHandle instead of concrete TeamService.',
      'dispatcher-service/team-leader-handle.ts',
    );
    const teamLeaderOps = teamHandleSource.match(
      /export interface TeamLeaderTeammateOps\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    if (teamLeaderOps === undefined || /\bspawn\b/.test(teamLeaderOps)) {
      failInvariant(
        'scheduler command invariant violated: TeamLeaderHandle teammate ops must not expose raw spawn.',
        'Offending file: /packages/dreamux/src/service/dispatcher-service/team-leader-handle.ts',
      );
    }
    assertContains(
      teamHandleSource,
      /withMutationService:\s*<T>\([\s\S]*lease:\s*TeamLeaderLease[\s\S]*task:\s*\(service:\s*TeamService\)\s*=>\s*Promise<T>/,
      'scheduler command invariant violated: TeamLeaderHandle mutations must route through an available Team generation lease.',
      'dispatcher-service/team-leader-handle.ts',
    );
    assertContains(
      teamHandleSource,
      /withReadService:\s*<T>\([\s\S]*lease:\s*TeamLeaderLease[\s\S]*task:\s*\(service:\s*TeamService\)\s*=>\s*Promise<T>/,
      'scheduler command invariant violated: TeamLeaderHandle reads must route through a Team generation lease.',
      'dispatcher-service/team-leader-handle.ts',
    );
    assertContains(
      dispatcherSource,
      /team\(teamId: string\): Promise<TeamLeaderHandle>/,
      'scheduler command invariant violated: DispatcherService.team() must not return concrete TeamService.',
      'dispatcher-service/index.ts',
    );
    assertContains(
      dispatcherSource,
      /lease: await this\.teams\.teamLeaderReadLease\(teamId\)/,
      'scheduler command invariant violated: DispatcherService.team() must bind TeamLeaderHandle to a read-safe Team generation lease.',
      'dispatcher-service/index.ts',
    );
    assertContains(
      dispatcherSource,
      /get scheduler\(\): SchedulerCommands\s*\{\s*return this\.scheduler_\.commands;/,
      'scheduler command invariant violated: DispatcherService must expose SchedulerCommands, not concrete SchedulerService lifecycle verbs.',
      'dispatcher-service/index.ts',
    );
    assertContains(
      teamSource,
      /get scheduler\(\): SchedulerCommands\s*\{\s*return this\.schedulerCommands;/,
      'scheduler command invariant violated: TeamService must expose availability-gated SchedulerCommands, not concrete SchedulerService lifecycle verbs.',
      'team-service/index.ts',
    );
    if (/\b(?:start|stop)Scheduler\s*\(/.test(teamSource)) {
      failInvariant(
        'scheduler command invariant violated: TeamService must not expose scheduler lifecycle wrapper methods.',
        'Offending file: /packages/dreamux/src/service/team-service/index.ts',
      );
    }
    if (/this\.schedulerLifecycle|private readonly schedulerLifecycle/.test(teamSource)) {
      failInvariant(
        'scheduler command invariant violated: TeamService instances must not retain scheduler lifecycle capability fields.',
        'Offending file: /packages/dreamux/src/service/team-service/index.ts',
      );
    }
    if (/service\/team-service\/index/.test(adminSource)) {
      failInvariant(
        'scheduler command invariant violated: admin methods must target TeamLeaderHandle, not concrete TeamService.',
        'Offending file: /packages/dreamux/src/admin/methods.ts',
      );
    }
    if (/SchedulerService/.test(adminSource) || !/Promise<SchedulerCommands>/.test(adminSource)) {
      failInvariant(
        'scheduler command invariant violated: admin cron target must depend on SchedulerCommands only.',
        'Offending file: /packages/dreamux/src/admin/methods.ts',
      );
    }
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
    const identities = new AgentIdentityStore(log);
    const turnsStore = new AgentTurnsStore(log);
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
    const identities = new AgentIdentityStore(log);
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
    const teamMethodParams = await readSource('admin/team-method-params.ts');
    assertContains(
      teamMethodParams,
      /async function teamBindingFields[\s\S]*dispatcher\.activeTeamBindingSummaries[\s\S]*bound_target:\s*bound_targets\[0\]\s*\?\?\s*null[\s\S]*bound_targets/,
      'Team read composition invariant violated: admin/team-method-params.ts must derive compatible bound_target and complete bound_targets from the plural ChannelService projection.',
      '../admin/team-method-params.ts',
    );
    assertContains(
      adminMethods,
      /'team\.list'[\s\S]*teamBindingFields\(dispatcher, team\)/,
      'Team read composition invariant violated: team.list must add binding fields in admin/methods.ts.',
      '../admin/methods.ts',
    );
    assertContains(
      adminMethods,
      /'team\.status'[\s\S]*teamBindingFields\(dispatcher, summary\.team\)/,
      'Team read composition invariant violated: team.status must add binding fields in admin/methods.ts.',
      '../admin/methods.ts',
    );
    assertContains(
      adminMethods,
      /'team\.history'[\s\S]*teamBindingFields\(dispatcher, team\)/,
      'Team read composition invariant violated: team.history must add binding fields in admin/methods.ts.',
      '../admin/methods.ts',
    );
  });
});

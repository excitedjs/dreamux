/**
 * Value-keyed submission/completion contract lock (task
 * `restore-value-keyed-turn-contract`).
 *
 * `@excitedjs/dreamux-types` is declaration-only: its types are erased before any
 * test runs, so this file locks the contract three ways, following the
 * techniques already established by `tests/root-exports.test.ts` and
 * `tests/no-host-types.test.ts`:
 *
 * 1. Source-text/manifest assertions over `src/` — the root export surface must
 *    name the value-keyed contract types, and the removed `RuntimeTurn` /
 *    `RuntimeTurnOutcome` names must be gone (asserted as an ABSENCE so they
 *    cannot silently return).
 * 2. Compile-time assignability probes (`expectAssignable<T>(…)` plus negative
 *    `@ts-expect-error` cases). These are erased by the vitest transform, so a
 *    dedicated test re-runs the TypeScript program over THIS file and asserts
 *    zero diagnostics — which also fails on TS2578 ("unused
 *    '@ts-expect-error' directive") the moment one of the negatives stops being
 *    an error. That is what makes the probes below load-bearing under
 *    `vitest run`, not just under `npm run typecheck`.
 * 3. A complete external Agent Runtime provider authored against
 *    `@excitedjs/dreamux-types` ONLY (never `@excitedjs/dreamux`), exercised at runtime
 *    to prove a folded pair of submissions shares ONE `Object.is`-identical,
 *    frozen completion token while a queued pair does not.
 *
 * Note on scope: the coverage matrix suggested extending
 * `tests/fixtures/external-provider.ts`, but this task's write boundary allows
 * exactly one file, so the external provider lives here instead. It keeps the
 * fixture's import discipline (root-only, type-only imports).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeProviderFactory,
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTranscriptPage,
  ChannelTurnSettledEvent,
  ChannelTurnToolCallEvent,
  InboundTurnInput,
  JsonValue,
  RuntimeActivity,
  RuntimeActivityEvent,
  RuntimeActivitySink,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
  RuntimeToolAction,
} from '@excitedjs/dreamux-types';

const selfFile = fileURLToPath(import.meta.url);
const here = dirname(selfFile);
const pkgRoot = join(here, '..');
const srcDir = join(pkgRoot, 'src');

// ---------------------------------------------------------------------------
// Source-text helpers (same technique as root-exports.test.ts).
// ---------------------------------------------------------------------------

/** Names re-exported by every `export type { … } from '…'` block in the root. */
function rootExportNames(): Set<string> {
  const source = readFileSync(join(srcDir, 'index.ts'), 'utf8');
  const names = new Set<string>();
  const block = /export\s+type\s+\{([^}]*)\}\s+from/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(source)) !== null) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim();
      if (name !== '') names.add(name);
    }
  }
  return names;
}

function srcFiles(): string[] {
  return readdirSync(srcDir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(srcDir, file));
}

const agentRuntimeSource = readFileSync(join(srcDir, 'agent-runtime.ts'), 'utf8');

/**
 * Slice one top-level `export type`/`export interface` declaration out of
 * `src/agent-runtime.ts`: from its `export` keyword up to the next top-level
 * `export`/doc-comment. Brace-naive on purpose — it only has to isolate one
 * declaration so the assertions below read its literal members.
 */
function declarationText(name: string): string {
  const start = agentRuntimeSource.search(
    new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`),
  );
  expect(start, `declaration ${name} not found in src/agent-runtime.ts`).toBeGreaterThanOrEqual(0);
  const rest = agentRuntimeSource.slice(start + 1);
  const endMatch = /\n(?:export\s|\/\*\*)/.exec(rest);
  return rest.slice(0, endMatch === null ? undefined : endMatch.index);
}

/** Every `<key>: '<literal>'` value used as a discriminant in a declaration. */
function discriminantLiterals(declaration: string, key: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`${key}\\s*:\\s*((?:'[^']*'\\s*\\|\\s*)*'[^']*')`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(declaration)) !== null) {
    for (const literal of match[1].split('|')) {
      found.add(literal.trim().replaceAll("'", ''));
    }
  }
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// External Agent Runtime provider, authored against @excitedjs/dreamux-types only.
// ---------------------------------------------------------------------------

interface ExternalRuntimeConfig {
  model: string;
}

interface PendingSubmission {
  readonly submission: RuntimeSubmission;
  settle(settlement: RuntimeSubmissionSettlement): void;
}

function createPendingSubmission(): PendingSubmission {
  let resolve!: (settlement: RuntimeSubmissionSettlement) => void;
  const settled = new Promise<RuntimeSubmissionSettlement>((r) => {
    resolve = r;
  });
  let done = false;
  return {
    submission: { settled },
    settle(settlement: RuntimeSubmissionSettlement): void {
      if (done) return;
      done = true;
      resolve(settlement);
    },
  };
}

const FIXTURE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

/**
 * A provider whose native engine folds every submission accepted while one
 * native turn is open. The fold window is closed explicitly by the test through
 * {@link ExternalFixtureRuntime.completeNativeTurn} / `failNativeTurn`, which
 * stands in for the engine reporting a result.
 */
class ExternalFixtureRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/external-runtime';
  readonly model: string;
  private status: AgentRuntimeStatus = 'declared';
  private readonly activitySink: RuntimeActivitySink;
  private readonly checkpoint: AgentRuntimeResumeCheckpoint | null;
  private openWindow: PendingSubmission[] = [];
  private clock = 0;

  constructor(context: AgentRuntimeCreateContext<ExternalRuntimeConfig>) {
    this.activitySink = context.activitySink;
    this.model = context.config.model;
    this.checkpoint = context.identity.checkpoint;
  }

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopping';
    for (const pending of this.openWindow.splice(0)) {
      pending.settle({ kind: 'stopped' });
    }
    this.status = 'stopped';
  }

  channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    return this.admit(input.text);
  }

  completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return this.admit(input.text);
  }

  async waitIdle(): Promise<void> {
    while (this.openWindow.length > 0) await Promise.resolve();
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): AgentRuntimeResumeCheckpoint | null {
    return this.checkpoint;
  }

  wasCheckpointResumed(): boolean {
    return this.checkpoint !== null;
  }

  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return { usedTokens: 12, windowTokens: 200_000 };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return FIXTURE_CAPABILITIES;
  }

  /** Number of submissions currently folded into the open native turn. */
  foldedCount(): number {
    return this.openWindow.length;
  }

  /** Close the open fold window with one frozen `completed` completion token. */
  completeNativeTurn(resultText: string | null): RuntimeCompletion {
    return this.closeWindow((displaySubmission) =>
      Object.freeze<RuntimeCompletion>({
        status: 'completed',
        displaySubmission,
        resultText,
        truncated: false,
      }),
    );
  }

  /** Close the open fold window with one frozen `failed` completion token. */
  failNativeTurn(error: Error): RuntimeCompletion {
    return this.closeWindow((displaySubmission) =>
      Object.freeze<RuntimeCompletion>({
        status: 'failed',
        displaySubmission,
        error,
      }),
    );
  }

  private async admit(text: string): Promise<RuntimeAdmission> {
    if (this.status === 'stopping' || this.status === 'stopped') {
      return { status: 'stopped' };
    }
    if (text === '') return { status: 'skipped' };
    const pending = createPendingSubmission();
    this.openWindow.push(pending);
    return { status: 'submitted', submission: pending.submission };
  }

  private closeWindow(
    mint: (displaySubmission: RuntimeSubmission) => RuntimeCompletion,
  ): RuntimeCompletion {
    const window = this.openWindow.splice(0);
    if (window.length === 0) throw new Error('no open native turn');
    // The FIRST submission of the fold window owns the display position.
    const displaySubmission = window[0].submission;
    this.emitToolCall(displaySubmission);
    const completion = mint(displaySubmission);
    if (completion.status === 'completed' && completion.resultText !== null) {
      this.emit(displaySubmission, {
        kind: 'assistant.message',
        id: `msg-${(this.clock += 1)}`,
        text: completion.resultText,
        truncated: completion.truncated,
      });
    }
    // Every folded submission settles with the SAME completion token.
    for (const pending of window) {
      pending.settle({ kind: 'completion', completion });
    }
    return completion;
  }

  private emitToolCall(submission: RuntimeSubmission): string {
    const callId = `call-${(this.clock += 1)}`;
    this.emit(submission, {
      kind: 'tool.call',
      id: `${callId}#start`,
      callId,
      toolName: 'read_file',
      action: 'read',
      status: 'started',
      arguments: { path: '/tmp/fixture.txt' },
      result: null,
      error: null,
    });
    this.emit(submission, {
      kind: 'tool.call',
      id: `${callId}#end`,
      callId,
      toolName: 'read_file',
      action: 'read',
      status: 'completed',
      arguments: null,
      result: { bytes: 42 },
      error: null,
    });
    return callId;
  }

  private emit(submission: RuntimeSubmission, activity: RuntimeActivity): void {
    this.activitySink({
      submission,
      activity,
      occurredAt: 1_700_000_000_000 + (this.clock += 1),
    });
  }
}

const externalRuntimeDescriptor: AgentRuntimeProviderDescriptor = {
  id: 'external-runtime',
  kind: 'agentRuntime',
  ref: {
    source: 'npm',
    package: '@example/external-runtime',
    export: null,
    raw: 'npm:@example/external-runtime',
  },
};

const externalRuntimeProvider: AgentRuntimeProvider<ExternalRuntimeConfig> = {
  ref: 'npm:@example/external-runtime',
  descriptor: externalRuntimeDescriptor,
  getCapabilities(): AgentRuntimeCapabilities {
    return FIXTURE_CAPABILITIES;
  },
  readConfig(rawConfig): ExternalRuntimeConfig {
    return {
      model: typeof rawConfig.model === 'string' ? rawConfig.model : 'default',
    };
  },
  async readTranscript(): Promise<AgentRuntimeTranscriptPage> {
    return { turns: [], nextCursor: null, truncated: false };
  },
  createRuntime(context): AgentRuntime {
    return new ExternalFixtureRuntime(context);
  },
};

const externalRuntimeFactory: AgentRuntimeProviderFactory<ExternalRuntimeConfig> = (
  context,
) => ({ ...externalRuntimeProvider, descriptor: context.descriptor });

function createContext(
  activitySink: RuntimeActivitySink,
): AgentRuntimeCreateContext<ExternalRuntimeConfig> {
  return {
    identity: { runtime_id: 'rt-1', checkpoint: null },
    config: { model: 'fixture-model' },
    cwd: '/tmp/fixture',
    mcpServers: [],
    activitySink,
  };
}

function createExternalRuntime(): {
  runtime: ExternalFixtureRuntime;
  events: RuntimeActivityEvent[];
} {
  const events: RuntimeActivityEvent[] = [];
  const runtime = new ExternalFixtureRuntime(
    createContext((event) => {
      events.push(event);
    }),
  );
  return { runtime, events };
}

function expectSubmitted(admission: RuntimeAdmission): RuntimeSubmission {
  if (admission.status !== 'submitted') {
    throw new Error(`expected a submitted admission, got '${admission.status}'`);
  }
  return admission.submission;
}

function expectCompletion(
  settlement: RuntimeSubmissionSettlement,
): RuntimeCompletion {
  if (settlement.kind !== 'completion') {
    throw new Error(`expected a completion settlement, got '${settlement.kind}'`);
  }
  return settlement.completion;
}

// ---------------------------------------------------------------------------
// Compile-time assignability probes. Erased at runtime; enforced by the
// "tsc reports no diagnostics" test below (including TS2578 on a negative that
// stops erroring).
// ---------------------------------------------------------------------------

/** Compile-time assignability probe: `T` must accept `value`. */
function expectAssignable<T>(value: T): T {
  return value;
}

const probeSubmission: RuntimeSubmission = {
  settled: Promise.resolve<RuntimeSubmissionSettlement>({ kind: 'stopped' }),
};

// RuntimeCompletion — 'completed' arm requires displaySubmission + resultText + truncated.
expectAssignable<RuntimeCompletion>({
  status: 'completed',
  displaySubmission: probeSubmission,
  resultText: 'done',
  truncated: false,
});
expectAssignable<RuntimeCompletion>({
  status: 'completed',
  displaySubmission: probeSubmission,
  resultText: null,
  truncated: true,
});
expectAssignable<RuntimeCompletion>(
  // @ts-expect-error a 'completed' completion must carry `truncated`
  { status: 'completed', displaySubmission: probeSubmission, resultText: 'x' },
);
expectAssignable<RuntimeCompletion>(
  // @ts-expect-error a 'completed' completion must carry `resultText`
  { status: 'completed', displaySubmission: probeSubmission, truncated: false },
);
expectAssignable<RuntimeCompletion>(
  // @ts-expect-error a 'completed' completion must carry `displaySubmission`
  { status: 'completed', resultText: 'x', truncated: false },
);

// RuntimeCompletion — 'failed' arm requires displaySubmission + error.
expectAssignable<RuntimeCompletion>({
  status: 'failed',
  displaySubmission: probeSubmission,
  error: new Error('native failure'),
});
expectAssignable<RuntimeCompletion>(
  // @ts-expect-error a 'failed' completion must carry `error`
  { status: 'failed', displaySubmission: probeSubmission },
);
expectAssignable<RuntimeCompletion>(
  // @ts-expect-error a 'failed' completion must carry `displaySubmission`
  { status: 'failed', error: new Error('native failure') },
);
expectAssignable<RuntimeCompletion>({
  status: 'failed',
  displaySubmission: probeSubmission,
  error: new Error('native failure'),
  // @ts-expect-error the 'failed' completion arm carries no `resultText`
  resultText: null,
});

const probeCompletion: RuntimeCompletion = {
  status: 'completed',
  displaySubmission: probeSubmission,
  resultText: 'done',
  truncated: false,
};

// RuntimeSubmissionSettlement — exactly three arms; only 'completion' carries one.
expectAssignable<RuntimeSubmissionSettlement>({
  kind: 'completion',
  completion: probeCompletion,
});
expectAssignable<RuntimeSubmissionSettlement>({
  kind: 'failed',
  error: new Error('pre-completion failure'),
});
expectAssignable<RuntimeSubmissionSettlement>({ kind: 'stopped' });
expectAssignable<RuntimeSubmissionSettlement>({
  kind: 'stopped',
  // @ts-expect-error the 'stopped' settlement arm carries no `completion`
  completion: probeCompletion,
});
expectAssignable<RuntimeSubmissionSettlement>({
  kind: 'failed',
  error: new Error('pre-completion failure'),
  // @ts-expect-error the 'failed' settlement arm carries no `completion`
  completion: probeCompletion,
});
expectAssignable<RuntimeSubmissionSettlement>(
  // @ts-expect-error 'completed' is not a settlement kind ('completion' is)
  { kind: 'completed', completion: probeCompletion },
);

// RuntimeAdmission — the 'submitted' arm carries `submission`, never `turn`.
expectAssignable<RuntimeAdmission>({
  status: 'submitted',
  submission: probeSubmission,
});
expectAssignable<RuntimeAdmission>({
  status: 'submitted',
  submission: probeSubmission,
  // @ts-expect-error the removed `turn` property is rejected by the submitted arm
  turn: probeSubmission,
});
expectAssignable<RuntimeAdmission>(
  // @ts-expect-error a submitted admission must carry `submission`
  { status: 'submitted' },
);

// AgentRuntimeCreateContext — `activitySink` is required.
expectAssignable<AgentRuntimeCreateContext<ExternalRuntimeConfig>>({
  identity: { runtime_id: 'rt-probe', checkpoint: null },
  config: { model: 'probe' },
  cwd: '/tmp/probe',
  mcpServers: [],
  activitySink: () => {},
});
expectAssignable<AgentRuntimeCreateContext<ExternalRuntimeConfig>>(
  // @ts-expect-error `activitySink` is required on the create context
  {
    identity: { runtime_id: 'rt-probe', checkpoint: null },
    config: { model: 'probe' },
    cwd: '/tmp/probe',
    mcpServers: [],
  },
);

// RuntimeActivity / RuntimeActivityEvent / RuntimeActivitySink / JsonValue.
expectAssignable<RuntimeActivity>({
  kind: 'assistant.message',
  id: 'm1',
  text: 'hi',
  truncated: false,
});
expectAssignable<RuntimeActivity>(
  // @ts-expect-error a 'tool.call' activity must carry `callId`
  {
    kind: 'tool.call',
    id: 't1',
    toolName: 'read_file',
    action: null,
    status: 'started',
    arguments: null,
    result: null,
    error: null,
  },
);
expectAssignable<RuntimeActivity>({
  kind: 'tool.call',
  id: 't2',
  callId: 'call-2',
  toolName: 'unknown_provider_tool',
  action: null,
  status: 'started',
  arguments: null,
  result: null,
  error: null,
});
expectAssignable<RuntimeActivity>(
  // @ts-expect-error a 'tool.call' activity must carry nullable `action`
  {
    kind: 'tool.call',
    id: 't3',
    callId: 'call-3',
    toolName: 'read_file',
    status: 'started',
    arguments: null,
    result: null,
    error: null,
  },
);
expectAssignable<RuntimeActivityEvent>({
  submission: probeSubmission,
  activity: { kind: 'assistant.message', id: 'm1', text: 'hi', truncated: false },
  occurredAt: 1,
});
expectAssignable<RuntimeToolAction>('list_files');
expectAssignable<ChannelTurnToolCallEvent>({
  schema_version: 1,
  kind: 'turn.tool_call',
  occurred_at: 1,
  team_name: null,
  agent_name: 'dispatcher',
  role: 'dispatcher',
  turn_id: 'turn-1',
  event_id: 'event-1',
  call_id: 'call-1',
  tool_name: 'provider.tool',
  tool_action: null,
  status: 'started',
  arguments_json: null,
  result_json: null,
  arguments_truncated: false,
  result_truncated: false,
  redacted: false,
});
expectAssignable<ChannelTurnSettledEvent>({
  schema_version: 1,
  kind: 'turn.settled',
  occurred_at: 1,
  team_name: null,
  agent_name: 'dispatcher',
  role: 'dispatcher',
  turn_id: 'turn-1',
  status: 'completed',
  assistant: 'done',
  assistant_truncated: false,
  redacted: true,
});
for (const status of ['completed', 'failed', 'stopped'] as const) {
  expectAssignable<ChannelTurnSettledEvent>({
    schema_version: 1,
    kind: 'turn.settled',
    occurred_at: 1,
    team_name: 'team-a',
    agent_name: 'leader',
    role: 'team_leader',
    turn_id: 'turn-2',
    status,
    assistant: null,
    assistant_truncated: false,
    redacted: false,
  });
}
expectAssignable<ChannelTurnSettledEvent>({
  schema_version: 1,
  kind: 'turn.settled',
  occurred_at: 1,
  team_name: 'team-a',
  agent_name: 'member',
  role: 'team_member',
  turn_id: 'turn-3',
  status: 'stopped',
  assistant: null,
  assistant_truncated: false,
  redacted: false,
});
expectAssignable<RuntimeActivitySink>((event: RuntimeActivityEvent) => {
  void event.submission.settled;
});
expectAssignable<JsonValue>({ a: [1, 'two', null, { b: true }] });
expectAssignable<JsonValue>(
  // @ts-expect-error a function is not a JsonValue
  () => 'nope',
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const REQUIRED_ROOT_EXPORTS = [
  'JsonValue',
  'RuntimeActivity',
  'RuntimeActivityEvent',
  'RuntimeActivitySink',
  'RuntimeAdmission',
  'RuntimeCompletion',
  'RuntimeSubmission',
  'RuntimeSubmissionSettlement',
  'RuntimeToolAction',
] as const;

const REMOVED_NAMES = ['RuntimeTurn', 'RuntimeTurnOutcome'] as const;

describe('value-keyed runtime contract: root export surface', () => {
  for (const name of REQUIRED_ROOT_EXPORTS) {
    it(`given the package root, '${name}' is exported so an external provider can name it`, () => {
      expect([...rootExportNames()]).toContain(name);
    });
  }

  it('given the package root, every value-keyed contract type is declared in src/agent-runtime.ts', () => {
    for (const name of REQUIRED_ROOT_EXPORTS) {
      expect(
        new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`).test(
          agentRuntimeSource,
        ),
        `${name} must be declared in src/agent-runtime.ts`,
      ).toBe(true);
    }
  });
});

describe('value-keyed runtime contract: removed turn-keyed names stay removed', () => {
  for (const name of REMOVED_NAMES) {
    it(`given the package root, '${name}' is absent from the public export surface`, () => {
      expect([...rootExportNames()]).not.toContain(name);
    });

    it(`given src/, no module declares or references '${name}'`, () => {
      const wholeWord = new RegExp(`\\b${name}\\b`);
      const offenders = srcFiles().filter((file) =>
        wholeWord.test(readFileSync(file, 'utf8')),
      );
      expect(offenders).toEqual([]);
    });
  }
});

describe('value-keyed runtime contract: declared shapes', () => {
  it('given RuntimeSubmissionSettlement, its arms are exactly completion | failed | stopped', () => {
    const declaration = declarationText('RuntimeSubmissionSettlement');
    expect(discriminantLiterals(declaration, 'kind')).toEqual([
      'completion',
      'failed',
      'stopped',
    ]);
  });

  it('given RuntimeSubmissionSettlement, only the completion arm names a completion', () => {
    const arms = declarationText('RuntimeSubmissionSettlement')
      .split('|')
      .map((arm) => arm.trim())
      .filter((arm) => arm.startsWith('{'));
    expect(arms).toHaveLength(3);
    for (const arm of arms) {
      const carriesCompletion = /\bcompletion\s*:/.test(arm);
      expect(carriesCompletion).toBe(arm.includes("'completion'"));
    }
  });

  it('given RuntimeCompletion, its arms are exactly completed | failed and both name a displaySubmission', () => {
    const declaration = declarationText('RuntimeCompletion');
    expect(discriminantLiterals(declaration, 'status')).toEqual([
      'completed',
      'failed',
    ]);
    expect(
      declaration.match(/displaySubmission\s*:\s*RuntimeSubmission/g),
    ).toHaveLength(2);
  });

  it("given RuntimeAdmission, the 'submitted' arm names `submission` and no longer names `turn`", () => {
    const declaration = declarationText('RuntimeAdmission');
    expect(discriminantLiterals(declaration, 'status')).toEqual([
      'ambiguous',
      'duplicate',
      'failed',
      'skipped',
      'stopped',
      'submitted',
    ]);
    const submittedArm = declaration
      .split('|')
      .map((arm) => arm.trim())
      .find((arm) => arm.includes("'submitted'"));
    expect(submittedArm).toMatch(/submission\s*:\s*RuntimeSubmission/);
    expect(submittedArm).not.toMatch(/\bturn\s*:/);
  });

  it('given AgentRuntimeCreateContext, activitySink is declared required (no `?`)', () => {
    const declaration = declarationText('AgentRuntimeCreateContext');
    expect(declaration).toMatch(/\n\s*activitySink:\s*RuntimeActivitySink;/);
    expect(declaration).not.toMatch(/activitySink\?/);
  });
});

describe('value-keyed runtime contract: compile-time probes', () => {
  it('given the assignability probes in this file, tsc reports no diagnostics (every @ts-expect-error is load-bearing)', () => {
    const configFile = ts.readConfigFile(
      join(pkgRoot, 'tsconfig.tests.json'),
      ts.sys.readFile,
    );
    expect(configFile.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      pkgRoot,
    );
    expect(parsed.errors).toEqual([]);
    const program = ts.createProgram({
      rootNames: [selfFile],
      options: { ...parsed.options, noEmit: true },
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === selfFile);
    expect(
      diagnostics.map((diagnostic) =>
        ts.formatDiagnostic(diagnostic, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => pkgRoot,
          getNewLine: () => '\n',
        }),
      ),
    ).toEqual([]);
  }, 120_000);
});

describe('external provider authored against @excitedjs/dreamux-types only', () => {
  it('given the seed descriptor, the factory returns a provider narrowed to the agentRuntime kind', async () => {
    const provider = await externalRuntimeFactory({
      ref: 'npm:@example/external-runtime',
      descriptor: externalRuntimeDescriptor,
    });
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.descriptor).toBe(externalRuntimeDescriptor);
    expect(provider.getCapabilities().resume.supported).toBe(false);
    await expect(
      provider.readTranscript(
        { turns: 1 },
        {
          checkpoint: null,
          config: { model: 'fixture-model' },
          cwd: '/tmp/fixture',
          outputBudgetBytes: 262144,
        },
      ),
    ).resolves.toEqual({ turns: [], nextCursor: null, truncated: false });
  });

  it('given a create context carrying the required activitySink, createRuntime returns a live handle', async () => {
    const events: RuntimeActivityEvent[] = [];
    const runtime = externalRuntimeProvider.createRuntime(
      createContext((event) => {
        events.push(event);
      }),
    );
    expect(runtime.getStatus()).toBe('declared');
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');
    expect(runtime.getCheckpoint()).toBeNull();
    expect(runtime.wasCheckpointResumed()).toBe(false);
    await expect(runtime.getContext()).resolves.toEqual({
      usedTokens: 12,
      windowTokens: 200_000,
    });
    expect(events).toEqual([]);
  });

  it('given two admissions folded into one native turn, both settle with the same Object.is-identical frozen completion token', async () => {
    const { runtime } = createExternalRuntime();
    await runtime.start();
    const first = expectSubmitted(
      await runtime.completionInput({ text: 'first', sourceId: 'c-1' }),
    );
    const second = expectSubmitted(
      await runtime.channelInput({ text: 'second', sourceId: 'c-2' }),
    );

    expect(second).not.toBe(first);
    expect(runtime.foldedCount()).toBe(2);

    const minted = runtime.completeNativeTurn('folded result');
    const [firstSettlement, secondSettlement] = await Promise.all([
      first.settled,
      second.settled,
    ]);
    const firstCompletion = expectCompletion(firstSettlement);
    const secondCompletion = expectCompletion(secondSettlement);

    expect(Object.is(firstCompletion, secondCompletion)).toBe(true);
    expect(firstCompletion).toBe(minted);
    expect(Object.isFrozen(minted)).toBe(true);
    expect(minted.status).toBe('completed');
    // The FIRST submission of the fold window owns the display position.
    expect(minted.displaySubmission).toBe(first);
    expect(minted.displaySubmission).not.toBe(second);
  });

  it('given two admissions separated by a native turn boundary, each settles with its own distinct completion token', async () => {
    const { runtime } = createExternalRuntime();
    await runtime.start();

    const first = expectSubmitted(
      await runtime.completionInput({ text: 'first', sourceId: 'q-1' }),
    );
    const firstMinted = runtime.completeNativeTurn('first result');
    const second = expectSubmitted(
      await runtime.completionInput({ text: 'second', sourceId: 'q-2' }),
    );
    const secondMinted = runtime.completeNativeTurn('second result');

    const firstCompletion = expectCompletion(await first.settled);
    const secondCompletion = expectCompletion(await second.settled);

    expect(Object.is(firstCompletion, secondCompletion)).toBe(false);
    expect(firstCompletion).toBe(firstMinted);
    expect(secondCompletion).toBe(secondMinted);
    expect(firstCompletion.displaySubmission).toBe(first);
    expect(secondCompletion.displaySubmission).toBe(second);
    expect(
      firstCompletion.status === 'completed' ? firstCompletion.resultText : null,
    ).toBe('first result');
    expect(
      secondCompletion.status === 'completed' ? secondCompletion.resultText : null,
    ).toBe('second result');
  });

  it('given a folded native turn, activity reaches the required sink attributed to the display submission, with the tool start/terminal pair sharing one callId', async () => {
    const { runtime, events } = createExternalRuntime();
    await runtime.start();
    const first = expectSubmitted(
      await runtime.completionInput({ text: 'first', sourceId: 'a-1' }),
    );
    const second = expectSubmitted(
      await runtime.channelInput({ text: 'second', sourceId: 'a-2' }),
    );
    runtime.completeNativeTurn('folded result');

    expect(events.map((event) => event.activity.kind)).toEqual([
      'tool.call',
      'tool.call',
      'assistant.message',
    ]);
    for (const event of events) {
      expect(event.submission).toBe(first);
      expect(event.submission).not.toBe(second);
    }
    const occurredAt = events.map((event) => event.occurredAt);
    expect(occurredAt).toEqual([...occurredAt].sort((a, b) => a - b));

    const [start, terminal] = events.slice(0, 2).map((event) => event.activity);
    if (start.kind !== 'tool.call' || terminal.kind !== 'tool.call') {
      throw new Error('expected the first two activities to be tool calls');
    }
    expect(start.status).toBe('started');
    expect(terminal.status).toBe('completed');
    expect(terminal.callId).toBe(start.callId);
    expect(terminal.id).not.toBe(start.id);
    expect(start.arguments).toEqual({ path: '/tmp/fixture.txt' });
    expect(terminal.result).toEqual({ bytes: 42 });

    const message = events[2].activity;
    if (message.kind !== 'assistant.message') {
      throw new Error('expected the last activity to be an assistant message');
    }
    expect(message.text).toBe('folded result');
    expect(message.truncated).toBe(false);
  });

  it("given a native failure, the folded submissions settle with a 'completion' settlement carrying a failed token and no resultText", async () => {
    const { runtime } = createExternalRuntime();
    await runtime.start();
    const first = expectSubmitted(
      await runtime.completionInput({ text: 'first', sourceId: 'f-1' }),
    );
    const second = expectSubmitted(
      await runtime.completionInput({ text: 'second', sourceId: 'f-2' }),
    );
    const error = new Error('native engine crashed');
    const minted = runtime.failNativeTurn(error);

    const firstCompletion = expectCompletion(await first.settled);
    expect(firstCompletion).toBe(expectCompletion(await second.settled));
    expect(firstCompletion).toBe(minted);
    expect(firstCompletion.status).toBe('failed');
    expect('resultText' in firstCompletion).toBe(false);
    expect(
      firstCompletion.status === 'failed' ? firstCompletion.error : null,
    ).toBe(error);
  });

  it('given stop(), an in-flight submission settles as stopped and later input is refused with a stopped admission', async () => {
    const { runtime } = createExternalRuntime();
    await runtime.start();
    const pending = expectSubmitted(
      await runtime.completionInput({ text: 'in flight', sourceId: 's-1' }),
    );

    await runtime.stop();

    await expect(pending.settled).resolves.toEqual({ kind: 'stopped' });
    expect(runtime.getStatus()).toBe('stopped');
    const afterStop = await runtime.channelInput({
      text: 'too late',
      sourceId: 's-2',
    });
    expect(afterStop).toEqual({ status: 'stopped' });
  });

  it('given a non-admitting input, the admission narrows to a non-submitted status carrying no submission', async () => {
    const { runtime } = createExternalRuntime();
    await runtime.start();
    const admission = await runtime.completionInput({ text: '', sourceId: '' });
    expect(admission.status).toBe('skipped');
    expect('submission' in admission).toBe(false);
  });

  it('given this test file, it imports Dreamux contracts from @excitedjs/dreamux-types only', () => {
    const source = readFileSync(selfFile, 'utf8');
    expect(/from\s+['"]@excitedjs\/dreamux['"]/.test(source)).toBe(false);
    expect(source).toMatch(/from\s+['"]@excitedjs\/dreamux-types['"]/);
  });
});

import {
  extractAssistantText,
  subscribeTurnCollection,
  submitTurnStart,
  type CollectedTurn,
  type TurnCollector,
} from './events.js';
import { compileCodexOutputSchema, type CodexOutputSchemaCodec } from './output-schema-codec.js';
import type { CodexWsClient } from './rpc.js';
import type { ThreadItem } from './types.js';
import {
  DEFAULT_MESSAGE_ID_DEDUPE_WINDOW,
  unsupportedFeatureError,
} from '@excitedjs/dreamux-utils';
import type {
  AgentRuntimeTextInput,
  InboundTurnInput,
  JsonValue,
  RuntimeActivity,
  RuntimeActivitySink,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
  RuntimeToolAction,
} from '@excitedjs/dreamux-types';

interface SubmissionDeferred {
  submission: RuntimeSubmission;
  settle: (settlement: RuntimeSubmissionSettlement) => boolean;
}

interface NativeTurnRecord {
  representative: RuntimeSubmission | null;
  members: SubmissionDeferred[];
  codec: CodexOutputSchemaCodec | null;
  completion: RuntimeCompletion | null;
  terminal: CollectedTurn | Error | null;
  releaseAfterAdmissions: Set<number> | null;
}

export interface TurnManagerOptions {
  dispatcherId: string;
  getThreadId(): string | null;
  client: CodexWsClient;
  turnCwd?: string | null;
  messageIdDedupeWindow?: number;
  activitySink: RuntimeActivitySink;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  onTurnCompleted?: (turn: CollectedTurn) => void;
}

export class TurnManager {
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdOrder: string[] = [];
  private readonly seenTextInputIds = new Set<string>();
  private readonly seenTextInputIdOrder: string[] = [];
  private readonly pendingMessageIds = new Map<string, Promise<RuntimeAdmission>>();
  private readonly pendingTextInputIds = new Map<string, Promise<RuntimeAdmission>>();
  private readonly pendingAdmissions = new Set<Promise<RuntimeAdmission>>();
  private readonly inFlightNativeAdmissions = new Set<number>();
  private nextNativeAdmission = 0;
  private readonly nativeTurns = new Map<string, NativeTurnRecord>();
  private readonly pendingActivity = new Map<string, Array<{ activity: RuntimeActivity; occurredAt: number }>>();
  private readonly unboundObservedTurnIds = new Set<string>();
  private readonly terminalOrder: string[] = [];
  private protocolFailure: Error | null = null;
  private collector: TurnCollector | null = null;
  private collectorThreadId: string | null = null;
  private decisionTail: Promise<void> = Promise.resolve();
  private stopped = false;
  private idlePromise: Promise<void> | null = null;
  private idleResolve: (() => void) | null = null;
  private readonly log: NonNullable<TurnManagerOptions['log']>;
  private readonly messageIdDedupeWindow: number;

  constructor(private readonly opts: TurnManagerOptions) {
    this.log = opts.log ?? ((level, message, error) => {
      const prefix = `[turn-manager ${opts.dispatcherId}] ${level}`;
      if (error === undefined) console.error(prefix, message);
      else console.error(prefix, message, error);
    });
    this.messageIdDedupeWindow = Math.max(0, opts.messageIdDedupeWindow ?? DEFAULT_MESSAGE_ID_DEDUPE_WINDOW);
  }

  isBusy(): boolean {
    return this.pendingAdmissions.size > 0 || [...this.nativeTurns.values()].some((record) => record.completion === null);
  }

  waitIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    this.idlePromise ??= new Promise((resolve) => { this.idleResolve = resolve; });
    return this.idlePromise;
  }

  enqueue(input: InboundTurnInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(this.reserveSource(
      input.sourceId,
      this.seenMessageIds,
      this.seenMessageIdOrder,
      this.pendingMessageIds,
      () => this.enqueueDecision(
        () => this.submit(input.text, null, `message ${input.sourceId || '<none>'}`),
      ),
    ));
  }

  submitTextInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(this.reserveSource(
      input.sourceId,
      this.seenTextInputIds,
      this.seenTextInputIdOrder,
      this.pendingTextInputIds,
      async () => {
        let codec: CodexOutputSchemaCodec | null = null;
        if (input.outputSchema !== undefined) {
          try { codec = compileCodexOutputSchema(input.outputSchema); }
          catch (error) { return { status: 'failed', error: asError(error) }; }
        }
        return this.enqueueDecision(() => this.submit(input.text, codec, 'text input'));
      },
    ));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.collector?.dispose();
    this.collector = null;
    while (this.pendingAdmissions.size > 0) await Promise.allSettled([...this.pendingAdmissions]);
    this.drainTerminalOrder();
    for (const record of this.nativeTurns.values()) {
      if (record.completion !== null) continue;
      for (const member of record.members) member.settle({ kind: 'stopped' });
    }
    for (const [turnId, record] of this.nativeTurns) {
      if (record.completion === null) this.nativeTurns.delete(turnId);
    }
    this.terminalOrder.length = 0;
    this.pendingActivity.clear();
    this.unboundObservedTurnIds.clear();
    this.resolveIdleWaitersIfIdle();
  }

  private async submit(
    text: string,
    codec: CodexOutputSchemaCodec | null,
    description: string,
  ): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
    if (this.protocolFailure !== null) return { status: 'failed', error: this.protocolFailure };
    const threadId = this.opts.getThreadId();
    if (threadId === null) return { status: 'failed', error: new Error('input submitted without thread_id') };
    const deferred = createRuntimeSubmission();
    this.ensureCollector(threadId);
    const incompatible = this.incompatibleCodecError(codec);
    if (incompatible !== null) return { status: 'failed', error: incompatible };
    const admissionId = this.nextNativeAdmission++;
    this.inFlightNativeAdmissions.add(admissionId);
    let response: Awaited<ReturnType<typeof submitTurnStart>>;
    try {
      response = await submitTurnStart(
        this.opts.client,
        threadId,
        text,
        this.opts.turnCwd ?? null,
        codec?.wireSchema,
      );
    } catch (error) {
      const normalized = asError(error);
      this.log('error', `turn/start submission failed for ${description}: ${normalized.message}`, normalized);
      this.inFlightNativeAdmissions.delete(admissionId);
      this.releaseCompletedRecords(admissionId);
      this.dropOrphanActivityIfIdle();
      return { status: 'ambiguous', error: normalized };
    }
    const observed = this.nativeTurns.get(response.turn.id);
    if (this.stopped && (observed === undefined || observed.terminal === null)) {
      deferred.settle({ kind: 'stopped' });
    } else {
      this.bindSubmission(response.turn.id, deferred, codec);
    }
    this.inFlightNativeAdmissions.delete(admissionId);
    this.releaseCompletedRecords(admissionId);
    this.dropOrphanActivityIfIdle();
    return { status: 'submitted', submission: deferred.submission };
  }

  private enqueueDecision<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.decisionTail.then(operation, operation);
    this.decisionTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private incompatibleCodecError(candidate: CodexOutputSchemaCodec | null): Error | null {
    for (const record of this.nativeTurns.values()) {
      if (record.completion !== null || record.terminal !== null) continue;
      if (sameCodec(record.codec, candidate)) continue;
      return unsupportedFeatureError(
        'outputSchema',
        'codex cannot submit an incompatible outputSchema while a native turn is active',
      );
    }
    return null;
  }

  private ensureCollector(threadId: string): void {
    if (this.collector !== null && this.collectorThreadId === threadId) return;
    this.collector?.dispose();
    this.collectorThreadId = threadId;
    this.collector = subscribeTurnCollection(this.opts.client, threadId, {
      retainAfterTerminal: true,
      onItemStarted: (turnId, item) => this.observeItem(turnId, item, 'started', Date.now()),
      onItemCompleted: (turnId, item, occurredAt) => this.observeItem(turnId, item, 'completed', occurredAt),
      onTerminal: (turnId, terminal) => this.observeTerminal(turnId, terminal),
      onUnscopedFailure: (error) => this.failProtocol(error),
      onProtocolViolation: (error) => this.failProtocol(error),
    });
  }

  private bindSubmission(turnId: string, deferred: SubmissionDeferred, codec: CodexOutputSchemaCodec | null): void {
    this.unboundObservedTurnIds.delete(turnId);
    const record = this.nativeTurns.get(turnId) ?? {
      representative: null,
      members: [],
      codec,
      completion: null,
      terminal: null,
      releaseAfterAdmissions: null,
    };
    if (record.representative === null && record.members.length === 0) record.codec = codec;
    record.representative ??= deferred.submission;
    if (record.completion === null) record.members.push(deferred);
    this.nativeTurns.set(turnId, record);
    for (const fact of this.pendingActivity.get(turnId) ?? []) this.emitActivity(record, fact.activity, fact.occurredAt);
    this.pendingActivity.delete(turnId);
    if (this.protocolFailure !== null) {
      this.failRecord(turnId, record, this.protocolFailure);
      return;
    }
    if (record.completion !== null) deferred.settle({ kind: 'completion', completion: record.completion });
    this.drainTerminalOrder();
  }

  private observeTerminal(turnId: string, terminal: CollectedTurn | Error): void {
    this.unboundObservedTurnIds.delete(turnId);
    const record = this.nativeTurns.get(turnId) ?? {
      representative: null, members: [], codec: null, completion: null, terminal: null,
      releaseAfterAdmissions: null,
    };
    if (record.terminal !== null || record.completion !== null) return;
    record.terminal = terminal;
    record.releaseAfterAdmissions = new Set(this.inFlightNativeAdmissions);
    this.nativeTurns.set(turnId, record);
    this.terminalOrder.push(turnId);
    this.drainTerminalOrder();
  }

  private drainTerminalOrder(): void {
    while (this.terminalOrder.length > 0) {
      const turnId = this.terminalOrder[0]!;
      const record = this.nativeTurns.get(turnId);
      if (record === undefined || record.terminal === null) return;
      if (record.representative === null) {
        if (this.pendingAdmissions.size > 0) return;
        this.terminalOrder.shift();
        this.nativeTurns.delete(turnId);
        this.pendingActivity.delete(turnId);
        this.unboundObservedTurnIds.delete(turnId);
        this.collector?.releaseTurn(turnId);
        this.log('warn', `dropping native terminal ${turnId} without an accepted submission`);
        continue;
      }
      this.terminalOrder.shift();
      this.finalize(turnId, record, record.terminal);
    }
  }

  private finalize(turnId: string, record: NativeTurnRecord, terminal: CollectedTurn | Error): void {
    if (record.completion !== null) return;
    if (record.representative === null) return;
    let completion: RuntimeCompletion;
    if (terminal instanceof Error) {
      completion = Object.freeze({ status: 'failed', displaySubmission: record.representative, error: terminal });
    } else {
      let completedTurn = terminal;
      try { if (record.codec !== null) completedTurn = restoreCollectedTurn(terminal, record.codec); }
      catch (error) {
        completion = Object.freeze({ status: 'failed', displaySubmission: record.representative, error: asError(error) });
        record.completion = completion;
        for (const member of record.members) member.settle({ kind: 'completion', completion });
        record.members.length = 0;
        record.terminal = null;
        this.releaseRecordIfReady(turnId, record);
        this.resolveIdleWaitersIfIdle();
        return;
      }
      this.opts.onTurnCompleted?.(completedTurn);
      completion = Object.freeze({
        status: 'completed',
        displaySubmission: record.representative,
        resultText: extractAssistantText(completedTurn),
        truncated: false,
      });
    }
    record.completion = completion;
    for (const member of record.members) member.settle({ kind: 'completion', completion });
    record.members.length = 0;
    record.terminal = null;
    this.releaseRecordIfReady(turnId, record);
    this.resolveIdleWaitersIfIdle();
  }

  private failProtocol(error: Error): void {
    this.protocolFailure ??= error;
    this.log('error', error.message, error);
    this.terminalOrder.length = 0;
    for (const [turnId, record] of this.nativeTurns) {
      if (record.completion !== null) continue;
      this.failRecord(turnId, record, this.protocolFailure);
    }
    this.resolveIdleWaitersIfIdle();
  }

  private failRecord(turnId: string, record: NativeTurnRecord, error: Error): void {
    for (const member of record.members) member.settle({ kind: 'failed', error });
    record.members.length = 0;
    this.nativeTurns.delete(turnId);
    this.pendingActivity.delete(turnId);
    this.unboundObservedTurnIds.delete(turnId);
    this.collector?.releaseTurn(turnId);
  }

  private releaseCompletedRecords(admissionId: number): void {
    for (const [turnId, record] of this.nativeTurns) {
      record.releaseAfterAdmissions?.delete(admissionId);
      this.releaseRecordIfReady(turnId, record);
    }
  }

  private releaseRecordIfReady(turnId: string, record: NativeTurnRecord): void {
    if (record.completion === null || (record.releaseAfterAdmissions?.size ?? 0) > 0) return;
    this.nativeTurns.delete(turnId);
    this.pendingActivity.delete(turnId);
    this.unboundObservedTurnIds.delete(turnId);
    this.collector?.releaseTurn(turnId);
  }

  private dropOrphanActivityIfIdle(): void {
    if (this.inFlightNativeAdmissions.size !== 0) return;
    for (const turnId of this.unboundObservedTurnIds) {
      if (this.nativeTurns.has(turnId)) continue;
      this.pendingActivity.delete(turnId);
      this.collector?.releaseTurn(turnId);
    }
    this.unboundObservedTurnIds.clear();
  }

  private observeItem(turnId: string, item: ThreadItem, phase: 'started' | 'completed', occurredAt: number): void {
    const record = this.nativeTurns.get(turnId);
    if (record === undefined || record.representative === null) {
      this.unboundObservedTurnIds.add(turnId);
      if (this.inFlightNativeAdmissions.size === 0) {
        this.dropOrphanActivityIfIdle();
        return;
      }
      const activity = itemActivity(turnId, item, phase);
      if (activity === null) return;
      const pending = this.pendingActivity.get(turnId) ?? [];
      pending.push({ activity, occurredAt });
      this.pendingActivity.set(turnId, pending);
      return;
    }
    const activity = itemActivity(turnId, item, phase);
    if (activity === null) return;
    this.emitActivity(record, activity, occurredAt);
  }

  private emitActivity(record: NativeTurnRecord, activity: RuntimeActivity, occurredAt: number): void {
    if (record.representative === null) return;
    try {
      this.opts.activitySink(Object.freeze({ submission: record.representative, activity: Object.freeze(activity), occurredAt }));
    } catch (error) {
      this.log('warn', 'codex activity projection failed', error);
    }
  }

  private reserveSource(
    sourceId: string | undefined,
    committed: Set<string>,
    order: string[],
    pending: Map<string, Promise<RuntimeAdmission>>,
    operation: () => Promise<RuntimeAdmission>,
  ): Promise<RuntimeAdmission> {
    if (sourceId === undefined || sourceId === '') return operation();
    if (committed.has(sourceId)) return Promise.resolve({ status: 'duplicate' });
    const existing = pending.get(sourceId);
    if (existing !== undefined) return existing;
    const task = Promise.resolve().then(operation).catch((error: unknown): RuntimeAdmission => ({ status: 'ambiguous', error: asError(error) }));
    pending.set(sourceId, task);
    void task.then((admission) => {
      if (admission.status === 'submitted' || admission.status === 'ambiguous') {
        committed.add(sourceId);
        order.push(sourceId);
        while (order.length > this.messageIdDedupeWindow) {
          const evicted = order.shift();
          if (evicted !== undefined) committed.delete(evicted);
        }
      }
      if (pending.get(sourceId) === task) pending.delete(sourceId);
    });
    return task;
  }

  private trackAdmission(admission: Promise<RuntimeAdmission>): Promise<RuntimeAdmission> {
    this.pendingAdmissions.add(admission);
    void admission.finally(() => {
      this.pendingAdmissions.delete(admission);
      this.drainTerminalOrder();
      this.resolveIdleWaitersIfIdle();
    }).catch(() => undefined);
    return admission;
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.isBusy()) return;
    const resolve = this.idleResolve;
    this.idlePromise = null;
    this.idleResolve = null;
    resolve?.();
  }
}

function sameCodec(left: CodexOutputSchemaCodec | null, right: CodexOutputSchemaCodec | null): boolean {
  return left === null ? right === null : right !== null && left.fingerprint === right.fingerprint;
}

function createRuntimeSubmission(): SubmissionDeferred {
  let resolve!: (settlement: RuntimeSubmissionSettlement) => void;
  let settled = false;
  const submission = Object.freeze({ settled: new Promise<RuntimeSubmissionSettlement>((value) => { resolve = value; }) });
  return { submission, settle(settlement) { if (settled) return false; settled = true; resolve(settlement); return true; } };
}

function itemActivity(turnId: string, item: ThreadItem, phase: 'started' | 'completed'): RuntimeActivity | null {
  const itemId = typeof item.id === 'string' && item.id !== '' ? item.id : null;
  if (itemId === null) return null;
  if (item.type === 'agentMessage') {
    if (phase !== 'completed' || typeof item.text !== 'string' || item.text === '') return null;
    return { kind: 'assistant.message', id: `${turnId}:${itemId}:completed`, text: item.text, truncated: false };
  }
  const toolName = toolNameFor(item);
  if (toolName === null) return null;
  const failed = phase === 'completed' &&
    (item['status'] === 'failed' || item['error'] != null || item['success'] === false);
  const error = failed ? renderProviderError(item['error']) : null;
  return {
    kind: 'tool.call',
    id: `${turnId}:${itemId}:${phase}`,
    callId: itemId,
    toolName,
    action: toolActionFor(item),
    status: phase === 'started' ? 'started' : failed ? 'failed' : 'completed',
    arguments: toJsonValue(item['arguments'] ?? item['input'] ?? item['command'] ?? item['changes'] ?? null),
    result: phase === 'completed' ? resultFor(item) : null,
    error,
  };
}

function toolActionFor(item: ThreadItem): RuntimeToolAction | null {
  if (item.type === 'commandExecution') return commandActionFor(item['commandActions']);
  if (item.type === 'fileChange') return 'edit';
  return null;
}

function commandActionFor(value: unknown): RuntimeToolAction {
  if (!Array.isArray(value) || value.length === 0) return 'run';
  const actions = value.map((entry): RuntimeToolAction | null => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    switch ((entry as Record<string, unknown>)['type']) {
      case 'read': return 'read';
      case 'listFiles': return 'list_files';
      case 'search': return 'search';
      case 'unknown': return 'run';
      default: return null;
    }
  });
  const first = actions[0];
  return first !== null && actions.every((action) => action === first) ? first : 'run';
}

function resultFor(item: ThreadItem): JsonValue | null {
  const result = item['result'] ?? item['output'] ?? item['aggregatedOutput'];
  if (result !== undefined) return toJsonValue(result);
  if (item.type === 'dynamicToolCall') return normalizeInputTextItems(item['contentItems']);
  return null;
}

function normalizeInputTextItems(value: unknown): JsonValue | null {
  if (!Array.isArray(value)) return toJsonValue(value);
  if (value.length === 0) return null;
  const texts = value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    return record['type'] === 'inputText' && typeof record['text'] === 'string'
      ? record['text']
      : null;
  });
  return texts.every((text): text is string => text !== null)
    ? texts.join('\n')
    : toJsonValue(value);
}

function renderProviderError(value: unknown): string | null {
  if (value == null) return null;
  const normalized = normalizeInputTextItems(value);
  if (normalized === null) return null;
  return typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
}

function toolNameFor(item: ThreadItem): string | null {
  if (item.type === 'commandExecution') return 'exec_command';
  if (item.type === 'fileChange') return 'apply_patch';
  if (item.type === 'mcpToolCall') {
    const server = typeof item['server'] === 'string' ? item['server'] : null;
    const tool = typeof item['tool'] === 'string' ? item['tool'] : null;
    return server !== null && tool !== null ? `${server}.${tool}` : null;
  }
  if (typeof item['name'] === 'string') return item['name'];
  if (typeof item['tool'] === 'string') return item['tool'];
  return null;
}

function toJsonValue(value: unknown): JsonValue | null {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)) as JsonValue; } catch { return String(value); }
}

function restoreCollectedTurn(turn: CollectedTurn, codec: CodexOutputSchemaCodec): CollectedTurn {
  const text = extractAssistantText(turn);
  if (text === null) throw new Error('codex outputSchema restoration failed: completed turn has no assistant JSON text');
  const restoredText = codec.restore(text);
  let replaced = false;
  const items = [...turn.items].reverse().map((item) => {
    if (replaced || item.type !== 'agentMessage' || item.text !== text) return item;
    replaced = true;
    return { ...item, text: restoredText };
  }).reverse();
  if (!replaced) throw new Error('codex outputSchema restoration failed: assistant JSON text was not found');
  return { ...turn, items };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

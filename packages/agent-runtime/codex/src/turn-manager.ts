import {
  extractAssistantText,
  interruptTurn,
  subscribeTurnCollection,
  submitTurnStart,
  type CollectedTurn,
  type TurnCollector,
} from './events.js';
import type { CodexOutputSchemaCodec } from './output-schema-codec.js';
import type { CodexWsClient } from './rpc.js';
import { toolDisplay } from './tool-display.js';
import type { ThreadItem, ThreadTokenUsage } from './types.js';
import type {
  AgentRuntimeActivitySink,
  AgentRuntimeInterruptOutcome,
  AgentRuntimeSubmissionInput,
  JsonValue,
  RuntimeActivity,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

interface SubmissionDeferred {
  submission: RuntimeSubmission;
  settle: (settlement: RuntimeSubmissionSettlement) => boolean;
}

interface NativeTurnRecord {
  representative: RuntimeSubmission | null;
  members: SubmissionDeferred[];
  completion: RuntimeCompletion | null;
  terminal: CollectedTurn | Error | null;
  releaseAfterAdmissions: Set<number> | null;
}

export interface TurnManagerOptions {
  dispatcherId: string;
  getThreadId(): string | null;
  client: CodexWsClient;
  turnCwd?: string | null;
  /**
   * The session-bound output schema codec, compiled once when the runtime was
   * created. It is fixed for the life of the session: no submission can change
   * or negotiate it.
   */
  codec: CodexOutputSchemaCodec | null;
  activitySink: AgentRuntimeActivitySink;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  onTurnCompleted?: (turn: CollectedTurn) => void;
}

export class TurnManager {
  private readonly pendingAdmissions = new Set<Promise<RuntimeAdmission>>();
  private readonly inFlightNativeAdmissions = new Set<number>();
  private nextNativeAdmission = 0;
  private readonly nativeTurns = new Map<string, NativeTurnRecord>();
  private readonly unboundObservedTurnIds = new Set<string>();
  private readonly terminalOrder: string[] = [];
  private protocolFailure: Error | null = null;
  private collector: TurnCollector | null = null;
  private collectorThreadId: string | null = null;
  private tokenUsage: ThreadTokenUsage | null = null;
  private decisionTail: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly log: NonNullable<TurnManagerOptions['log']>;

  constructor(private readonly opts: TurnManagerOptions) {
    this.log = opts.log ?? ((level, message, error) => {
      const prefix = `[turn-manager ${opts.dispatcherId}] ${level}`;
      if (error === undefined) console.error(prefix, message);
      else console.error(prefix, message, error);
    });
  }

  /**
   * Admit one already-rendered submission. The manager holds no source ledger:
   * deduplication is Core's, ahead of this call.
   */
  submitInput(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(
      this.enqueueDecision(() => this.submit(input.text, 'submission')),
    );
  }

  interrupt(): Promise<AgentRuntimeInterruptOutcome> {
    return this.enqueueDecision(async () => {
      if (this.stopped) return { status: 'idle' };
      const active = [...this.nativeTurns].reverse().find(
        ([, record]) => record.terminal === null && record.completion === null,
      );
      const threadId = this.opts.getThreadId();
      if (active === undefined || threadId === null) return { status: 'idle' };
      await interruptTurn(this.opts.client, threadId, active[0]);
      return { status: 'interrupted' };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.collector?.dispose();
    this.collector = null;
    while (this.pendingAdmissions.size > 0) await Promise.allSettled([...this.pendingAdmissions]);
    // The collector is gone, so nothing will ever report a turn codex started
    // and never finished: this teardown reports one interrupted end, without
    // asking whether a turn was open. The manager keeps no such answer; a
    // consumer with nothing open ignores the end.
    this.endNativeTurn('interrupted', null);
    this.drainTerminalOrder();
    for (const record of this.nativeTurns.values()) {
      if (record.completion !== null) continue;
      for (const member of record.members) member.settle({ kind: 'stopped' });
    }
    for (const [turnId, record] of this.nativeTurns) {
      if (record.completion === null) this.nativeTurns.delete(turnId);
    }
    this.terminalOrder.length = 0;
    this.unboundObservedTurnIds.clear();
  }

  private async submit(
    text: string,
    description: string,
  ): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
    if (this.protocolFailure !== null) return { status: 'failed', error: this.protocolFailure };
    const threadId = this.opts.getThreadId();
    if (threadId === null) return { status: 'failed', error: new Error('input submitted without thread_id') };
    const deferred = createRuntimeSubmission();
    this.ensureCollector(threadId);
    const admissionId = this.nextNativeAdmission++;
    this.inFlightNativeAdmissions.add(admissionId);
    let response: Awaited<ReturnType<typeof submitTurnStart>>;
    try {
      response = await submitTurnStart(
        this.opts.client,
        threadId,
        text,
        this.opts.turnCwd ?? null,
        this.opts.codec?.wireSchema,
      );
    } catch (error) {
      const normalized = asError(error);
      this.log('error', `turn/start submission failed for ${description}: ${normalized.message}`, normalized);
      this.inFlightNativeAdmissions.delete(admissionId);
      this.releaseCompletedRecords(admissionId);
      this.releaseOrphanTurnsIfIdle();
      return { status: 'ambiguous', error: normalized };
    }
    const observed = this.nativeTurns.get(response.turn.id);
    if (this.stopped && (observed === undefined || observed.terminal === null)) {
      deferred.settle({ kind: 'stopped' });
    } else {
      this.bindSubmission(response.turn.id, deferred);
    }
    this.inFlightNativeAdmissions.delete(admissionId);
    this.releaseCompletedRecords(admissionId);
    this.releaseOrphanTurnsIfIdle();
    return { status: 'submitted', submission: deferred.submission };
  }

  private enqueueDecision<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.decisionTail.then(operation, operation);
    this.decisionTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private ensureCollector(threadId: string): void {
    if (this.collector !== null && this.collectorThreadId === threadId) return;
    this.collector?.dispose();
    this.collectorThreadId = threadId;
    this.tokenUsage = null;
    this.collector = subscribeTurnCollection(this.opts.client, threadId, {
      retainAfterTerminal: true,
      onTokenUsage: (usage) => { this.tokenUsage = usage ?? null; },
      onItemStarted: (turnId, item) => this.observeItem(turnId, item, 'started', Date.now()),
      onItemCompleted: (turnId, item, occurredAt) => this.observeItem(turnId, item, 'completed', occurredAt),
      onTerminal: (turnId, terminal) => this.observeTerminal(turnId, terminal),
      onUnscopedFailure: (error) => this.failProtocol(error),
      onProtocolViolation: (error) => this.failProtocol(error),
    });
  }

  private bindSubmission(turnId: string, deferred: SubmissionDeferred): void {
    this.unboundObservedTurnIds.delete(turnId);
    const record = this.nativeTurns.get(turnId) ?? {
      representative: null,
      members: [],
      completion: null,
      terminal: null,
      releaseAfterAdmissions: null,
    };
    record.representative ??= deferred.submission;
    if (record.completion === null) record.members.push(deferred);
    this.nativeTurns.set(turnId, record);
    if (this.protocolFailure !== null) {
      this.failRecord(turnId, record, this.protocolFailure);
      return;
    }
    if (record.completion !== null) deferred.settle({ kind: 'completion', completion: record.completion });
    this.drainTerminalOrder();
  }

  private observeTerminal(turnId: string, terminal: CollectedTurn | Error): void {
    // An accepted interrupt is not a terminal of its own: codex answers it with
    // an ordinary `turn/completed` whose only mark is `status: "interrupted"`
    // (measured against codex-cli 0.153.4; see `TurnStatus`). Both the marker
    // and the end below read that status, so an interrupted codex turn carries
    // the same line and the same end an interrupted Claude Code turn does.
    const interrupted =
      !(terminal instanceof Error) && terminal.status === 'interrupted';
    if (interrupted) this.emitActivity(interruptedActivity(turnId));
    const summary = usageSummary(this.tokenUsage);
    if (summary !== null) {
      this.emitActivity({
        kind: 'assistant.message',
        occurredAt: Date.now(),
        id: `${turnId}:usage`,
        text: summary,
      });
    }
    // The display line ends here, on codex's own terminal. The collector
    // reports each turn's terminal once, so this is the one end the turn gets
    // from its stream: nothing below it — the record's own bookkeeping, the
    // terminal queue, the admissions gate, the completion the push-back line
    // builds out of this terminal — may change it, delay it, or withhold it.
    this.endNativeTurn(
      terminal instanceof Error
        ? 'failed'
        : interrupted
          ? 'interrupted'
          : 'completed',
      terminal instanceof Error ? terminal.message : null,
    );
    this.unboundObservedTurnIds.delete(turnId);
    const record = this.nativeTurns.get(turnId) ?? {
      representative: null, members: [], completion: null, terminal: null,
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
        // Nothing to settle and no completion to describe, so this queue head
        // is only released. Its end went out when codex reported the terminal.
        this.terminalOrder.shift();
        this.nativeTurns.delete(turnId);
        this.unboundObservedTurnIds.delete(turnId);
        this.collector?.releaseTurn(turnId);
        continue;
      }
      this.terminalOrder.shift();
      this.finalize(turnId, record, record.terminal);
    }
  }

  private finalize(turnId: string, record: NativeTurnRecord, terminal: CollectedTurn | Error): void {
    if (record.completion !== null) return;
    // Push-back only, and it decides nothing the card shows: an unbound turn
    // has no submission to settle, so `drainTerminalOrder` releases it instead
    // of routing it here.
    if (record.representative === null) return;
    let completion: RuntimeCompletion;
    if (terminal instanceof Error) {
      completion = Object.freeze({ status: 'failed', error: terminal });
    } else {
      const codec = this.opts.codec;
      let completedTurn = terminal;
      try { if (codec !== null) completedTurn = restoreCollectedTurn(terminal, codec); }
      catch (error) {
        completion = Object.freeze({ status: 'failed', error: asError(error) });
        record.completion = completion;
        for (const member of record.members) member.settle({ kind: 'completion', completion });
        record.members.length = 0;
        record.terminal = null;
        this.releaseRecordIfReady(turnId, record);
        return;
      }
      this.opts.onTurnCompleted?.(completedTurn);
      completion = Object.freeze({
        status: 'completed',
        resultText: extractAssistantText(completedTurn),
      });
    }
    record.completion = completion;
    for (const member of record.members) member.settle({ kind: 'completion', completion });
    record.members.length = 0;
    record.terminal = null;
    this.releaseRecordIfReady(turnId, record);
  }

  private failProtocol(error: Error): void {
    const first = this.protocolFailure === null;
    this.protocolFailure ??= error;
    this.log('error', error.message, error);
    // Whatever codex had running dies with the connection, including a turn
    // this manager only ever saw items for, which has no record for the loop
    // below to reach. The first failure reports that end; later ones repeat
    // the same dead connection.
    if (first) this.endNativeTurn('failed', this.protocolFailure.message);
    this.terminalOrder.length = 0;
    for (const [turnId, record] of this.nativeTurns) {
      if (record.completion !== null) continue;
      this.failRecord(turnId, record, this.protocolFailure);
    }
  }

  private failRecord(turnId: string, record: NativeTurnRecord, error: Error): void {
    for (const member of record.members) member.settle({ kind: 'failed', error });
    record.members.length = 0;
    this.nativeTurns.delete(turnId);
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
    this.unboundObservedTurnIds.delete(turnId);
    this.collector?.releaseTurn(turnId);
  }

  /** Let the collector forget a native turn no Dreamux submission ever bound. */
  private releaseOrphanTurnsIfIdle(): void {
    if (this.inFlightNativeAdmissions.size !== 0) return;
    for (const turnId of this.unboundObservedTurnIds) {
      if (this.nativeTurns.has(turnId)) continue;
      this.collector?.releaseTurn(turnId);
    }
    this.unboundObservedTurnIds.clear();
  }

  /**
   * Put what codex reported on this agent's activity stream.
   *
   * No record is consulted. A native turn folds any number of Dreamux
   * submissions, so naming one of them as the item's owner was always a guess
   * — and the buffer that existed to make that guess possible dropped
   * everything it could not eventually attribute. The agent is the subject,
   * and it is known before any submission binds.
   */
  private observeItem(turnId: string, item: ThreadItem, phase: 'started' | 'completed', occurredAt: number): void {
    const activity = itemActivity(turnId, item, phase, occurredAt);
    if (activity !== null) this.emitActivity(activity);
    const record = this.nativeTurns.get(turnId);
    if (record !== undefined && record.representative !== null) return;
    this.unboundObservedTurnIds.add(turnId);
    if (this.inFlightNativeAdmissions.size === 0) this.releaseOrphanTurnsIfIdle();
  }

  /** The sink is Core's and never throws (`AgentRuntimeActivitySink`). */
  private emitActivity(activity: RuntimeActivity): void {
    this.opts.activitySink(Object.freeze(activity));
  }

  /**
   * Report a native turn's end on the display line.
   *
   * `status` and `reason` are codex's own terminal and nothing else — a
   * collected turn completed, an error failed with its message, a teardown
   * interrupted. What the push-back line then makes of that terminal (a decode
   * it cannot restore, a submission it cannot attribute) is push-back's own
   * outcome and never colours the card.
   *
   * This manager keeps no display state: it does not know, and does not ask,
   * whether a turn is open before reporting an end. Whether the end is *shown*
   * is not this layer's decision. A card belongs to no turn
   * (`feishu-cot-conversation-cards` requirement, rule 1 — a target is "not a
   * presentation identity, state key, or card partition"), and a native end
   * "closes an existing open card but never opens a new one; when no card is
   * open, Feishu ignores it" (rule 8). This layer pushes; the Channel decides.
   */
  private endNativeTurn(
    status: 'completed' | 'failed' | 'interrupted',
    reason: string | null,
  ): void {
    this.emitActivity({ kind: 'turn.ended', occurredAt: Date.now(), status, reason });
  }

  private trackAdmission(admission: Promise<RuntimeAdmission>): Promise<RuntimeAdmission> {
    this.pendingAdmissions.add(admission);
    void admission.finally(() => {
      this.pendingAdmissions.delete(admission);
      this.drainTerminalOrder();
    }).catch(() => undefined);
    return admission;
  }
}

function createRuntimeSubmission(): SubmissionDeferred {
  let resolve!: (settlement: RuntimeSubmissionSettlement) => void;
  let settled = false;
  const submission = Object.freeze({ settled: new Promise<RuntimeSubmissionSettlement>((value) => { resolve = value; }) });
  return { submission, settle(settlement) { if (settled) return false; settled = true; resolve(settlement); return true; } };
}

// Compaction summaries stay inside codex-core; display only that compaction happened.
const COMPACTED_SESSION_MESSAGE = 'COMPACTED SESSION';

/**
 * The one line the card shows for an interrupted turn, in the words Claude
 * Code's own UI uses for the same fact. codex reports an interrupt only as a
 * terminal status on `turn/completed`, and a status is not a card fact, so
 * without this push the card shows an ordinary end and nothing says the turn
 * was stopped rather than answered. codex carries an interrupt marker too,
 * aligned with Claude Code, in the `COMPACTED SESSION` shape: an assistant
 * message from the provider, not a new activity kind.
 *
 * The end matches the marker: a stopped codex turn must read as interrupted
 * on the card, exactly as Claude Code's does. A card's terminal is
 * `turn.ended.status` verbatim: the Feishu channel maps `completed` to
 * `RUN_FINISHED status: done` and `interrupted` to `status: interrupted`, so
 * the end has to read the same status the marker does.
 */
const INTERRUPTED_MESSAGE = '[Request interrupted by user]';

function interruptedActivity(turnId: string): RuntimeActivity {
  return {
    kind: 'assistant.message',
    occurredAt: Date.now(),
    id: `${turnId}:interrupted`,
    text: INTERRUPTED_MESSAGE,
  };
}

function itemActivity(
  turnId: string,
  item: ThreadItem,
  phase: 'started' | 'completed',
  occurredAt: number,
): RuntimeActivity | null {
  const itemId = typeof item.id === 'string' && item.id !== '' ? item.id : null;
  if (itemId === null) return null;
  if (item.type === 'agentMessage') {
    if (phase !== 'completed' || typeof item.text !== 'string' || item.text === '') return null;
    return {
      kind: 'assistant.message',
      occurredAt,
      id: `${turnId}:${itemId}:completed`,
      text: item.text,
    };
  }
  if (item.type === 'contextCompaction') {
    if (phase !== 'completed') return null;
    return {
      kind: 'assistant.message',
      occurredAt,
      id: `${turnId}:${itemId}:completed`,
      text: COMPACTED_SESSION_MESSAGE,
    };
  }
  const toolName = toolNameFor(item);
  if (toolName === null) return null;
  const failed = phase === 'completed' &&
    (item['status'] === 'failed' || item['error'] != null || item['success'] === false);
  const error = failed ? renderProviderError(item['error']) : null;
  return {
    kind: 'tool.call',
    occurredAt,
    id: `${turnId}:${itemId}:${phase}`,
    callId: itemId,
    toolName,
    ...toolDisplay(item),
    status: phase === 'started' ? 'started' : failed ? 'failed' : 'completed',
    arguments: toJsonValue(item['arguments'] ?? item['input'] ?? item['command'] ?? item['changes'] ?? null),
    result: phase === 'completed' ? resultFor(item) : null,
    error,
  };
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
  if (item.type === 'webSearch') return 'web_search';
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

function usageSummary(usage: ThreadTokenUsage | null): string | null {
  const input = usage?.total?.inputTokens;
  const output = usage?.total?.outputTokens;
  if (!isTokenCount(input) || !isTokenCount(output)) return null;
  const context = usage?.last?.totalTokens;
  const window = usage?.modelContextWindow;
  const contextUsage = isTokenCount(context) && isTokenCount(window) && window > 0
    ? `${Math.round(context / window * 100)}%`
    : 'n/a';
  return `Context usage ${contextUsage} | Token usage: total=${formatTokenCount(input + output)} input=${formatTokenCount(input)} output=${formatTokenCount(output)}`;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  const units = ['k', 'm', 'b'];
  let value = count / 1_000;
  let unit = 0;
  while (Math.round(value * 10) / 10 >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit++;
  }
  return `${Math.round(value * 10) / 10}${units[unit]}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

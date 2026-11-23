import type {
  AgentRuntimeEventSink,
  RuntimeCompletion,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

import type { NativeRecord } from '../transcript/records.js';
import type { TurnMember } from './input.js';
import type { TmuxViewport } from './viewport.js';

interface WakingCommand {
  nextStep: number | undefined;
  done: boolean;
}

interface NativeTurn {
  members: TurnMember[];
  candidate?: RuntimeCompletion;
  interrupted?: string | null;
  commands: Map<string, WakingCommand>;
  subagents: Set<string>;
}

const QUIET_MS = 750;

export type NativeTurnEnd =
  | { status: 'completed' | 'failed' }
  | { status: 'interrupted'; hasIdentity: boolean };

/** Membership is established only as an actual native USER_INPUT is folded. */
export class TmuxTerminal {
  private turn: NativeTurn | undefined;
  private quietSince = 0;
  private lastInterrupted = false;

  constructor(
    private readonly events: AgentRuntimeEventSink,
    private readonly ended: (turn: object, end: NativeTurnEnd) => void,
  ) {}

  get active(): NativeTurn | undefined {
    return this.turn;
  }

  observe(record: NativeRecord, member?: TurnMember): void {
    const { type, status, content, stepIndex, id } = record;
    if (type === 'CHECKPOINT' || type === 'TASK_NOTIFICATION') return;
    const previousReady = this.quietSince !== 0;
    this.quietSince = 0;
    if (type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') {
      // A subsequent native input after a complete final establishes the turn
      // boundary even when native auto-flush skips the idle viewport.
      if (
        this.turn?.candidate &&
        (this.turn.candidate.status === 'completed' || previousReady) &&
        this.turn.commands.size === 0 &&
        this.turn.subagents.size === 0
      ) {
        this.complete(this.turn, this.turn.candidate);
      }
      const turn = this.ensureTurn();
      if (member) turn.members.push(member);
      delete turn.candidate;
      return;
    }
    if (type === 'PLANNER_RESPONSE') {
      const turn = this.ensureTurn();
      delete turn.candidate;
      if (
        status === 'DONE' &&
        record.toolCalls.length === 0 &&
        content?.trim()
      ) {
        turn.candidate = { status: 'completed', resultText: content };
      }
      return;
    }
    if (type === 'ERROR' || type === 'ERROR_MESSAGE') {
      if (status === 'RUNNING') return;
      this.ensureTurn().candidate = {
        status: 'failed',
        error: new Error(content ?? 'Antigravity reported a native turn error'),
      };
      return;
    }
    if (type === 'GENERIC' && this.turn) {
      const text = content ?? '';
      const task =
        /running as a background task with task id:? ([\w./-]+)/i.exec(
          text,
        )?.[1];
      if (status === 'RUNNING' && task) {
        this.turn.commands.set(task, {
          nextStep: stepIndex === undefined ? undefined : stepIndex + 1,
          done: false,
        });
      }
      if (status === 'DONE') {
        const created =
          /^(?:(?:Created|Completed) At: [^\n]+\n)*Created the following subagent:\s*\{\s*"conversationId"\s*:\s*"([^"]+)"/.exec(
            text,
          )?.[1];
        if (created) this.turn.subagents.add(created);
        else
          for (const command of this.turn.commands.values()) {
            if (stepIndex !== undefined && command.nextStep === stepIndex)
              command.done = true;
          }
      }
      return;
    }
    if (type === 'SYSTEM_MESSAGE' && content) this.wake(content);
    if (this.turn && type === 'TURN_INTERRUPTED') {
      this.turn.interrupted = id ?? null;
    }
  }

  viewport(viewport: TmuxViewport): void {
    const newlyInterrupted = !this.lastInterrupted && viewport.interrupted;
    this.lastInterrupted = viewport.interrupted;
    const turn = this.turn;
    if (!turn) return;
    const candidate = turn.candidate;
    if (newlyInterrupted || turn.interrupted !== undefined) {
      if (candidate?.status === 'completed' && !hasWakingWork(turn)) {
        this.complete(turn, candidate);
      } else {
        // A native viewport can prove the stop without supplying an identity.
        this.finishInterrupted(turn, turn.interrupted ?? null);
      }
      return;
    }
    const ready =
      candidate?.status === 'failed' ? viewport.nativeError : viewport.ready;
    if (!ready || viewport.busy) {
      this.quietSince = 0;
      return;
    }
    const now = Date.now();
    this.quietSince ||= now;
    if (
      candidate &&
      !hasWakingWork(turn) &&
      now - this.quietSince >= QUIET_MS
    ) {
      this.complete(turn, candidate);
    }
  }

  teardown(error?: Error): void {
    const turn = this.turn;
    this.turn = undefined;
    this.events({
      kind: 'turn.ended',
      occurredAt: Date.now(),
      status: 'interrupted',
      reason: error?.message ?? null,
    });
    if (turn) {
      this.settle(
        turn,
        error ? { kind: 'failed', error } : { kind: 'stopped' },
      );
    }
  }

  private ensureTurn(): NativeTurn {
    return (this.turn ??= {
      members: [],
      commands: new Map(),
      subagents: new Set(),
    });
  }

  private wake(content: string): void {
    const payload =
      /(?:^|\n)<SYSTEM_MESSAGE>\r?\n([\s\S]*?)\r?\n<\/SYSTEM_MESSAGE>/.exec(
        content,
      )?.[1] ?? content;
    const header = /^\[Message\] ([^\n]*)/.exec(payload)?.[1];
    const sender = /(?:^|\s)sender=([\w./-]+)(?:\s|$)/.exec(header ?? '')?.[1];
    const task =
      (sender && /(?:^|\/)task-[\w.-]+$/.test(sender) ? sender : undefined) ??
      /^(?:\[Message\] )?Task(?: id)? "?([\w./-]+)"? (?:finished|completed|was cancel(?:l)?ed|failed|timed out)\b/i.exec(
        payload,
      )?.[1];
    const turn = this.turn;
    if (turn && (header || task)) {
      if (task) turn.commands.delete(task);
      // A subagent can send either its result or a request for guidance.
      // A notification alone proves a wakeup, but lacks a terminal signal.
      delete turn.candidate;
    }
  }

  private complete(turn: NativeTurn, completion: RuntimeCompletion): void {
    this.turn = undefined;
    const result = Object.freeze(completion);
    this.events({ kind: 'turn.result', completion: result });
    this.events({
      kind: 'turn.ended',
      occurredAt: Date.now(),
      status: result.status,
      reason: result.status === 'failed' ? result.error.message : null,
    });
    this.settle(turn, { kind: 'completion', completion: result });
    this.ended(turn, { status: completion.status });
  }

  private finishInterrupted(turn: NativeTurn, id: string | null): void {
    this.turn = undefined;
    const occurredAt = Date.now();
    if (id) this.events({ kind: 'turn.interrupted', id, occurredAt });
    this.events({
      kind: 'turn.ended',
      occurredAt,
      status: 'interrupted',
      reason: null,
    });
    this.settle(turn, { kind: 'stopped' });
    this.ended(turn, { status: 'interrupted', hasIdentity: id !== null });
  }

  private settle(
    turn: NativeTurn,
    settlement: RuntimeSubmissionSettlement,
  ): void {
    for (const member of turn.members) member(settlement);
  }
}

function hasWakingWork(turn: NativeTurn): boolean {
  return (
    turn.subagents.size > 0 ||
    [...turn.commands.values()].some((command) => !command.done)
  );
}
